/**
 * Arrow keys edit recalled queries before browsing history at visual boundaries.
 * Exercise each interceptor alone and their real registration order together.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadModule, loadPi } from "./helpers.mjs";

const pi = await loadPi();
const draft = await loadModule("draft.ts");
const keys = await loadModule("cc-keys.ts");
const recall = await loadModule("recall.ts");
const { CustomEditor } = pi.agent;

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const CTRL_P = "\x10";
const CTRL_N = "\x0e";
const RIGHT = "\x1b[C";
const identity = (text) => text;
const theme = {
	borderColor: identity,
	selectList: { selectedPrefix: identity, selectedText: identity, description: identity, scrollInfo: identity, noMatch: identity },
};
const cursorBindings = {
	"tui.editor.cursorUp": ["up", "ctrl+p"],
	"tui.editor.cursorDown": ["down", "ctrl+n"],
	"tui.select.up": ["up", "ctrl+p"],
	"tui.select.down": ["down", "ctrl+n"],
	"app.model.cycleForward": "alt+p",
};
const older = "old-one\nold-two\nold-three";
const latest = "new-one\nnew-two\nnew-three";

function makeEditor({ history = [older, latest], text = "", bindings = cursorBindings, width = 100, Editor = CustomEditor } = {}) {
	const manager = new pi.KeybindingsManager(bindings);
	pi.tui.setKeybindings(manager);
	const editor = new Editor({ requestRender() {}, terminal: { rows: 40, columns: width } }, theme, manager);
	for (const entry of history) editor.addToHistory(entry);
	editor.setText(text);
	editor.render(width);
	return {
		editor,
		press: (...sequence) => {
			for (const key of sequence) {
				editor.handleInput(key);
				editor.render(width);
			}
		},
		resize: (nextWidth) => {
			width = nextWidth;
			editor.tui.terminal.columns = width;
			editor.render(width);
		},
	};
}

function withPatches(mode, body) {
	const removers = [];
	try {
		if (mode !== "cc keys only") {
			const remove = draft.installDraftHold();
			assert.ok(remove, "draft interceptor installed");
			removers.push(remove);
		}
		if (mode !== "draft only") {
			const remove = keys.installCcKeys(() => false);
			assert.ok(remove, "CC keys interceptor installed");
			removers.push(remove);
		}
		body();
	} finally {
		for (const remove of removers.reverse()) remove();
	}
}

for (const mode of ["draft only", "cc keys only", "both"]) {
	for (const [name, up, down] of [["arrows", UP, DOWN], ["Ctrl+P/N cursor aliases", CTRL_P, CTRL_N]]) {
		test(`${mode}: ${name} move inside multi-line history before returning to the unsent draft`, () => withPatches(mode, () => {
			const unsent = "my draft\nnot yet submitted";
			const { editor, press } = makeEditor({ text: unsent });
			const cursorBefore = editor.getCursor();
			// Enter history from the beginning without editing the draft.
			for (let i = 0; editor.historyIndex === -1 && i < 10; i++) press(up);
			assert.equal(editor.getText(), latest);
			assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
			press(down);
			assert.equal(editor.getText(), latest, "the first Down cannot replace the query");
			assert.deepEqual(editor.getCursor(), { line: 1, col: 0 });
			press(up);
			assert.equal(editor.getText(), latest, "Up from the middle cannot replace the query");
			assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
			press(down, down);
			assert.equal(editor.getText(), latest);
			assert.deepEqual(editor.getCursor(), { line: 2, col: 0 });
			press(down);
			assert.equal(editor.getText(), unsent, "Down on the last visual line restores the unsent draft");
			assert.equal(editor.historyIndex, -1);
			// Pi restores the draft cursor from when history was entered, not its initial position.
			assert.notDeepEqual(cursorBefore, editor.getCursor());
			assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
		}));
	}

	test(`${mode}: arrows switch older/newer queries only at their visual boundaries`, () => withPatches(mode, () => {
		const { editor, press } = makeEditor();
		press(UP, UP);
		assert.equal(editor.getText(), older);
		press(DOWN);
		assert.equal(editor.getText(), older);
		assert.deepEqual(editor.getCursor(), { line: 1, col: 0 });
		press(DOWN, DOWN);
		assert.equal(editor.getText(), latest, "only the last-line Down selects the newer entry");
		assert.equal(editor.getCursor().line, 2);
		press(UP);
		assert.equal(editor.getText(), latest);
		assert.equal(editor.getCursor().line, 1);
		press(UP);
		assert.equal(editor.getText(), latest);
		assert.equal(editor.getCursor().line, 0);
		press(UP);
		assert.equal(editor.getText(), older, "only first-line Up selects the older entry");
	}));

	for (const [name, text] of [["ASCII", "abcdefghij".repeat(6)], ["Chinese", "多行历史输入测试".repeat(8)]]) {
		test(`${mode}: ${name} soft-wrapped history respects visual lines and terminal resize`, () => withPatches(mode, () => {
			const { editor, press, resize } = makeEditor({ history: [text], width: 21 });
			press(UP, DOWN);
			assert.equal(editor.getText(), text);
			const secondRow = editor.getCursor();
			assert.equal(secondRow.line, 0, "wrapping does not insert logical newlines");
			assert.ok(secondRow.col > 0, "Down moves to the next visual row");
			press(UP);
			assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
			press(DOWN);
			resize(11);
			press(DOWN);
			assert.equal(editor.getText(), text);
			assert.ok(editor.getCursor().col > secondRow.col, "movement uses the resized layout");
			for (let i = 0; !editor.isOnLastVisualLine() && i < 100; i++) {
				press(DOWN);
				assert.equal(editor.getText(), text, "every internal visual row keeps the query");
			}
			assert.ok(editor.isOnLastVisualLine());
			press(DOWN);
			assert.equal(editor.getText(), "", "only the final visual row can leave history");
		}));
	}

	test(`${mode}: dedicated history actions still browse regardless of cursor position`, () => withPatches(mode, () => {
		const bindings = { ...cursorBindings, "tui.editor.historyPrevious": "ctrl+p", "tui.editor.historyNext": "ctrl+n" };
		const unsent = "unsent\ndraft";
		const { editor, press } = makeEditor({ text: unsent, bindings });
		const cursorBefore = editor.getCursor();
		press(CTRL_P);
		assert.equal(editor.getText(), latest, "dedicated Previous enters history from the last row");
		press(CTRL_P);
		assert.equal(editor.getText(), older);
		press(CTRL_N);
		assert.equal(editor.getText(), latest, "dedicated Next skips to the newer query");
		press(CTRL_P, CTRL_N);
		assert.equal(editor.getText(), latest);
		// Move to the first row without changing the query, then use explicit Next there.
		press(UP, UP);
		assert.equal(editor.getCursor().line, 0);
		press(CTRL_N);
		assert.equal(editor.getText(), unsent, "dedicated Next does not have a last-row restriction");
		assert.deepEqual(editor.getCursor(), cursorBefore);
	}));

	test(`${mode}: dedicated Previous mapped to Down can browse from a recalled prompt`, () => withPatches(mode, () => {
		const bindings = { ...cursorBindings, "tui.editor.historyPrevious": "down" };
		const { editor, press } = makeEditor({ text: "restored\nprompt", bindings });
		recall.noteRecall(editor, "");
		press(DOWN);
		assert.equal(editor.getText(), latest, "the dedicated action browses instead of clearing the recall");
		assert.equal(editor.historyIndex, 0);
	}));

	test(`${mode}: an edited history query remains ordinary editable text`, () => withPatches(mode, () => {
		const { editor, press } = makeEditor();
		press(UP, RIGHT, "!");
		const edited = editor.getText();
		assert.equal(editor.historyIndex, -1);
		press(DOWN);
		assert.equal(editor.getText(), edited);
		assert.equal(editor.getCursor().line, 1);
		press(UP);
		assert.equal(editor.getText(), edited);
		assert.equal(editor.getCursor().line, 0);
	}));

	test(`${mode}: autocomplete keeps Down while a history query is selected`, () => withPatches(mode, () => {
		const { editor, press } = makeEditor();
		press(UP);
		let selections = 0;
		editor.autocompleteState = "regular";
		editor.autocompleteList = { handleInput() { selections++; }, getSelectedItem: () => ({ value: latest, label: latest }), render: () => [] };
		press(DOWN);
		assert.equal(selections, 1);
		assert.equal(editor.getText(), latest);
		assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
	}));

	test(`${mode}: a matching recall record cannot replace Pi's own history draft`, () => withPatches(mode, () => {
		const text = "same\nquery";
		const { editor, press } = makeEditor({ history: [text], text });
		// A queued or Ctrl+C-restored query can also already exist in prompt history.
		recall.noteRecall(editor, "text before the recall");
		for (let i = 0; editor.historyIndex === -1 && i < 10; i++) press(UP);
		assert.equal(editor.historyIndex, 0);
		press(DOWN);
		assert.equal(editor.historyIndex, 0);
		press(DOWN);
		assert.equal(editor.historyIndex, -1);
		assert.equal(editor.getText(), text, "history restores its captured draft, not the recall record");
	}));

	test(`${mode}: CustomEditor subclasses keep multi-line history navigation`, () => withPatches(mode, () => {
		class PromptEditor extends CustomEditor {}
		const { editor, press } = makeEditor({ Editor: PromptEditor });
		press(UP, DOWN);
		assert.equal(editor.getText(), latest);
		assert.deepEqual(editor.getCursor(), { line: 1, col: 0 });
	}));
}

for (const historyAction of ["tui.editor.historyPrevious", "tui.editor.historyNext"]) {
	test(`${historyAction} is passed through even on the last row of a recalled draft`, () => {
		const text = "restored\ndraft";
		const editor = {
			getText: () => text,
			setText: () => assert.fail("a dedicated history action cannot clear the recalled draft"),
			isOnLastVisualLine: () => true,
			historyIndex: -1,
		};
		recall.noteRecall(editor, "before");
		const keys = { matches: (_data, action) => action === historyAction || action === "tui.editor.cursorDown" };
		let forwarded = 0;
		recall.promptDown(editor, CTRL_N, keys, () => { forwarded++; });
		assert.equal(forwarded, 1, "the dedicated action keeps precedence over cursor Down");
	});
}
