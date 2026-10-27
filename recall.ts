/**
 * Down on the prompt, as Claude Code's prompt does: back to the draft.
 *
 * Two texts need the help. A text this package put back with setText — the
 * draft Ctrl+C kept, a queued message Up brought back — is not a history
 * entry, so Pi's Down only moves the cursor over it and the text stays. And
 * while Pi browses its history, its Down waits for the cursor to reach the
 * last visual line: on a long or multi-line prompt the first presses only walk
 * down, and the prompt comes back a press later. Here both go back at once.
 *
 * History is left alone: a draft does not reach ↑ history before it is sent.
 * The put-back record is forgotten as soon as the text changes — an edit, a
 * send, anything but us — and an edited text is the editor's again (editing
 * ends browsing). The slash-command / file menu keeps Down while it is open.
 */

/** What a put-back needs of Pi's editor. */
export interface RecallEditor {
	getText(): string;
	setText(text: string): void;
	/** Editor's own check (private in Pi's types); absent only on a class lacking it. */
	isOnLastVisualLine?(): boolean;
	/** The slash-command / file menu owns Down while it is open. */
	isShowingAutocomplete?(): boolean;
	/** -1 unless browsing history, which ends on Down (private in Pi's types). */
	historyIndex?: number;
	/** Pi's own history step; private in its types. */
	navigateHistory?(direction: number): void;
}

interface Keys {
	matches?(data: string, action: string): boolean;
}

/** The text Up put back, and what the editor held before it. */
const recalled = new WeakMap<object, { text: string; before: string }>();

/** Remember the text just put into the editor, and the text it replaced. */
export function noteRecall(editor: RecallEditor, before: string): void {
	const text = editor.getText();
	if (text === "" || text === before) recalled.delete(editor);
	else recalled.set(editor, { text, before });
}

/** Is the cursor on the last line, where Down would leave the editor? */
function onLastLine(editor: RecallEditor): boolean {
	if (typeof editor.isOnLastVisualLine !== "function") return !editor.getText().includes("\n");
	try {
		return editor.isOnLastVisualLine();
	} catch {
		return false;
	}
}

/** Down / Ctrl+N: the editor's "next" key. */
function isDown(keys: Keys | undefined, data: string): boolean {
	return keys?.matches?.(data, "tui.editor.cursorDown") === true || keys?.matches?.(data, "tui.editor.historyNext") === true;
}

/**
 * Down / Ctrl+N on the prompt: go back to what the editor held before Up, the
 * way the end of the history does — one press, whatever the text's length.
 * Every other key, and a text the user edited since, goes on to `next`.
 */
export function promptDown(editor: RecallEditor, data: string, keys: Keys | undefined, next: () => void): void {
	if (!isDown(keys, data) || editor.isShowingAutocomplete?.() === true) {
		next();
		return;
	}
	// Browsing history: the newer entry, or back to the draft.
	const browsing = typeof editor.historyIndex === "number" && editor.historyIndex !== -1;
	if (browsing) {
		if (typeof editor.navigateHistory === "function") editor.navigateHistory(1);
		else next();
		return;
	}
	const held = recalled.get(editor);
	if (!held) {
		next();
		return;
	}
	if (editor.getText() !== held.text) {
		recalled.delete(editor);
		next();
		return;
	}
	if (!onLastLine(editor)) {
		next();
		return;
	}
	recalled.delete(editor);
	editor.setText(held.before);
}
