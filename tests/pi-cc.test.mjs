/**
 * index.ts registers /pi_cc for this package: the shared settings command
 * from settings.ts (the same bytes as in pi-cc-loop and pi-cc-monitor). Only
 * the first pi-cc package to load gets the command, so a session never sees
 * /pi_cc:1 and /pi_cc:2.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fakePi, loadModule } from "./helpers.mjs";

const index = await loadModule("index.ts");
const settings = await loadModule("settings.ts");
const config = await loadModule("config.ts");
const claim = Symbol.for("pi-cc:slash-command");

function withTempConfig(body) {
	const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pi-cc-plugins-")), "pi-cc.json");
	const saved = process.env.PI_CC_CONFIG_FILE;
	process.env.PI_CC_CONFIG_FILE = file;
	config.invalidateConfig();
	return Promise.resolve(body(file)).finally(() => {
		process.env.PI_CC_CONFIG_FILE = saved;
		config.invalidateConfig();
	});
}

/** A context the command can notify through, with a panel the way ctx.ui.custom hands it out. */
function panelCtx(notifications) {
	let panel;
	const ctx = {
		mode: "tui",
		hasUI: true,
		ui: {
			notify: (message, level) => notifications.push({ message, level }),
			custom: (factory) =>
				new Promise((resolve) => {
					panel = factory({ requestRender: () => {} }, { fg: (_c, t) => t, bold: (t) => t }, {}, resolve);
				}),
		},
	};
	return { ctx, panel: () => panel };
}

test("the package registers /pi_cc; a later pi-cc package leaves it alone, shutdown re-opens the race", async () => {
	globalThis[claim] = undefined;
	try {
		const host = fakePi();
		index.default(host.pi);
		assert.ok(host.commands.has("pi_cc"), "/pi_cc is registered");
		assert.deepEqual(host.calls, [], "nothing beyond handlers, entries, renderers and commands");

		const other = fakePi();
		settings.registerPiCcCommand(other.pi, "pi-cc-loop");
		assert.ok(!other.commands.has("pi_cc"), "the claim keeps the command single");

		await host.emit("session_shutdown", {}, { mode: "tui", hasUI: false });
		const third = fakePi();
		settings.registerPiCcCommand(third.pi, "pi-cc-loop");
		assert.ok(third.commands.has("pi_cc"), "the claim is released at shutdown");
	} finally {
		globalThis[claim] = undefined;
	}
});

test("/pi_cc footer on|off writes the shared pi-cc.json and tells the other packages", async () => {
	await withTempConfig(async (file) => {
		const host = fakePi();
		index.default(host.pi);
		await host.commands.get("pi_cc").handler("footer off", panelCtx([]).ctx);
		assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).footer, false);
		assert.ok(host.busEvents.some((event) => event.channel === "pi-cc:config"), "the other packages are told");

		await host.commands.get("pi_cc").handler("settings footer on", { mode: "print", hasUI: false, ui: {} });
		assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).footer, true, "the old /loop settings wording still parses");
	});
});

test("a bare /pi_cc opens the panel; outside the TUI it prints the summary", async () => {
	await withTempConfig(async () => {
		const host = fakePi();
		index.default(host.pi);
		const notifications = [];
		const { ctx, panel } = panelCtx(notifications);
		const opened = host.commands.get("pi_cc").handler("", ctx);
		assert.ok(panel(), "the panel opened");
		assert.equal(notifications.length, 0, "no notice while the panel is up");
		panel().handleInput("\x1b"); // Esc closes
		await opened;

		await host.commands.get("pi_cc").handler("", { mode: "rpc", hasUI: true, ui: { notify: (m, l) => notifications.push({ m, l }) } });
		assert.match(notifications.at(-1).m, /pi-cc settings/);
	});
});

test("the panel carries the pi-cc-plugins toggles too, and /pi_cc draft off works", async () => {
	await withTempConfig(async () => {
		const host = fakePi();
		index.default(host.pi);
		const notifications = [];
		const { ctx, panel } = panelCtx(notifications);
		const opened = host.commands.get("pi_cc").handler("", ctx);
		assert.match(panel().render(100).join("\n"), /Draft recall +on/);
		assert.match(panel().render(100).join("\n"), /Turn summary +on/);
		panel().handleInput("\x1b");
		await opened;
	});
});

test("/pi_cc draft off and /pi_cc summary off write those keys", async () => {
	await withTempConfig(async (file) => {
		const host = fakePi();
		index.default(host.pi);
		const ctx = { mode: "print", hasUI: true, ui: { notify: () => {} } };
		await host.commands.get("pi_cc").handler("draft off", ctx);
		await host.commands.get("pi_cc").handler("summary off", ctx);
		assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { draft: false, turnSummary: false });
		const notices = [];
		const printCtx = { mode: "rpc", hasUI: true, ui: { notify: (m) => notices.push(m) } };
		await host.commands.get("pi_cc").handler("bogus", ctx);
		await host.commands.get("pi_cc").handler("", printCtx);
		assert.match(notices.at(-1), /draft: +off/);
		assert.match(notices.at(-1), /summary: +off/);
	});
});
