/**
 * cc-keys.ts: Claude Code's prompt keys in Pi — Enter queues while a run is
 * streaming, Ctrl+Enter sends now, and the slash menu keeps Enter.
 *
 * The tests drive Pi's real CustomEditor; the follow-up action is wired the way
 * InteractiveMode wires it (queue while streaming, submit when idle).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fakePi, loadModule, loadPi, TUI_CTX } from "./helpers.mjs";

const pi = await loadPi();
const keys = await loadModule("cc-keys.ts");
const config = await loadModule("config.ts");
const { CustomEditor } = pi.agent;

const OWNER = Symbol.for("pi-cc-plugins:cc-keys-owner");

/** A stand-in for the session's two queues, wired as Pi's are. */
function fakeSession({ steering = [], followUp = [] } = {}) {
	const state = { steering: [...steering], followUp: [...followUp] };
	return {
		state,
		session: {
			clearQueue: () => {
				const held = { steering: [...state.steering], followUp: [...state.followUp] };
				state.steering = [];
				state.followUp = [];
				return held;
			},
			steer: (text) => {
				state.steering.push(text);
			},
			followUp: (text) => {
				state.followUp.push(text);
			},
		},
	};
}

const ENTER = "\r";
const ALT_ENTER = "\x1b\r";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ALT_UP = "\x1b[1;3A";
const CTRL_ENTER = "\x1b[13;5u";

const identity = (text) => text;
const editorTheme = {
	borderColor: identity,
	selectList: { selectedPrefix: identity, selectedText: identity, description: identity, scrollInfo: identity, noMatch: identity },
};

function makeEditor(bindings = {}, { streaming = true } = {}) {
	const tui = { requestRender() {}, terminal: { rows: 40, columns: 100 } };
	const manager = new pi.KeybindingsManager(bindings);
	// Pi hands the same manager to the editor and to the TUI singleton the
	// editor's own key handling reads (setKeybindings in InteractiveMode).
	pi.tui.setKeybindings(manager);
	const editor = new CustomEditor(tui, editorTheme, manager);
	const calls = { queue: 0, submit: 0 };
	let working = streaming;
	// InteractiveMode.handleFollowUp: queue while streaming, submit when idle.
	editor.onAction("app.message.followUp", () => {
		if (editor.getText().trim() === "") return;
		editor.setText("");
		if (working) calls.queue++;
		else calls.submit++;
	});
	editor.onSubmit = () => {
		calls.submit++;
	};
	return {
		editor,
		manager,
		calls,
		setWorking: (value) => {
			working = value;
		},
		type: (text) => {
			for (const char of text) editor.handleInput(char);
		},
		press: (...sequence) => {
			for (const key of sequence) editor.handleInput(key);
		},
	};
}

/** Install the patch for the duration of one test, and take it off again. */
function withKeys(body) {
	const uninstall = keys.installCcKeys();
	assert.ok(uninstall, "the patch installed");
	try {
		return body();
	} finally {
		uninstall();
	}
}

test("Pi alone: Enter submits, Alt+Enter queues", () => {
	const { editor, calls, type, press } = makeEditor();
	type("hi");
	press(ENTER);
	assert.deepEqual(calls, { queue: 0, submit: 1 });

	type("later");
	press(ALT_ENTER);
	assert.deepEqual(calls, { queue: 1, submit: 1 });
	assert.equal(editor.getText(), "");
});

test("patched: Enter queues while a run streams, Ctrl+Enter sends now", () =>
	withKeys(() => {
		const { calls, type, press } = makeEditor();
		type("queue me");
		press(ENTER);
		assert.deepEqual(calls, { queue: 1, submit: 0 }, "Enter queues");

		type("send me");
		press(CTRL_ENTER);
		assert.deepEqual(calls, { queue: 1, submit: 1 }, "Ctrl+Enter submits");
	}));

test("patched: when idle, Enter still submits (the queue action falls back)", () =>
	withKeys(() => {
		const { calls, type, press, setWorking } = makeEditor({}, { streaming: false });
		setWorking(false);
		type("just send");
		press(ENTER);
		assert.deepEqual(calls, { queue: 0, submit: 1 });
	}));

test("patched: a backslash before Enter still continues the line instead of sending", () =>
	withKeys(() => {
		const { editor, calls, type, press } = makeEditor();
		type("one\\");
		press(ENTER);
		assert.equal(editor.getText(), "one\n", "Pi's fallback for terminals without Shift+Enter");
		assert.deepEqual(calls, { queue: 0, submit: 0 }, "nothing was sent");
	}));

test("patched: the slash menu keeps Enter — it confirms, then runs the command", () =>
	withKeys(() => {
		const { editor, calls } = makeEditor();
		let applied = 0;
		let submitted;
		editor.onSubmit = (text) => {
			calls.submit++;
			submitted = text;
		};
		editor.setText("/");
		editor.autocompletePrefix = "/";
		editor.autocompleteState = "regular";
		editor.autocompleteList = {
			handleInput() {},
			getSelectedItem: () => ({ value: "/settings", label: "settings" }),
		};
		editor.autocompleteProvider = {
			applyCompletion: () => {
				applied++;
				return { lines: ["/settings"], cursorLine: 0, cursorCol: 9 };
			},
		};
		editor.handleInput(ENTER);
		assert.equal(applied, 1, "the completion was applied");
		assert.equal(submitted, "/settings", "and the same Enter submitted the command, as Pi does");
		assert.deepEqual(calls, { queue: 0, submit: 1 }, "the queue action never saw it");
		assert.equal(editor.getText(), "", "the editor is cleared, as after any submit");
	}));

test("patched: an editor that disables submit applies the completion but submits nothing", () =>
	withKeys(() => {
		const { editor, calls } = makeEditor();
		let applied = 0;
		editor.disableSubmit = true;
		editor.setText("/");
		editor.autocompletePrefix = "/";
		editor.autocompleteState = "regular";
		editor.autocompleteList = {
			handleInput() {},
			getSelectedItem: () => ({ value: "/settings", label: "settings" }),
		};
		editor.autocompleteProvider = {
			applyCompletion: () => {
				applied++;
				return { lines: ["/settings"], cursorLine: 0, cursorCol: 9 };
			},
		};
		editor.handleInput(ENTER);
		assert.equal(applied, 1);
		assert.deepEqual(calls, { queue: 0, submit: 0 });
		assert.equal(editor.getText(), "/settings");
	}));

test("patched: a keymap the user wrote is left alone", () =>
	withKeys(() => {
		const { editor, manager, calls, type, press } = makeEditor({ "tui.input.submit": "enter" });
		type("mine");
		press(ENTER);
		assert.deepEqual(calls, { queue: 0, submit: 1 }, "Enter stayed submit");
		assert.equal("app.message.followUp" in manager.getUserBindings(), false);
	}));

test("patched: an editor that disables submit neither queues nor restores", () =>
	withKeys(() => {
		const { editor, calls, type } = makeEditor();
		let restores = 0;
		editor.onAction("app.message.dequeue", () => {
			restores++;
		});
		editor.disableSubmit = true;
		type("not for you");
		editor.handleInput(ENTER);
		assert.deepEqual(calls, { queue: 0, submit: 0 });
		editor.setText("");
		editor.handleInput(UP);
		assert.equal(restores, 0, "Up stays with the prompt");
	}));

test("uninstall gives Pi's keys back", () => {
	const { manager, calls, type, press } = makeEditor();
	const uninstall = keys.installCcKeys();
	type("while patched");
	press(ENTER);
	assert.deepEqual(calls, { queue: 1, submit: 0 });
	uninstall?.();
	type("after");
	press(ENTER);
	assert.deepEqual(calls, { queue: 1, submit: 1 }, "Enter submits again");
	assert.equal("tui.input.submit" in manager.getUserBindings(), false);
});

test("patched: Up on the empty editor restores the queued message, as CC does", () => {
	const { editor, calls, press } = makeEditor();
	let restores = 0;
	editor.onAction("app.message.dequeue", () => {
		restores++;
		editor.setText("queued message");
	});
	const uninstall = keys.installCcKeys(() => true);
	try {
		press(UP);
		assert.equal(restores, 1, "the dequeue action ran");
		assert.equal(editor.getText(), "queued message");
		assert.deepEqual(calls, { queue: 0, submit: 0 });
	} finally {
		uninstall();
	}
});

test("patched: Up with nothing queued falls through to Pi's history", () => {
	const { editor, press } = makeEditor();
	let restores = 0;
	editor.onAction("app.message.dequeue", () => {
		restores++;
	});
	const uninstall = keys.installCcKeys(() => false);
	try {
		press(UP);
		assert.equal(restores, 0);
		assert.equal(editor.getText(), "");
	} finally {
		uninstall();
	}
});

test("patched: Up with text in the editor never restores the queue", () => {
	const { editor, type, press } = makeEditor();
	let restores = 0;
	editor.onAction("app.message.dequeue", () => {
		restores++;
	});
	const uninstall = keys.installCcKeys(() => true);
	try {
		type("typing");
		press(UP);
		assert.equal(restores, 0);
		assert.equal(editor.getText(), "typing");
	} finally {
		uninstall();
	}
});

test("patched: Down after a recall puts the empty prompt back, as after browsing history", () => {
	for (const [name, recall] of [
		["Up", UP],
		["Alt+Up", ALT_UP],
	]) {
		const { editor, press } = makeEditor();
		editor.onAction("app.message.dequeue", () => editor.setText("queued message"));
		const uninstall = keys.installCcKeys(() => true);
		try {
			press(recall);
			assert.equal(editor.getText(), "queued message", name);
			press(DOWN);
			assert.equal(editor.getText(), "", `${name} then Down clears the prompt`);
		} finally {
			uninstall();
		}
	}
});

test("patched: Down after Alt+Up with text in the editor brings that text back", () => {
	const { editor, type, press } = makeEditor();
	editor.onAction("app.message.dequeue", () => {
		editor.setText(["queued message", editor.getText()].filter((text) => text.trim()).join("\n\n"));
	});
	const uninstall = keys.installCcKeys(() => true);
	try {
		type("my draft");
		press(ALT_UP);
		assert.equal(editor.getText(), "queued message\n\nmy draft");
		press(DOWN);
		assert.equal(editor.getText(), "my draft", "the text that was there comes back");
	} finally {
		uninstall();
	}
});

test("patched: Down leaves a restored message that was edited", () => {
	const { editor, type, press } = makeEditor();
	editor.onAction("app.message.dequeue", () => editor.setText("queued message"));
	const uninstall = keys.installCcKeys(() => true);
	try {
		press(UP);
		type("!");
		press(DOWN);
		assert.equal(editor.getText(), "queued message!");
	} finally {
		uninstall();
	}
});

test("patched: Down ends a multi-line history recall in one press", () => {
	const { editor, press } = makeEditor();
	editor.addToHistory("one\ntwo");
	const uninstall = keys.installCcKeys(() => false);
	try {
		press(UP);
		assert.equal(editor.getText(), "one\ntwo");
		press(DOWN);
		assert.equal(editor.getText(), "");
	} finally {
		uninstall();
	}
});

test("patched: history browsing still clears on Down", () => {
	const { editor, press, calls } = makeEditor();
	editor.addToHistory("an older prompt");
	const uninstall = keys.installCcKeys(() => false);
	try {
		press(UP);
		assert.equal(editor.getText(), "an older prompt");
		press(DOWN);
		assert.equal(editor.getText(), "", "the editor's own history handling still runs");
		assert.deepEqual(calls, { queue: 0, submit: 0 });
	} finally {
		uninstall();
	}
});

test("the shared setting turns it off", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cc-keys-"));
	const file = path.join(dir, "pi-cc.json");
	fs.writeFileSync(file, JSON.stringify({ ccKeys: false }));
	const previous = process.env.PI_CC_CONFIG_FILE;
	process.env.PI_CC_CONFIG_FILE = file;
	config.invalidateConfig();
	const host = fakePi();
	keys.default(host.pi);
	try {
		await host.emit("session_start", { reason: "startup" }, TUI_CTX);
		const { calls, type, press } = makeEditor();
		type("plain");
		press(ENTER);
		assert.deepEqual(calls, { queue: 0, submit: 1 }, "no patch: Enter submits");
	} finally {
		await host.emit("session_shutdown", {}, TUI_CTX);
		if (previous === undefined) delete process.env.PI_CC_CONFIG_FILE;
		else process.env.PI_CC_CONFIG_FILE = previous;
		config.invalidateConfig();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
