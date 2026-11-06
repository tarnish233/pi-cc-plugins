/**
 * Down on the last visual line of a recalled prompt: back to the draft.
 *
 * A text this package put back with setText — the draft Ctrl+C kept, a queued
 * message Up brought back — is not a history entry, so Pi's Down would leave
 * it in the editor. Only that unedited text needs the boundary restore here.
 *
 * Prompt history stays Pi's: arrows move through visual lines before browsing
 * older/newer entries at the boundaries; dedicated history actions always
 * browse. The put-back record is forgotten when the text changes, and the
 * slash-command / file menu keeps Down while it is open.
 */

/** What a put-back needs of Pi's editor. */
export interface RecallEditor {
	getText(): string;
	setText(text: string): void;
	/** Editor's own check (private in Pi's types); absent only on a class lacking it. */
	isOnLastVisualLine?(): boolean;
	/** The slash-command / file menu owns Down while it is open. */
	isShowingAutocomplete?(): boolean;
	/** -1 unless browsing history, whose navigation stays with Pi (private in its types). */
	historyIndex?: number;
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

/** Cursor Down / its aliases; an overlapping dedicated history binding wins. */
function isDown(keys: Keys | undefined, data: string): boolean {
	return keys?.matches?.(data, "tui.editor.cursorDown") === true
		&& keys?.matches?.(data, "tui.editor.historyPrevious") !== true
		&& keys?.matches?.(data, "tui.editor.historyNext") !== true;
}

/**
 * Restore an unedited text this package recalled, only on its last visual line.
 * Native history, dedicated history actions, and every other key go to `next`.
 */
export function promptDown(editor: RecallEditor, data: string, keys: Keys | undefined, next: () => void): void {
	if (!isDown(keys, data) || editor.isShowingAutocomplete?.() === true) {
		next();
		return;
	}
	// Let Pi move within the query and browse only at visual boundaries.
	// Even a matching put-back record must not replace Pi's captured history draft.
	const browsing = typeof editor.historyIndex === "number" && editor.historyIndex !== -1;
	if (browsing) {
		next();
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
