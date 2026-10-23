/**
 * pi-cc-plugins — small Claude Code behaviours for the Pi coding agent.
 *
 * One entry point, so the package shows as one line in `pi config` and one
 * name in the startup banner, like pi-cc-loop. The features live apart:
 *
 *   draft.ts         Ctrl+C keeps the cleared prompt; Up puts it back
 *   turn-summary.ts  one line closes every agent run
 */
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import draftExtension from "./draft.ts";
import { registerPiCcCommand } from "./settings.ts";
import turnSummary from "./turn-summary.ts";

export default function piCcPlugins(pi: ExtensionAPI): void {
	draftExtension(pi);
	turnSummary(pi);
	// The shared pi-cc settings and their /pi_cc command. The first pi-cc
	// package to load registers it; this one re-claims its own claim on /reload.
	registerPiCcCommand(pi, "pi-cc-plugins");
}
