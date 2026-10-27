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

			// /pi_cc keys off: the panel and the command both go through here.
			config.saveConfig({ ccKeys: false });
			host.pi.events.emit("pi-cc:config", config.loadConfig());

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
		await host.emit("session_start", { reason: "startup" }, TUI_CTX);
		try {
			config.saveConfig({ draft: false });
			host.pi.events.emit("pi-cc:config", config.loadConfig());

			const ui = makeEditor();
			let queued = 0;
			ui.editor.onAction("app.message.followUp", () => {
				ui.editor.setText("");
				queued++;
			});
			ui.type("queue me");
			ui.press("\r");
			assert.equal(queued, 1, "Enter still queues");

			ui.type("held");
			ui.press(CTRL_C, UP);
			assert.equal(ui.editor.getText(), "", "nothing is held while the draft feature is off");
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
