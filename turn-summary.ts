/**
 * One line closes every agent run: the tools it used, how long it took and
 * when it finished.
 *
 *   > *Ran 3 commands, read 2 files · Completed for 42s · done 6:51 PM*   (2+ tool calls)
 *   > *Completed for 11s · done 6:51 PM*                                  (fewer)
 *   > *Interrupted for 3s · done 6:51 PM*                                 (aborted, e.g. Escape)
 *
 * The verb follows the run's outcome — Completed, Interrupted (aborted, for
 * example Escape) or Failed (error) — taken from the last assistant message
 * at agent_end. The duration and the clock are painted in Claude Code's own
 * orange, rgb(215,119,87), the colour of its wordmark and spinner.
 *
 * This is pi-cc-extensions' agent-summary with the completion part of #82/#83,
 * in agent-summary's own format: a markdown quote in italics, drawn in the
 * theme's quote colour, with the counts in the success and error colours. It
 * replaces agent-summary, so turn that off in pi-cc-extensions
 * (enableAgentSummary: false), or both lines show.
 *
 * Written at every agent_end, interrupted runs included, with no minimum
 * duration and nothing special for loops or monitors (as #83). appendEntry
 * keeps it out of the model's context: it is only drawn in the chat. The
 * shared `turnSummary` setting (pi-cc.json, /pi_cc) switches the line off;
 * saveConfig drops the config cache, so a toggle from the panel applies to
 * the very next run.
 * keeps it out of the model's context: it is only drawn in the chat.
 *
 * Tool statistics follow agent-summary (pi-cc-extensions, MIT, © 2026
 * minuque): bash/powershell count calls, read/edit/write count distinct paths,
 * other tools count calls, failures are counted apart.
 */

import { getMarkdownTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import { loadConfig } from "./config.ts";

export const TURN_SUMMARY_ENTRY_TYPE = "pi-cc-turn-summary";

/** One entry's data. */
export interface TurnSummaryData {
	toolCount: number;
	commands: number;
	reads: number;
	edits: number;
	writes: number;
	others: number;
	failed: number;
	durationMs: number;
	doneAt: number;
	/** How the run ended: aborted reads Interrupted, error reads Failed. */
	outcome: TurnOutcome;
}

/** As Pi's AgentActivityOutcome: how an agent run ended. */
export type TurnOutcome = "completed" | "aborted" | "error";

type ToolCategory = "bash" | "read" | "edit" | "write" | "other";

/** By exact name; an MCP-style name (server.tool) goes by its last part. */
function classifyTool(toolName: string): ToolCategory {
	const base = toolName.split(".").pop() ?? toolName;
	if (base === "bash" || base === "powershell") return "bash";
	if (base === "read" || base === "edit" || base === "write") return base;
	return "other";
}

function toolPath(args: unknown): string | undefined {
	if (!args || typeof args !== "object") return undefined;
	const { path, file_path } = args as { path?: unknown; file_path?: unknown };
	const value = path ?? file_path;
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** One agent run's counts; agent_start starts the next. */
export class TurnStats {
	toolCount = 0;
	commands = 0;
	readonly reads = new Set<string>();
	readonly edits = new Set<string>();
	readonly writes = new Set<string>();
	others = 0;
	failed = 0;
	readonly startedAt: number;

	constructor(startedAt = Date.now()) {
		this.startedAt = startedAt;
	}

	recordToolStart(toolName: string, args: unknown): void {
		this.toolCount++;
		const path = toolPath(args);
		switch (classifyTool(toolName)) {
			case "bash":
				this.commands++;
				break;
			case "read":
				if (path) this.reads.add(path);
				break;
			case "edit":
				if (path) this.edits.add(path);
				break;
			case "write":
				if (path) this.writes.add(path);
				break;
			default:
				this.others++;
		}
	}

	recordToolResult(isError: boolean): void {
		if (isError) this.failed++;
	}

	snapshot(now = Date.now(), outcome: TurnOutcome = "completed"): TurnSummaryData {
		return {
			toolCount: this.toolCount,
			commands: this.commands,
			reads: this.reads.size,
			edits: this.edits.size,
			writes: this.writes.size,
			others: this.others,
			failed: this.failed,
			durationMs: now - this.startedAt,
			doneAt: now,
			outcome,
		};
	}
}

/** The run's outcome, from its last assistant message, as Pi decides it. */
function runOutcome(messages: ReadonlyArray<{ role?: string; stopReason?: string }>): TurnOutcome {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role !== "assistant") continue;
		if (message.stopReason === "aborted") return "aborted";
		if (message.stopReason === "error") return "error";
		return "completed";
	}
	return "completed";
}

/** `1h 2m 3s`, `1m 5s`, `42s`; empty under a second (as agent-summary). */
export function formatDuration(ms: number): string {
	const totalSec = Math.floor(ms / 1000);
	if (totalSec < 1) return "";
	const hours = Math.floor(totalSec / 3600);
	const minutes = Math.floor((totalSec % 3600) / 60);
	const seconds = totalSec % 60;
	if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
	if (minutes > 0) return `${minutes}m ${seconds}s`;
	return `${seconds}s`;
}

/** `6:51 PM`: en-US, as Claude Code shows it. */
export function formatDoneClock(doneAt: number): string {
	const date = new Date(doneAt);
	if (Number.isNaN(date.getTime())) return "";
	return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).replace(/\u202f/g, " ");
}

export interface SummaryColors {
	/** ANSI colour for the counts. */
	success: string;
	/** ANSI colour for the failure count. */
	failed: string;
	/** ANSI colour for the duration and the clock. */
	accent?: string;
}

const plural = (count: number) => (count === 1 ? "" : "s");

/** agent-summary's parts, in its order. */
function toolParts(data: TurnSummaryData): string[] {
	const parts: string[] = [];
	if (data.commands) parts.push(`ran ${data.commands} command${plural(data.commands)}`);
	if (data.reads) parts.push(`read ${data.reads} file${plural(data.reads)}`);
	if (data.edits) parts.push(`edited ${data.edits} file${plural(data.edits)}`);
	if (data.writes) parts.push(`wrote ${data.writes} file${plural(data.writes)}`);
	if (data.others) parts.push(`${data.others} other tool${plural(data.others)}`);
	if (data.failed) parts.push(`${data.failed} failed`);
	return parts;
}

/** As agent-summary: the first verb capitalised, each count painted, joined by commas. */
function toolText(data: TurnSummaryData, colors: SummaryColors): string {
	const capitalize = (part: string) => {
		const verb = part.match(/^[a-z]+/)?.[0] ?? "";
		return verb ? verb[0].toUpperCase() + part.slice(1) : part;
	};
	const paint = (code: string, part: string) => (code ? part.replace(/(\d+)/, `${code}$1\x1b[0m`) : part);
	return toolParts(data)
		.map((part, index) => (index === 0 ? capitalize(part) : part))
		.map((part) => paint(part.endsWith("failed") ? colors.failed : colors.success, part))
		.join(", ");
}

/** The completion part: `Interrupted for 3s · done 6:51 PM`, the verb from the outcome. */
function completionText(data: TurnSummaryData, accent: string): string {
	const verb = data.outcome === "aborted" ? "Interrupted" : data.outcome === "error" ? "Failed" : "Completed";
	const paint = (text: string) => (accent ? `${accent}${text}\x1b[0m` : text);
	const duration = paint(formatDuration(data.durationMs) || "0s");
	const clock = formatDoneClock(data.doneAt);
	// "6:51 PM": the digits take the accent, the AM/PM suffix keeps the line's colour.
	const split = clock.match(/^(.*\d)(\s*[AP]M)$/);
	const clockPainted = split
		? `${paint(split[1])}${split[2]}`
		: clock
			? paint(clock)
			: "";
	return `${verb} for ${duration}${clockPainted ? ` · done ${clockPainted}` : ""}`;
}

/** The line as markdown: `> *tools · Completed for 42s · done 6:51 PM*`. */
export function summaryMarkdown(data: TurnSummaryData, colors: SummaryColors = { success: "", failed: "" }): string {
	const parts: string[] = [];
	if (data.toolCount >= 2) {
		const tools = toolText(data, colors);
		if (tools) parts.push(tools);
	}
	parts.push(completionText(data, colors.accent ?? ""));
	return `> *${parts.join(" · ")}*`;
}

export default function turnSummary(pi: ExtensionAPI): void {
	/** Claude Code's own orange: the "claude" colour, rgb(215,119,87). */
	const ccOrange = "\x1b[38;2;215;119;87m";
	pi.registerEntryRenderer<TurnSummaryData>(TURN_SUMMARY_ENTRY_TYPE, (entry, _options, theme) => {
		if (!entry.data) return undefined;
		const colors = { success: theme.getFgAnsi("success"), failed: theme.getFgAnsi("error"), accent: ccOrange };
		return new Markdown(summaryMarkdown(entry.data, colors), 1, 0, getMarkdownTheme());
	});

	let stats = new TurnStats();
	pi.on("agent_start", () => {
		stats = new TurnStats();
	});
	pi.on("tool_execution_start", (event) => {
		stats.recordToolStart(event.toolName, event.args);
	});
	pi.on("tool_execution_end", (event) => {
		stats.recordToolResult(event.isError === true);
	});
	pi.on("agent_end", (event) => {
		if (!loadConfig().turnSummary) return;
		pi.appendEntry(TURN_SUMMARY_ENTRY_TYPE, stats.snapshot(Date.now(), runOutcome(event.messages)));
	});
}
