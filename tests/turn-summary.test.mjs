/**
 * turn-summary.ts: one line at every agent_end, in the format of
 * pi-cc-extensions' agent-summary, with the completion part of #82/#83:
 *
 *   > *Ran 3 commands, read 2 files · Completed for 42s · done 6:51 PM*   (2+ tool calls)
 *   > *Completed for 11s · done 6:51 PM*                                  (fewer)
 *   > *Interrupted for 3s · done 6:51 PM*                                 (aborted, e.g. Escape)
 *
 * The duration and the clock's digits are painted in Claude Code's own
 * orange (rgb(215,119,87)); the AM/PM suffix keeps the line's colour. The
 * verb follows the run's outcome: Completed, Interrupted (aborted) or
 * Failed (error).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { fakePi, loadModule, loadPi, stripAnsi } from "./helpers.mjs";

const pi = await loadPi();
const summary = await loadModule("turn-summary.ts");
const { TURN_SUMMARY_ENTRY_TYPE, summaryMarkdown, formatDuration, formatDoneClock } = summary;

/** 6:51:00 PM local time, whatever the time zone. */
const DONE = new Date(2026, 9, 23, 18, 51, 0).getTime();

let callId = 0;
async function tool(host, toolName, args = {}, isError = false) {
	const toolCallId = `call-${++callId}`;
	await host.emit("tool_execution_start", { toolCallId, toolName, args });
	await host.emit("tool_execution_end", { toolCallId, toolName, result: {}, isError });
}

test("every agent_end writes one entry; the tool part needs 2+ tool calls", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: DONE - 11_000 });
	const host = fakePi();
	summary.default(host.pi);

	await host.emit("agent_start");
	await tool(host, "bash", { command: "ls" });
	t.mock.timers.tick(11_000);
	await host.emit("agent_end", { messages: [] });
	assert.equal(host.entries.length, 1);
	assert.equal(host.entries[0].customType, TURN_SUMMARY_ENTRY_TYPE);
	assert.equal(summaryMarkdown(host.entries[0].data), "> *Completed for 11s · done 6:51 PM*");

	t.mock.timers.tick(18_000);
	await host.emit("agent_start");
	for (let i = 0; i < 3; i++) await tool(host, "bash", { command: `echo ${i}` });
	await tool(host, "read", { path: "a.ts" });
	await tool(host, "read", { path: "b.ts" });
	t.mock.timers.tick(42_000);
	await host.emit("agent_end", { messages: [] });
	assert.equal(host.entries.length, 2);
	assert.equal(
		summaryMarkdown(host.entries[1].data),
		"> *Ran 3 commands, read 2 files · Completed for 42s · done 6:52 PM*",
		"a new agent_start counts afresh",
	);
});

test("the tool part counts like agent-summary: commands by call, files by distinct path, other tools by call, failures apart", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: DONE - 42_000 });
	const host = fakePi();
	summary.default(host.pi);
	await host.emit("agent_start");
	await tool(host, "bash", { command: "ls" });
	await tool(host, "powershell", { command: "dir" }, true);
	await tool(host, "read", { path: "a.ts" });
	await tool(host, "read", { path: "a.ts" });
	await tool(host, "read", { file_path: "b.ts" });
	await tool(host, "edit", { path: "a.ts" });
	await tool(host, "write", { path: "c.ts" });
	await tool(host, "mcp.github.search", { q: "x" });
	await tool(host, "grep", { pattern: "x" });
	t.mock.timers.tick(42_000);
	await host.emit("agent_end", { messages: [] });
	assert.equal(
		summaryMarkdown(host.entries[0].data),
		"> *Ran 2 commands, read 2 files, edited 1 file, wrote 1 file, 2 other tools, 1 failed · Completed for 42s · done 6:51 PM*",
	);
});

test("an interrupted run still gets its line, as in #83, and reads Interrupted, not Completed", async () => {
	const host = fakePi();
	summary.default(host.pi);
	await host.emit("agent_start");
	await host.emit("agent_end", { messages: [{ role: "assistant", stopReason: "aborted", content: [] }] });
	assert.equal(host.entries.length, 1);
	assert.equal(host.entries[0].data.outcome, "aborted");
	assert.match(summaryMarkdown(host.entries[0].data), /^> \*Interrupted for 0s · done \d{1,2}:\d{2} [AP]M\*$/);
});

test("the verb follows the run's outcome, taken from the last assistant message", async () => {
	const host = fakePi();
	summary.default(host.pi);
	await host.emit("agent_start");
	await host.emit("agent_end", { messages: [{ role: "assistant", stopReason: "error", content: [] }] });
	await host.emit("agent_start");
	await host.emit("agent_end", {
		messages: [
			{ role: "assistant", stopReason: "end", content: [] },
			{ role: "user", content: [] },
			{ role: "assistant", stopReason: "aborted", content: [] },
		],
	});
	await host.emit("agent_start");
	// Tool results follow the assistant message; the last assistant still decides.
	await host.emit("agent_end", {
		messages: [
			{ role: "user", content: [] },
			{ role: "assistant", stopReason: "end", content: [] },
			{ role: "user", content: [] },
		],
	});
	assert.equal(host.entries.length, 3);
	assert.match(summaryMarkdown(host.entries[0].data), /^> \*Failed for 0s/);
	assert.match(summaryMarkdown(host.entries[1].data), /^> \*Interrupted for 0s/);
	assert.match(summaryMarkdown(host.entries[2].data), /^> \*Completed for 0s/);
});

test("durations read 1h 2m 3s / 1m 1s / 1s, under a second 0s; the clock is en-US h:mm AM/PM", () => {
	assert.equal(formatDuration(999), "");
	assert.equal(formatDuration(1_000), "1s");
	assert.equal(formatDuration(61_000), "1m 1s");
	assert.equal(formatDuration(3_723_000), "1h 2m 3s");
	assert.equal(formatDoneClock(DONE), "6:51 PM");
	assert.equal(formatDoneClock(new Date(2026, 9, 23, 0, 5).getTime()), "12:05 AM");
	assert.equal(formatDoneClock(new Date(2026, 9, 23, 12, 0).getTime()), "12:00 PM");
	const data = { toolCount: 0, commands: 0, reads: 0, edits: 0, writes: 0, others: 0, failed: 0, durationMs: 300, doneAt: DONE };
	assert.equal(summaryMarkdown(data), "> *Completed for 0s · done 6:51 PM*");
});

test("it is drawn the way agent-summary draws: a markdown quote in italics, counts in the success and error colours, duration and clock in Claude Code's orange", async () => {
	pi.agent.initTheme("dark", false);
	const host = fakePi();
	summary.default(host.pi);
	const renderer = host.renderers.get(TURN_SUMMARY_ENTRY_TYPE);
	assert.ok(renderer, "a renderer for its entries");
	const data = { toolCount: 3, commands: 2, reads: 0, edits: 0, writes: 0, others: 0, failed: 1, durationMs: 42_000, doneAt: DONE, outcome: "completed" };
	assert.equal(
		summaryMarkdown(data, { success: "<s>", failed: "<f>", accent: "<o>" }),
		"> *Ran <s>2\x1b[0m commands, <f>1\x1b[0m failed · Completed for <o>42s\x1b[0m · done <o>6:51\x1b[0m PM*",
	);

	const theme = { getFgAnsi: (color) => ({ success: "\x1b[32m", error: "\x1b[31m" })[color] ?? "" };
	const entry = { type: "custom", customType: TURN_SUMMARY_ENTRY_TYPE, data, id: "e1", parentId: null, timestamp: "" };
	const component = renderer(entry, {}, theme);
	assert.ok(component instanceof pi.tui.Markdown, "the same Markdown component agent-summary uses");
	const raw = component.render(120).join("\n");
	assert.match(stripAnsi(raw), /Ran 2 commands, 1 failed · Completed for 42s · done 6:51 PM/);
	assert.match(raw, /\x1b\[32m2/, "the command count in the success colour");
	assert.match(raw, /\x1b\[31m1/, "the failure count in the error colour");
	assert.match(raw, /\x1b\[38;2;215;119;87m42s/, "the duration in Claude Code's orange");
	assert.match(raw, /\x1b\[38;2;215;119;87m6:51\b/, "the clock's digits in Claude Code's orange");
	assert.doesNotMatch(raw, /\x1b\[38;2;215;119;87m[\d: ]*PM/, "the AM/PM suffix is not orange");
	assert.equal(renderer({ ...entry, data: undefined }, {}, theme), undefined, "nothing to draw without data");
});
