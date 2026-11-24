/**
 * cc-keys.ts and draft.ts both act on CustomEditor.handleInput. They share one
 * patch (input.ts) and add an interceptor each, so either feature can be
 * turned off without taking the other with it, in any order, and a session
 * that ends leaves Pi's method as it found it.
 *
 * Before the chain, each module wrapped the method itself and remembered "the
 * method as it was": with the CC keys off, Up no longer brought a cleared
 * draft back, and every reload left one more stale wrapper behind (both
 * reproduced against Pi 1.4.0's CustomEditor).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fakePi, loadModule, loadPi, TUI_CTX } from "./helpers.mjs";

const pi = await loadPi();
const index = await loadModule("index.ts");
const draft = await loadModule("draft.ts");
const keys = await loadModule("cc-keys.ts");
const config = await loadModule("config.ts");
const { CustomEditor } = pi.agent;
/** Pi's own method, before any test touches it. */
const PI_HANDLE_INPUT = CustomEditor.prototype.handleInput;

const CTRL_C = "\x03";
const UP = "\x1b[A";
const identity = (text) => text;
const editorTheme = {
	borderColor: identity,
	selectList: { selectedPrefix: identity, selectedText: identity, description: identity, scrollInfo: identity, noMatch: identity },
};

function makeEditor(bindings = {}) {
	const tui = { requestRender() {}, terminal: { rows: 40, columns: 100 } };
	const manager = new pi.KeybindingsManager(bindings);
	pi.tui.setKeybindings(manager);
	const editor = new CustomEditor(tui, editorTheme, manager);
	editor.onAction("app.clear", () => editor.setText(""));
	editor.onSubmit = (text) => editor.addToHistory(text);
	return {
		editor,
		manager,
		type: (text) => {
			for (const char of text) editor.handleInput(char);
		},
		press: (...sequence) => {
			for (const key of sequence) editor.handleInput(key);
		},
	};
}

/** A temp pi-cc.json, pointed at by PI_CC_CONFIG_FILE for the duration. */
function withConfig(initial, body) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cc-patching-"));
	const file = path.join(dir, "pi-cc.json");
	fs.writeFileSync(file, JSON.stringify(initial));
	const saved = process.env.PI_CC_CONFIG_FILE;
	process.env.PI_CC_CONFIG_FILE = file;
	config.invalidateConfig();
	return Promise.resolve(body(file)).finally(() => {
		if (saved === undefined) delete process.env.PI_CC_CONFIG_FILE;
		else process.env.PI_CC_CONFIG_FILE = saved;
		config.invalidateConfig();
		fs.rmSync(dir, { recursive: true, force: true });
	});
}

test("turning the CC keys off leaves Ctrl+C draft recall working", async () => {
	await withConfig({}, async () => {
		const host = fakePi();
		index.default(host.pi);
		await host.emit("session_start", { reason: "startup" }, TUI_CTX);
		try {
			const ui = makeEditor();
			ui.type("held");
			ui.press(CTRL_C, UP);
			assert.equal(ui.editor.getText(), "held", "with the keys on, both features work");

			// /plugins_settings keys off: the panel and the command both go through here.
			config.saveConfig({ ccKeys: false });
			host.pi.events.emit("pi-cc-plugins:config", config.loadConfig());

			ui.editor.setText("");
			ui.type("still held");
			ui.press(CTRL_C, UP);
			assert.equal(ui.editor.getText(), "still held", "the draft patch survived the keys being turned off");

			// And the keys are really off: Enter reaches the editor again.
			let submitted = 0;
			ui.editor.onSubmit = () => {
				submitted++;
			};
			ui.type("plain");
			ui.press("\r");
			assert.equal(submitted, 1, "Enter submits");
			assert.equal("app.message.followUp" in ui.manager.getUserBindings(), false, "the CC binding is gone");
		} finally {
			await host.emit("session_shutdown", {}, TUI_CTX);
		}
	});
});

test("turning the draft off leaves the CC keys working", async () => {
	await withConfig({}, async () => {
		const host = fakePi();
		index.default(host.pi);
		const TUI_WITH_QUEUE = { ...TUI_CTX, hasPendingMessages: () => true };
		await host.emit("session_start", { reason: "startup" }, TUI_WITH_QUEUE);
		try {
			config.saveConfig({ draft: false });
			host.pi.events.emit("pi-cc-plugins:config", config.loadConfig());

			const ui = makeEditor();
			let restored = 0;
			ui.editor.onAction("app.message.dequeue", () => {
				restored++;
				ui.editor.setText("queued message");
			});
			ui.press(UP);
			assert.equal(restored, 1, "Up still recalls a queued message");

			// The queue is drained now; Up must not keep restoring it below.
			ui.editor.onAction("app.message.dequeue", () => {});
			ui.editor.setText("");
			ui.type("held");
			ui.press(CTRL_C, UP);
			assert.equal(ui.editor.getText(), "", "nothing is held while the draft feature is off");
		} finally {
			await host.emit("session_shutdown", {}, TUI_CTX);
		}
	});
});

test("draft off/on through the config bus keeps the cleared draft before the queued message", async () => {
	await withConfig({}, async () => {
		const host = fakePi();
		index.default(host.pi);
		// A pending message makes cc-keys' Up recall compete with the held draft.
		await host.emit("session_start", { reason: "startup" }, { ...TUI_CTX, hasPendingMessages: () => true });
		try {
			config.saveConfig({ draft: false });
			host.pi.events.emit("pi-cc-plugins:config", config.loadConfig());
			config.saveConfig({ draft: true });
			host.pi.events.emit("pi-cc-plugins:config", config.loadConfig());
			const ui = makeEditor();
			ui.editor.onAction("app.message.dequeue", () => ui.editor.setText("queued message"));
			ui.type("cleared draft");
			ui.press(CTRL_C, UP);
			assert.equal(ui.editor.getText(), "cleared draft", "the draft still comes back before the queue");
		} finally {
			await host.emit("session_shutdown", {}, TUI_CTX);
		}
	});
});

test("keys off/on through the config bus under an external wrapper keeps draft priority", async () => {
	await withConfig({}, async () => {
		const original = CustomEditor.prototype.handleInput;
		const host = fakePi();
		index.default(host.pi);
		await host.emit("session_start", { reason: "startup" }, { ...TUI_CTX, hasPendingMessages: () => true });
		const inner = CustomEditor.prototype.handleInput;
		let calls = 0;
		CustomEditor.prototype.handleInput = function (data) {
			assert.ok(++calls < 200, "no runaway recursion through the external wrapper");
			inner.call(this, data);
		};
		try {
			config.saveConfig({ ccKeys: false });
			host.pi.events.emit("pi-cc-plugins:config", config.loadConfig());
			config.saveConfig({ ccKeys: true });
			host.pi.events.emit("pi-cc-plugins:config", config.loadConfig());
			const ui = makeEditor();
			ui.editor.onAction("app.message.dequeue", () => ui.editor.setText("queued message"));
			ui.type("cleared draft");
			ui.press(CTRL_C, UP);
			assert.equal(ui.editor.getText(), "cleared draft", "the draft still comes back first");
		} finally {
			CustomEditor.prototype.handleInput = inner;
			await host.emit("session_shutdown", {}, TUI_CTX);
			CustomEditor.prototype.handleInput = original;
		}
	});
});

test("an unrelated config toggle keeps the held draft and the user's keybindings", async () => {
	await withConfig({}, async () => {
		const host = fakePi();
		index.default(host.pi);
		await host.emit("session_start", { reason: "startup" }, TUI_CTX);
		try {
			const ui = makeEditor({ "tui.input.submit": ["enter", "ctrl+enter"] });
			ui.editor.onAction("app.message.dequeue", () => ui.editor.setText("queued message"));
			ui.type("held text");
			ui.press(CTRL_C);
			config.saveConfig({ turnSummary: false });
			host.pi.events.emit("pi-cc-plugins:config", config.loadConfig());
			assert.deepEqual(ui.manager.getUserBindings()["tui.input.submit"], ["enter", "ctrl+enter"], "the user's keymap is intact");
			ui.press(UP);
			assert.equal(ui.editor.getText(), "held text", "the held draft survives the toggle");
		} finally {
			await host.emit("session_shutdown", {}, TUI_CTX);
		}
	});
});

test("either patch can come off first, and Pi's method comes back", () => {
	// The order index.ts used before the chain: cc-keys on the inside.
	const unKeys = keys.installCcKeys(() => false);
	const unDraft = draft.installDraftHold();
	try {
		unKeys?.();
		assert.notEqual(CustomEditor.prototype.handleInput, PI_HANDLE_INPUT, "draft still patches the method");
		const ui = makeEditor();
		ui.type("held");
		ui.press(CTRL_C, UP);
		assert.equal(ui.editor.getText(), "held", "and still brings the draft back");
	} finally {
		unDraft?.();
	}
	assert.equal(CustomEditor.prototype.handleInput, PI_HANDLE_INPUT, "the last one off restores Pi's method");
});

test("each start and stop leaves the editor method as Pi left it", async () => {
	for (let cycle = 1; cycle <= 3; cycle++) {
		const host = fakePi();
		index.default(host.pi);
		await host.emit("session_start", { reason: "startup" }, TUI_CTX);
		await host.emit("session_shutdown", { reason: "reload" }, TUI_CTX);
		assert.equal(CustomEditor.prototype.handleInput, PI_HANDLE_INPUT, `cycle ${cycle} restored Pi's method`);
	}
});

test("Up brings the cleared draft back first, then the queued message", () => {
	const unDraft = draft.installDraftHold();
	const unKeys = keys.installCcKeys(() => true);
	try {
		const ui = makeEditor();
		ui.editor.onAction("app.message.dequeue", () => ui.editor.setText("queued message"));
		ui.type("cleared draft");
		ui.press(CTRL_C);
		ui.press(UP);
		assert.equal(ui.editor.getText(), "cleared draft", "the draft comes back first");
		ui.editor.setText("");
		ui.press(UP);
		assert.equal(ui.editor.getText(), "queued message", "then the queued message");
	} finally {
		unKeys?.();
		unDraft?.();
	}
});

test("a patch stacked on top plus a draft re-install does not loop the chain", () => {
	const unDraft = draft.installDraftHold();
	const unKeys = keys.installCcKeys(() => false);
	// A third party wraps handleInput on top of the chain.
	const inner = CustomEditor.prototype.handleInput;
	let outerCalls = 0;
	CustomEditor.prototype.handleInput = function (data) {
		outerCalls++;
		assert.ok(outerCalls < 50, "no runaway recursion through the third-party wrapper");
		inner.call(this, data);
	};
	try {
		// /plugins_settings draft off then on: draft re-installs into a NEW chain under the
		// third party, while cc-keys stays in the old one.
		unDraft?.();
		const unDraft2 = draft.installDraftHold();
		try {
			const ui = makeEditor();
			// Backslash + Enter: cc-keys takes the key over and asks for the
			// editor's own handling, which must be ITS chain's original.
			ui.type("one\\");
			ui.press("\r");
			assert.equal(ui.editor.getText(), "one\n", "Pi's newline fallback ran, once");
		} finally {
			unDraft2?.();
		}
	} finally {
		CustomEditor.prototype.handleInput = inner;
		unKeys?.();
	}
	assert.equal(CustomEditor.prototype.handleInput, PI_HANDLE_INPUT, "Pi's method is back");
});

test("a wrapper stacked on addToHistory stops injecting drafts once the feature is off", () => {
	const unDraft = draft.installDraftHold();
	// A third party wraps addToHistory on top of ours, so uninstall cannot
	// restore Pi's method and our wrapper keeps being called.
	const inner = CustomEditor.prototype.addToHistory;
	CustomEditor.prototype.addToHistory = function (text) {
		inner.call(this, text);
	};
	try {
		const ui = makeEditor();
		ui.type("secret draft");
		ui.press(CTRL_C);
		unDraft?.(); // /plugins_settings draft off
		ui.editor.addToHistory("sent prompt");
		assert.deepEqual(ui.editor.history, ["sent prompt"], "the cleared draft stays out of history while off");
	} finally {
		CustomEditor.prototype.addToHistory = inner;
		unDraft?.();
	}
});

test("one install's uninstall leaves another install's patch alone", () => {
	// Two sessions in one process: each installs on its own editor class.
	const makeProto = () => ({
		handleInput() {},
		isShowingAutocomplete: () => false,
		getText: () => "",
		setText() {},
	});
	const protoA = makeProto();
	const protoB = makeProto();
	const originalA = protoA.handleInput;
	const originalB = protoB.handleInput;
	const unA = keys.installCcKeys(() => false, protoA);
	const unB = keys.installCcKeys(() => false, protoB);
	try {
		assert.notEqual(protoA.handleInput, originalA, "the first install wrapped its own class");
		assert.notEqual(protoB.handleInput, originalB, "the second install wrapped its own class");
		unA?.();
		assert.equal(protoA.handleInput, originalA, "its own class is back to Pi's method");
		assert.notEqual(protoB.handleInput, originalB, "the other install keeps its wrapper");
	} finally {
		unA?.();
		unB?.();
	}
	assert.equal(protoB.handleInput, originalB, "and the last one off leaves Pi's method");
});
