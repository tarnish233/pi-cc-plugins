/**
 * Prompt keys: Enter queues while Pi is working; the slash menu keeps Enter
 * for itself. The Ctrl+Enter send-now shortcut is intentionally not provided.
 *
 * Pi's default is enter steers (sent into the run) and alt+enter queues.
 * `app.message.followUp` queues while streaming and falls back to a normal
 * submit when idle. The patch fills the key into the KeybindingsManager Pi
 * handed the editor: `app.message.followUp` = enter; `tui.input.submit` keeps
 * Pi's default enter.
 * It is in-memory only; keybindings.json stays the user's. A user who set
 * either action there keeps their keymap, and the feature stays out of the way.
 *
 * `tui.input.submit` keeps enter because Pi's editor submits through it when it
 * handles the key itself: after the slash menu completes a command, the same
 * Enter falls through to submit, and that is how one Enter runs `/pi_cc`. The
 * app action is checked first, so outside the menu Enter still goes to the
 * queue. Ctrl+Enter is not added to either action.
 *
 * Up (and Ctrl+P, which CC's prompt maps to up) on the empty editor puts the
 * queued message back for editing — CC's "Press up to select a queued message
 * to edit", for the single-message case this feature is for. Pi already has
 * that in its dequeue action, so the patch only routes the key there when the
 * session reports a pending message; with nothing queued, Up keeps browsing
 * history and Ctrl+P keeps whatever else it is bound to.
 *
 * Ctrl+P is recognized by its byte, not through `tui.editor.cursorUp`, so a
 * prompt that never copied CC's keymap still gets the CC behaviour. It only
 * applies in the same narrow state as Up — empty prompt, something queued —
 * where Pi would otherwise cycle models.
 *
 * The restored text goes in with setText, so Pi's own Down only moves the
 * cursor over it. Down / Ctrl+N on its last line puts the prompt back as it
 * was (recall.ts), for our Up and for Pi's dequeue key (Alt+Up), which the
 * patch watches for the same reason. The message is in ↑ history — Pi adds it
 * when it is queued — so the Down does not lose it. Native prompt history
 * stays with Pi: arrows move between visual lines first, then browse at the
 * boundaries. Dedicated history actions keep their own precedence.
 *
 * Three editor states need Enter more than the queue action does:
 *
 * - the slash-command / file menu: Enter confirms the completion, and the
 *   editor's own handling runs after the app actions in CustomEditor, so the
 *   queue action would swallow it (verified on Pi 1.4.0: with only the
 *   keybinding changed, Enter on "/" sent "/" as a prompt);
 * - extension prompts that set `disableSubmit`: Enter must keep doing nothing;
 * - a backslash right before the cursor: Pi's fallback for terminals that
 *   cannot send Shift+Enter turns the Enter into a newline, and that lives in
 *   the editor's own submit branch, below the app actions.
 *
 * In those states the patch runs the editor's handling with the app actions
 * cleared, which is how Pi already lets Enter cancel an autocomplete menu
 * (`app.interrupt` guards on isShowingAutocomplete).
 */

import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { loadConfig } from "./config.ts";
import { interceptEditorInput, type ChainEditor } from "./input.ts";
import { noteRecall, promptDown } from "./recall.ts";

const INSTALLED = Symbol.for("pi-cc-plugins:cc-keys");
/** What the interceptor needs of Pi's editor. */
const REQUIRED = ["handleInput", "isShowingAutocomplete", "getText", "setText"];

/** What the patch relies on of Pi's editor: public methods, plus internals. */
interface CcEditor {
	handleInput(data: string): void;
	isShowingAutocomplete(): boolean;
	getText(): string;
	setText(text: string): void;
	getCursor(): { line: number; col: number };
	getLines(): string[];
	/** Is the cursor on the last line? (private in Pi's types) */
	isOnLastVisualLine(): boolean;
	/** The editor's own submit switch (private); extension prompts set it. */
	disableSubmit?: boolean;
	/** CustomEditor's app action handlers (private). */
	actionHandlers?: Map<string, () => void>;
	/** The texts behind [paste #n] markers (private in Pi's types). */
	pastes?: Map<number, string>;
	pasteCounter?: number;
	/** The KeybindingsManager Pi handed this editor. */
	keybindings?: Keybindings;
}

/** The parts of Pi's KeybindingsManager the patch uses. */
interface Keybindings {
	matches?(data: string, action: string): boolean;
	getUserBindings?(): Record<string, unknown>;
	setUserBindings?(bindings: Record<string, unknown>): void;
}

type EditorPrototype = Record<PropertyKey, unknown>;

/** The actions whose bindings are affected by the queue key. */
const CC_ACTIONS = ["app.message.followUp", "tui.input.submit"] as const;

type Bindings = Record<string, unknown>;

/** What one install wrote into a manager, and what was there before it. */
type Patched = Map<Keybindings, { before: Bindings; after: Bindings }>;

const sameValue = (left: unknown, right: unknown): boolean =>
	Array.isArray(left) && Array.isArray(right)
		? left.length === right.length && left.every((key, index) => key === right[index])
		: left === right;

const sameBindings = (left: Bindings, right: Bindings): boolean => {
	const keys = Object.keys(left);
	return keys.length === Object.keys(right).length && keys.every((key) => key in right && sameValue(left[key], right[key]));
};

/**
 * Give the editor the queue key, unless the user chose a key for either action.
 * A manager that still holds what we wrote is left alone; one whose bindings
 * were replaced since (keybindings.json reloaded, say) is reconciled again.
 */
function applyCcBindings(manager: Keybindings | undefined, patched: Patched): void {
	if (typeof manager?.getUserBindings !== "function" || typeof manager.setUserBindings !== "function") return;
	const current = manager.getUserBindings();
	if (!current || typeof current !== "object") return;
	const applied = patched.get(manager);
	if (applied && sameBindings(current, applied.after)) return;
	patched.delete(manager);
	// The user's keymap wins, even when it spells out Pi's default pair.
	if (CC_ACTIONS.some((action) => action in current)) return;
	// `tui.input.submit` is not written: `enter` is already Pi's default for it,
	// so the slash-menu fall-through still submits through that action, and
	// writing it would double-claim enter in getConflicts().
	const after = { ...current, "app.message.followUp": "enter" };
	patched.set(manager, { before: { ...current }, after });
	manager.setUserBindings(after);
}

/**
 * Put back the bindings each manager held before the patch, for managers still
 * holding ours: a manager someone else changed since is left as it is.
 */
function restoreCcBindings(patched: Patched): void {
	for (const [manager, { before, after }] of patched) {
		if (sameBindings(manager.getUserBindings?.() ?? {}, after)) manager.setUserBindings?.(before);
	}
	patched.clear();
}

/** Whether the key is bound to one of these actions on this editor. */
function matchesAny(editor: CcEditor, data: string, actions: readonly string[]): boolean {
	const keys = editor.keybindings;
	if (typeof keys?.matches !== "function") return false;
	return actions.some((action) => keys.matches?.(data, action));
}

/**
 * The keys CC's prompt treats as "up on the prompt": cursor up, history, and
 * Ctrl+P. Ctrl+P is checked as a byte rather than through the keymap: CC binds
 * it there itself, and waiting for keybindings.json to copy that left the key
 * dead for everyone else.
 */
const isUpKey = (editor: CcEditor, data: string): boolean =>
	matchesKey(data, "ctrl+p") || matchesAny(editor, data, ["tui.editor.cursorUp", "tui.editor.historyPrevious"]);

const isCcKey = (editor: CcEditor, data: string): boolean => matchesAny(editor, data, CC_ACTIONS);

/** Run the editor's own handling with the app actions out of the way. */
function withoutActions(editor: CcEditor, run: () => void): void {
	const handlers = editor.actionHandlers;
	if (!(handlers instanceof Map)) {
		run();
		return;
	}
	editor.actionHandlers = new Map();
	try {
		run();
	} finally {
		editor.actionHandlers = handlers;
	}
}

/** Is the cursor right after a backslash, where Enter continues the line? */
function continuesLine(editor: CcEditor): boolean {
	try {
		const { line, col } = editor.getCursor();
		return col > 0 && editor.getLines()[line]?.[col - 1] === "\\";
	} catch {
		return false;
	}
}

/**
 * Add CC's keys and queued-message recall to an editor class. Returns what
 * takes them off again, or undefined when the class lacks something the
 * interceptor needs or the patch is on already.
 */
export function installCcKeys(
	hasQueued?: () => boolean,
	proto: object = CustomEditor.prototype,
): (() => void) | undefined {
	const target = proto as EditorPrototype;
	if (target[INSTALLED]) return undefined;
	if (!REQUIRED.every((name) => typeof target[name] === "function")) return undefined;

	// Per install: one session's uninstall must not strip another's bindings.
	const patched: Patched = new Map();

	const intercept = (editor: ChainEditor, data: string, next: () => void, own: () => void): void => {
		const self = editor as unknown as CcEditor;
		applyCcBindings(self.keybindings, patched);
		// CC: Up on the empty prompt brings a queued message back for editing.
		// Pi's own dequeue action does the restore; it is only taken here when
		// the session reports something pending, so Up still browses history.
		const editorOwnsIt = self.isShowingAutocomplete() || self.disableSubmit === true;
		if (!editorOwnsIt && isUpKey(self, data) && self.getText() === "" && hasQueued?.()) {
			const restore = self.actionHandlers?.get("app.message.dequeue");
			if (restore) {
				const before = self.getText();
				restore();
				if (self.getText() !== "") {
					noteRecall(self, before);
					return;
				}
			}
		}
		// Pi's own dequeue key (Alt+Up): Pi does the restore, so it keeps its
		// precedence; the text it put in is remembered for Down afterwards.
		const dequeue = self.actionHandlers?.get("app.message.dequeue");
		if (dequeue && matchesAny(self, data, ["app.message.dequeue"])) {
			const before = self.getText();
			// Pi's dequeue replaces the text and drops the paste map; keep it so
			// Down can put the collapsed draft back whole, markers included.
			const pastes = self.pastes instanceof Map && self.pastes.size > 0 ? new Map(self.pastes) : undefined;
			const pasteCounter = self.pasteCounter;
			next();
			if (self.getText() !== before) noteRecall(self, before, pastes && { pastes, pasteCounter });
			return;
		}
		// The menu and a disabled submit own Enter, without any app action taking
		// it first; so does a backslash before plain Enter, Pi's newline fallback
		// for terminals that cannot send Shift+Enter.
		if (isCcKey(self, data) && (editorOwnsIt || (matchesKey(data, "enter") && continuesLine(self)))) {
			withoutActions(self, own);
			return;
		}
		promptDown(self, data, self.keybindings, next);
	};

	const remove = interceptEditorInput(intercept, proto);
	if (!remove) return undefined;
	target[INSTALLED] = true;
	return () => {
		remove();
		delete target[INSTALLED];
		restoreCcBindings(patched);
	};
}

export default function ccKeysExtension(pi: ExtensionAPI): (reinstall?: boolean) => void {
	let uninstall: (() => void) | undefined;
	let inTui = false;
	let ctx: ExtensionContext | undefined;
	/** Does anything wait in the session's queue? A stale ctx counts as no. */
	const hasQueued = (): boolean => {
		try {
			return ctx?.hasPendingMessages?.() === true;
		} catch {
			return false;
		}
	};
	/** Follow the shared `ccKeys` setting: install or take the patch off. */
	const sync = (reinstall = false) => {
		const enabled = loadConfig().ccKeys;
		// index.ts re-seats both features in chain order on a config change.
		if (reinstall && uninstall) {
			uninstall();
			uninstall = undefined;
		}
		if (enabled && inTui && !uninstall) uninstall = installCcKeys(hasQueued);
		else if ((!enabled || !inTui) && uninstall) {
			uninstall();
			uninstall = undefined;
		}
	};
	pi.on("session_start", (_event, sessionCtx) => {
		inTui = sessionCtx.mode === "tui";
		ctx = sessionCtx;
		sync();
	});
	pi.on("session_shutdown", () => {
		uninstall?.();
		uninstall = undefined;
		ctx = undefined;
	});
	return sync;
}
