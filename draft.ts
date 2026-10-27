/**
 * Ctrl+C keeps what it clears, as in Claude Code: Up on the empty editor
 * brings it back with the cursor at the end, and a draft not brought back
 * goes into the editor's history just before the next prompt sent.
 *
 * Claude Code 2.1.308 (holdCleared / restoreCleared in its prompt store):
 * - Ctrl+C keeps the text, pasted content included, unless it is blank or an
 *   unedited history entry.
 * - Up / Ctrl+P on the empty prompt (no suggestions open) puts it back, once.
 * - A draft not put back joins the history when the prompt is next sent, or
 *   at the next Ctrl+C.
 * - Down / Ctrl+N on the text it put back leaves the prompt as it was before
 *   the Up (recall.ts), the way the end of the history does.
 * "Up" here is whatever Pi binds to cursor up or history previous, so Ctrl+P
 * counts when keybindings.json binds it.
 *
 * Pi has no hook for this: ctrl+c is reserved for extensions, a shortcut on up
 * would take the key from the editor, and the extension API cannot add to the
 * editor's history. Taking the editor slot would fight pi-cc-extensions' ❯
 * prompt for it, and every editor swap loses history and undo. So this adds an
 * interceptor to the shared key handling (input.ts) for CustomEditor, the
 * class every Pi editor shares (the default one and subclasses such as
 * pi-cc-extensions' PromptEditor), and leaves the slot alone. Keys reach only
 * the focused component, so Up in a selector or a dialog never gets here.
 *
 * The interceptor goes on at session start in the TUI and comes off at
 * shutdown, so /reload runs the current code. If the editor lacks anything it
 * relies on, it stays off and Ctrl+C behaves as before.
 *
 * The shared `draft` setting (pi-cc.json, /pi_cc) decides whether it is on at
 * all; it is read at session start and again whenever a pi-cc package changes
 * the settings, so the panel turns the patch on and off without a reload.
 */

import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.ts";
import { interceptEditorInput, type ChainEditor } from "./input.ts";
import { noteRecall, promptDown } from "./recall.ts";

/** What the patch uses of Pi's editor: public methods, plus three internals. */
interface DraftEditor {
	getText(): string;
	getExpandedText(): string;
	setText(text: string): void;
	addToHistory(text: string): void;
	isShowingAutocomplete(): boolean;
	handleInput(data: string): void;
	/** CustomEditor's app keybindings (private in Pi's types). */
	keybindings?: { matches(data: string, action: string): boolean };
	/** -1 unless browsing history; any edit ends browsing (private). */
	historyIndex?: number;
	/** The texts behind [paste #n] markers (private). */
	pastes?: Map<number, string>;
	pasteCounter?: number;
}

interface Draft {
	/** As shown, paste markers included. */
	text: string;
	/** As it would be sent: what goes into history. */
	expanded: string;
	pastes?: Map<number, string>;
	pasteCounter?: number;
}

type EditorPrototype = Record<PropertyKey, unknown>;

const INSTALLED = Symbol.for("pi-cc-plugins:draft");
const REQUIRED = ["handleInput", "addToHistory", "getText", "getExpandedText", "setText", "isShowingAutocomplete"];

/** The draft each editor holds. */
const drafts = new WeakMap<object, Draft>();

function keep(editor: DraftEditor): Draft | undefined {
	const text = editor.getText();
	if (text.trim() === "") return undefined;
	if (typeof editor.historyIndex === "number" && editor.historyIndex !== -1) return undefined;
	return {
		text,
		expanded: editor.getExpandedText(),
		pastes: editor.pastes instanceof Map ? new Map(editor.pastes) : undefined,
		pasteCounter: editor.pasteCounter,
	};
}

function putBack(editor: DraftEditor, draft: Draft): void {
	const before = editor.getText();
	editor.setText(draft.text); // the cursor goes to the end; setText drops the pastes
	if (draft.pastes) {
		editor.pastes = new Map(draft.pastes);
		editor.pasteCounter = draft.pasteCounter;
	}
	noteRecall(editor, before);
}

/** The keys CC's prompt treats as "up on the prompt": cursor up, or history. */
function isUpKey(keys: { matches(data: string, action: string): boolean }, data: string): boolean {
	return keys.matches(data, "tui.editor.cursorUp") || keys.matches(data, "tui.editor.historyPrevious");
}

/**
 * Add the draft hold to an editor class. Returns what takes it off again, or
 * undefined when the class lacks something it needs or it is on already.
 */
export function installDraftHold(proto: object = CustomEditor.prototype): (() => void) | undefined {
	const target = proto as EditorPrototype;
	if (target[INSTALLED]) return undefined;
	if (!REQUIRED.every((name) => typeof target[name] === "function")) return undefined;

	// The method under the patch below: a held draft goes into history through
	// it, never through the wrapper (which would try to hold it too).
	const addToHistory = target.addToHistory as (this: DraftEditor, text: string) => void;
	const ownAddToHistory = Object.hasOwn(target, "addToHistory");

	const hold = (editor: ChainEditor, data: string, next: () => void): void => {
		const self = editor as unknown as DraftEditor;
		const keys = self.keybindings;
		if (typeof keys?.matches !== "function") {
			next();
			return;
		}
		if (keys.matches(data, "app.clear")) {
			const draft = keep(self);
			next();
			// Only a press that cleared the editor keeps it (the second press exits Pi).
			if (draft && self.getText() === "") {
				const older = drafts.get(self);
				if (older) addToHistory.call(self, older.expanded);
				drafts.set(self, draft);
			}
			return;
		}
		const draft = drafts.get(self);
		if (draft && self.getText() === "" && !self.isShowingAutocomplete() && isUpKey(keys, data)) {
			drafts.delete(self);
			putBack(self, draft);
			return;
		}
		promptDown(self, data, keys, next);
	};

	const remove = interceptEditorInput(hold, proto);
	if (!remove) return undefined;

	// Pi calls addToHistory for every prompt sent: a draft still held goes in first.
	const wrapperAddToHistory = function (this: DraftEditor, text: string): void {
		const draft = drafts.get(this);
		if (draft) {
			drafts.delete(this);
			addToHistory.call(this, draft.expanded);
		}
		addToHistory.call(this, text);
	};
	target.addToHistory = wrapperAddToHistory;
	target[INSTALLED] = true;
	return () => {
		remove();
		// Only put Pi's method back if it is still the one below us.
		if (target.addToHistory === wrapperAddToHistory) {
			if (ownAddToHistory) target.addToHistory = addToHistory;
			else delete target.addToHistory;
		}
		delete target[INSTALLED];
	};
}

export default function draftExtension(pi: ExtensionAPI): () => void {
	let uninstall: (() => void) | undefined;
	let inTui = false;
	/** Follow the shared `draft` setting: install or take the patch off. */
	const sync = () => {
		const enabled = loadConfig().draft;
		if (enabled && inTui && !uninstall) uninstall = installDraftHold();
		else if ((!enabled || !inTui) && uninstall) {
			uninstall();
			uninstall = undefined;
		}
	};
	pi.on("session_start", (_event, ctx) => {
		inTui = ctx.mode === "tui";
		sync();
	});
	pi.on("session_shutdown", () => {
		uninstall?.();
		uninstall = undefined;
	});
	return sync;
}
