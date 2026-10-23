/**
 * Prompt cache: neither extension changes what the model sees. Caching matches
 * on the prefix (tools, then the system prompt, then the messages), so an
 * extension must not touch the system prompt, the tools or the history.
 *
 * - draft.ts works only in the editor; it listens to session start and end.
 * - turn-summary.ts writes a custom entry with appendEntry: drawn in the chat,
 *   never sent to the model. Checked against Pi's own session context builder.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { fakePi, loadModule, loadPi, TUI_CTX } from "./helpers.mjs";

const pi = await loadPi();

/** The events each one listens to, in the order Pi fires them. */
const EXTENSIONS = {
	"draft.ts": ["session_start", "session_shutdown"],
	"turn-summary.ts": ["agent_start", "tool_execution_start", "tool_execution_end", "agent_end"],
};

for (const [file, events] of Object.entries(EXTENSIONS)) {
	test(`${file}: only events that cannot change the model's view, no API that can, and handlers return nothing`, async () => {
		const mod = await loadModule(file);
		const host = fakePi();
		mod.default(host.pi);
		assert.deepEqual([...host.handlers.keys()].sort(), [...events].sort());
		for (const event of events) {
			const results = await host.emit(event, { toolName: "bash", args: {}, toolCallId: "c1", messages: [] }, TUI_CTX);
			assert.ok(
				results.every((result) => result === undefined),
				`${event}: a handler result could change the request`,
			);
		}
		assert.deepEqual(host.calls, [], "no sendMessage, tools, commands or system prompt");
	});
}

test("the turn summary entry stays out of the model's context", async () => {
	const { TURN_SUMMARY_ENTRY_TYPE } = await loadModule("turn-summary.ts");
	const { SessionManager, buildSessionContext } = pi.agent;
	const session = SessionManager.inMemory("/tmp");
	session.appendMessage({ role: "user", content: "hi", timestamp: Date.now() });
	const before = buildSessionContext(session.getEntries()).messages;
	session.appendCustomEntry(TURN_SUMMARY_ENTRY_TYPE, { toolCount: 0, durationMs: 1000, doneAt: Date.now() });
	const after = buildSessionContext(session.getEntries()).messages;
	assert.equal(session.getEntries().at(-1).customType, TURN_SUMMARY_ENTRY_TYPE, "the entry is in the session");
	assert.deepEqual(after, before, "but not in what the model sees");
});
