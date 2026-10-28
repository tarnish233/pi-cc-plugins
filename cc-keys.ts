/**
 * Claude Code's prompt keys: Enter queues while Pi is working, Ctrl+Enter
 * sends now, and the slash menu keeps Enter for itself.
 *
 * CC 2.1.310 (its Chat keymap): enter is chat:submit (queued while busy),
 * ctrl+enter is chat:sendNow, ctrl+x enter is chat:queueSubmit. Pi's default
 * is the other way round: enter steers (sent into the run) and alt+enter
 * queues. The two actions already exist in Pi — `app.message.followUp` queues
 * while streaming and falls back to a normal submit when idle, `tui.input.submit`
 * submits (steers) — so the keys are all that differ.
 *
 * The patch fills the keys into the KeybindingsManager Pi handed the editor:
 * `app.message.followUp` = enter, `tui.input.submit` = enter and ctrl+enter.
 * It is in-memory only; keybindings.json stays the user's. A user who set
 * either action there keeps their keymap, and the feature stays out of the way.
 *
 * `tui.input.submit` keeps enter because Pi's editor submits through it when it
 * handles the key itself: after the slash menu completes a command, the same
 * Enter falls through to submit, and that is how one Enter runs `/pi_cc`. The
 * app action is checked first, so outside the menu Enter still goes to the
 * queue; ctrl+enter is in the list for "send now".
 *
 * Up (and Ctrl+P where keybindings.json points it at cursor up, as CC's prompt
 * maps it) on the empty editor puts the queued message back for editing — CC's
 * "Press up to select a queued message to edit", for the single-message case
 * this feature is for. Pi already has that in its dequeue action, so the patch
 * only routes the key there when the session reports a pending message; with
 * nothing queued, Up keeps browsing history. The dequeue action has no
 * take-one API, so several queued messages come back together; there is no
 * per-message picker, by design.
 *
 * The restored text goes in with setText, so Pi's own Down only moves the
 * cursor over it. Down / Ctrl+N on its last line puts the prompt back as it
 * was (recall.ts), for our Up and for Pi's dequeue key (Alt+Up), which the
 * patch watches for the same reason. The message is in ↑ history — Pi adds it
 * when it is queued — so the Down does not lose it. The same goes for a
 * prompt recalled from the history: Pi's Down walks the cursor to the last
 * visual line first, so a long or multi-line prompt took several presses;
 * recall.ts ends the browsing in one.
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
import { editorInput, interceptEditorInput, type ChainEditor } from "./input.ts";
import { noteRecall, promptDown } from "./recall.ts";

const INSTALLED = Symbol.for("pi-cc-plugins:cc-keys");
/** What the interceptor needs of Pi's editor. */
const REQUIRED = ["handleInput", "isShowingAutocomplete", "getText", "setText", "submitValue"];

/** What the patch relies on of Pi's editor: public methods, plus internals. */
interface CcEditor {
	handleInput(data: string): void;
	isShowingAutocomplete(): boolean;
	getText(): string;
	setText(text: string): void;
	/** Pi's own submit, bypassing only its backslash + Enter newline fallback. */
	submitValue(): void;
	getCursor(): { line: number; col: number };
	getLines(): string[];
	/** Is the cursor on the last line? (private in Pi's types) */
	isOnLastVisualLine(): boolean;
	/** The editor's own submit switch (private); extension prompts set it. */
	disableSubmit?: boolean;
	/** CustomEditor's app action handlers (private). */
	actionHandlers?: Map<string, () => void>;
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

/** The actions Claude Code's two keys land on, in Pi's names. */
const CC_ACTIONS = ["app.message.followUp", "tui.input.submit"] as const;

/**
 * What those actions are bound to. `tui.input.submit` keeps `enter`: the
 * editor's slash-menu fall-through submits the command it just completed with
 * the same Enter, and that check reads this action.
 */
const ccBindings = (): Bindings => ({
	"app.message.followUp": "enter",
	"tui.input.submit": ["enter", "ctrl+enter"],
});

type Bindings = Record<string, unknown>;

/** What this patch wrote into a manager, and what was there before it. */
const patched = new Map<Keybindings, { before: Bindings; after: Bindings }>();

const sameValue = (left: unknown, right: unknown): boolean =>
	Array.isArray(left) && Array.isArray(right)
		? left.length === right.length && left.every((key, index) => key === right[index])
		: left === right;

const sameBindings = (left: Bindings, right: Bindings): boolean => {
	const keys = Object.keys(left);
	return keys.length === Object.keys(right).length && keys.every((key) => key in right && sameValue(left[key], right[key]));
};

/**
 * Give the editor CC's pair, unless the user chose a key for either action.
 * A manager that still holds what we wrote is left alone; one whose bindings
 * were replaced since (keybindings.json reloaded, say) is reconciled again.
 */
function applyCcBindings(manager: Keybindings | undefined): void {
	if (typeof manager?.getUserBindings !== "function" || typeof manager.setUserBindings !== "function") return;
	const current = manager.getUserBindings();
	if (!current || typeof current !== "object") return;
	const applied = patched.get(manager);
	if (applied && sameBindings(current, applied.after)) return;
	patched.delete(manager);
	// The user's keymap wins, even when it spells out Pi's default pair.
	if (CC_ACTIONS.some((action) => action in current)) return;
	const after = { ...current, ...ccBindings() };
	patched.set(manager, { before: { ...current }, after });
	manager.setUserBindings(after);
}

/**
 * Put back the bindings each manager held before the patch, for managers still
 * holding ours: a manager someone else changed since is left as it is.
 */
function restoreCcBindings(): void {
	for (const [manager, { before, after }] of patched) {
		if (sameBindings(manager.getUserBindings?.() ?? {}, after)) manager.setUserBindings?.(before);
	}
	patched.clear();
}

/** Whether the key is bound to one of these actions on this editor. */
function matchesAny(editor: CcEditor, data: string, actions: string[]): boolean {
	const keys = editor.keybindings;
	if (typeof keys?.matches !== "function") return false;
	return actions.some((action) => keys.matches?.(data, action));
}

/** The keys CC's prompt treats as "up on the prompt": cursor up, or history. */
const isUpKey = (editor: CcEditor, data: string): boolean =>
	matchesAny(editor, data, ["tui.editor.cursorUp", "tui.editor.historyPrevious"]);

const isCcKey = (editor: CcEditor, data: string): boolean => matchesAny(editor, data, [...CC_ACTIONS]);

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

	const intercept = (editor: ChainEditor, data: string, next: () => void): void => {
		const self = editor as unknown as CcEditor;
		applyCcBindings(self.keybindings);
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
			next();
			if (self.getText() !== before) noteRecall(self, before);
			return;
		}
		// Ctrl+Enter is CC's send-now key, including after a backslash. Pi's
		// submitValue avoids the editor's backslash + Enter newline fallback.
		if (!editorOwnsIt && patched.has(self.keybindings ?? {}) && matchesKey(data, "ctrl+enter") && continuesLine(self)) {
			self.submitValue();
			return;
		}
		// The menu and a disabled submit own Enter, without any app action taking
		// it first; so does a backslash before plain Enter, Pi's newline fallback
		// for terminals that cannot send Shift+Enter.
		if (isCcKey(self, data) && (editorOwnsIt || (matchesKey(data, "enter") && continuesLine(self)))) {
			withoutActions(self, () => editorInput(self, data, proto));
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
		restoreCcBindings();
	};
}

export default function ccKeysExtension(pi: ExtensionAPI): () => void {
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
	const sync = () => {
		const enabled = loadConfig().ccKeys;
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
