/**
 * draft.ts: Ctrl+C keeps what it clears, as in Claude Code 2.1.308
 * (holdCleared / restoreCleared in its prompt store).
 *
 * The tests drive Pi's real CustomEditor with keys, wired the way Pi wires it:
 * a first Ctrl+C runs app.clear, which empties the editor
 * (InteractiveMode.clearEditor), and every prompt sent goes to addToHistory.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { fakePi, loadModule, loadPi, TUI_CTX } from "./helpers.mjs";

const pi = await loadPi();
const draft = await loadModule("draft.ts");
const { CustomEditor } = pi.agent;

const CTRL_C = "\x03";
const CTRL_P = "\x10";
const UP = "\x1b[A";
const ENTER = "\r";
const paste = (text) => `\x1b[200~${text}\x1b[201~`;

const identity = (text) => text;
const editorTheme = {
	borderColor: identity,
	selectList: { selectedPrefix: identity, selectedText: identity, description: identity, scrollInfo: identity, noMatch: identity },
};

function makeEditor(bindings = {}) {
	const tui = { requestRender() {}, terminal: { rows: 40, columns: 100 } };
	const editor = new CustomEditor(tui, editorTheme, new pi.KeybindingsManager(bindings));
	let clears = 0;
	editor.onAction("app.clear", () => {
		clears++;
		editor.setText("");
	});
	editor.onSubmit = (text) => editor.addToHistory(text);
	return {
		editor,
		type: (text) => {
			for (const ch of text) editor.handleInput(ch);
		},
		press: (...keys) => {
			for (const key of keys) editor.handleInput(key);
		},
		clears: () => clears,
	};
}

/** Run body with the extension loaded into a TUI session, as Pi runs it. */
async function withDraft(body) {
	const host = fakePi();
	draft.default(host.pi);
	await host.emit("session_start", { reason: "startup" }, TUI_CTX);
	try {
		await body();
	} finally {
		await host.emit("session_shutdown", {}, TUI_CTX);
	}
}

test("Pi alone: what Ctrl+C clears is gone from Up", () => {
	const { editor, type, press } = makeEditor();
	type("draft A");
	press(CTRL_C, UP);
	assert.equal(editor.getText(), "");
});

test("Ctrl+C keeps the text: Up on the empty editor brings it back, cursor at the end", async () => {
	await withDraft(() => {
		const { editor, type, press } = makeEditor();
		type("draft A");
		press(CTRL_C);
		assert.equal(editor.getText(), "", "Ctrl+C still clears");
		press(UP);
		assert.equal(editor.getText(), "draft A");
		type("!");
		assert.equal(editor.getText(), "draft A!", "the cursor is at the end");
	});
});

test("typing and deleting back to empty keeps the draft, as in Claude Code", async () => {
	await withDraft(() => {
		const { editor, type, press } = makeEditor();
		type("draft A");
		press(CTRL_C);
		type("xy");
		press("\x7f", "\x7f");
		press(UP);
		assert.equal(editor.getText(), "draft A");
	});
});

test("Ctrl+P brings it back too when it is bound to cursor up or history previous", async () => {
	await withDraft(() => {
		for (const bindings of [{ "tui.editor.cursorUp": ["up", "ctrl+p"] }, { "tui.editor.historyPrevious": "ctrl+p" }]) {
			const { editor, type, press } = makeEditor(bindings);
			type("draft P");
			press(CTRL_C, CTRL_P);
			assert.equal(editor.getText(), "draft P", JSON.stringify(bindings));
		}
	});
});

test("a draft not brought back goes into history just before the next prompt sent", async () => {
	await withDraft(() => {
		const { editor, type, press } = makeEditor();
		type("draft A");
		press(CTRL_C);
		type("question");
		press(ENTER);
		assert.equal(editor.getText(), "");
		press(UP);
		assert.equal(editor.getText(), "question");
		press(UP);
		assert.equal(editor.getText(), "draft A");
	});
});

test("a second Ctrl+C sends the older draft to history first", async () => {
	await withDraft(() => {
		const { editor, type, press } = makeEditor();
		type("one");
		press(CTRL_C);
		type("two");
		press(CTRL_C);
		press(UP);
		assert.equal(editor.getText(), "two", "the newer draft comes back");
		press(UP, UP); // to the line start, then into history
		assert.equal(editor.getText(), "one");
	});
});

test("an unedited history entry is not kept (it is in history already); an edited one is", async () => {
	await withDraft(() => {
		const { editor, type, press } = makeEditor();
		editor.addToHistory("old");
		editor.addToHistory("newer");
		press(UP, UP);
		assert.equal(editor.getText(), "old");
		press(CTRL_C);
		press(UP);
		assert.equal(editor.getText(), "newer", "Up browses history from the top: nothing was kept");

		press(UP);
		assert.equal(editor.getText(), "old");
		type("!"); // history puts the cursor at the start
		const edited = editor.getText();
		assert.equal(edited, "!old");
		press(CTRL_C, UP);
		assert.equal(editor.getText(), edited, "edited, so it is a draft");
	});
});

test("with nothing kept, Up browses history; a draft comes back only once", async () => {
	await withDraft(() => {
		const { editor, type, press } = makeEditor();
		editor.addToHistory("h1");
		press(CTRL_C, UP);
		assert.equal(editor.getText(), "h1", "Ctrl+C on an empty editor keeps nothing");

		editor.setText("");
		type("draft");
		press(CTRL_C, UP);
		assert.equal(editor.getText(), "draft");
		editor.setText("");
		press(UP);
		assert.equal(editor.getText(), "h1", "the draft was used up");
	});
});

test("a large paste comes back whole, and goes into history expanded", async () => {
	await withDraft(() => {
		const { editor, type, press } = makeEditor();
		const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
		press(paste(lines));
		type(" please");
		assert.equal(editor.getText(), "[paste #1 +20 lines] please");
		press(CTRL_C, UP);
		assert.equal(editor.getText(), "[paste #1 +20 lines] please", "still collapsed");
		assert.equal(editor.getExpandedText(), `${lines} please`, "with the pasted text behind it");

		press(CTRL_C);
		type("q");
		press(ENTER, UP, UP);
		assert.equal(editor.getText(), `${lines} please`, "history holds the text that would have been sent");
	});
});

test("Ctrl+C still reaches Pi on every press, so a second press within 500 ms still exits", async () => {
	await withDraft(() => {
		const { type, press, clears } = makeEditor();
		type("x");
		press(CTRL_C, CTRL_C);
		assert.equal(clears(), 2);
	});
});

test("the patch is on only in a TUI session, once, and comes off at shutdown", async () => {
	const proto = CustomEditor.prototype;
	const original = proto.handleInput;
	const ownAddToHistory = Object.hasOwn(proto, "addToHistory");

	const host = fakePi();
	draft.default(host.pi);
	await host.emit("session_start", {}, { mode: "rpc", hasUI: true });
	assert.equal(proto.handleInput, original, "not outside the TUI: there is no editor there");

	await host.emit("session_start", {}, TUI_CTX);
	const patched = proto.handleInput;
	assert.notEqual(patched, original);

	const second = fakePi();
	draft.default(second.pi);
	await second.emit("session_start", {}, TUI_CTX);
	assert.equal(proto.handleInput, patched, "a second copy does not wrap it again");
	await second.emit("session_shutdown", {}, TUI_CTX);
	assert.equal(proto.handleInput, patched, "and its shutdown leaves the first copy's patch");

	await host.emit("session_shutdown", {}, TUI_CTX);
	assert.equal(proto.handleInput, original);
	assert.equal(Object.hasOwn(proto, "addToHistory"), ownAddToHistory);
});

test("an editor class without what the patch needs is left alone", () => {
	const bare = { handleInput() {} };
	assert.equal(draft.installDraftHold(bare), undefined);
	assert.deepEqual(Object.keys(bare), ["handleInput"]);
});
