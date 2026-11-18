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

import { matchesKey } from "@earendil-works/pi-tui";

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
	/** The texts behind [paste #n] markers (private in Pi's types). */
	pastes?: Map<number, string>;
	pasteCounter?: number;
}

/** The paste map a collapsed draft held, so setText can be undone whole. */
export interface PasteSnapshot {
	pastes: Map<number, string>;
	pasteCounter?: number;
}

interface Keys {
	matches?(data: string, action: string): boolean;
}

/** The text Up put back, and what the editor held before it. */
const recalled = new WeakMap<object, { text: string; before: string; beforePastes?: PasteSnapshot }>();

/** Remember the text just put into the editor, and the text it replaced. */
export function noteRecall(editor: RecallEditor, before: string, beforePastes?: PasteSnapshot): void {
	const text = editor.getText();
	if (text === "" || text === before) recalled.delete(editor);
	else recalled.set(editor, { text, before, beforePastes });
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
	// Ctrl+N by byte, as cc-keys takes Ctrl+P: CC's prompt maps it to down, but
	// Pi's default cursorDown does not. Only the recall boundary below uses it.
	const down = keys?.matches?.(data, "tui.editor.cursorDown") === true || matchesKey(data, "ctrl+n");
	return down
		&& keys?.matches?.(data, "tui.editor.historyPrevious") !== true
		&& keys?.matches?.(data, "tui.editor.historyNext") !== true;
}

/**
 * Restore an unedited text this package recalled, only on its last visual line.
 * Native history, dedicated history actions, and every other key go to `next`.
 */
export function promptDown(editor: RecallEditor, data: string, keys: Keys | undefined, next: () => void): void {
	// Forget a record on any key once its text is gone — sent, cleared, or typed
	// over — so a later identical draft is not mistaken for the recall.
	const record = recalled.get(editor);
	if (record && editor.getText() !== record.text) recalled.delete(editor);
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
	if (!onLastLine(editor)) {
		next();
		return;
	}
	recalled.delete(editor);
	editor.setText(held.before);
	// setText drops the paste map; put back what the markers stood for.
	if (held.beforePastes) {
		editor.pastes = new Map(held.beforePastes.pastes);
		editor.pasteCounter = held.beforePastes.pasteCounter;
	}
}
