/**
 * Prompt keys: Up (and Ctrl+P) on the empty prompt recalls a queued message;
 * Down on its last visual line puts the prompt back as it was.
 *
 * Enter is deliberately left alone. Pi's own binding sends it — while a run is
 * streaming the message steers into that run at the next tool boundary, when
 * idle it submits — and this feature neither rebinds it nor handles it. There
 * is no keybinding patch in this file: the keys it adds are the recall below,
 * routed through Pi's own dequeue action.
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
 * Two editor states keep Up for themselves: the slash-command / file menu owns
 * the arrow keys while it is open, and an extension prompt that sets
 * `disableSubmit` is not the place to restore a queue either.
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
}

type EditorPrototype = Record<PropertyKey, unknown>;

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

/**
 * Add CC's queued-message recall to an editor class. Returns what takes it off
 * again, or undefined when the class lacks something the interceptor needs or
 * the patch is on already.
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
		promptDown(self, data, self.keybindings, next);
	};

	const remove = interceptEditorInput(intercept, proto);
	if (!remove) return undefined;
	target[INSTALLED] = true;
	return () => {
		remove();
		delete target[INSTALLED];
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