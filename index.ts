/**
 * pi-cc-plugins — small Claude Code behaviours for the Pi coding agent.
 *
 * One entry point, so the package shows as one line in `pi config` and one
 * name in the startup banner, like pi-cc-loop. The features live apart:
 *
 *   draft.ts         Ctrl+C keeps the cleared prompt; Up puts it back
 *   recall.ts        Down on a text Up put back restores the prompt
 *   turn-summary.ts  one line closes every agent run
 *   cc-keys.ts       Enter queues while Pi works; Up recalls queued messages
 */
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import ccKeysExtension from "./cc-keys.ts";
import { invalidateConfig } from "./config.ts";
import draftExtension from "./draft.ts";
import { CONFIG_CHANNEL, registerPiCcCommand } from "./settings.ts";
import turnSummary from "./turn-summary.ts";

export default function piCcPlugins(pi: ExtensionAPI): void {
	// Another pi-cc package changed the shared settings: the features read
	// them again. Each feature listened for itself before; the one cache the
	// two share makes one listener the honest shape.
	// draft first: interceptors see a key in registration order, so Up on the
	// empty editor brings back what Ctrl+C just cleared before cc-keys reaches
	// for an older queued message.
	const redraft = draftExtension(pi);
	const rekey = ccKeysExtension(pi);
	turnSummary(pi);
	pi.events.on(CONFIG_CHANNEL, () => {
		invalidateConfig();
		redraft();
		rekey();
	});
	// The shared pi-cc settings and their /pi_cc command. The first pi-cc
	// package to load registers it; this one re-claims its own claim on /reload.
	registerPiCcCommand(pi, "pi-cc-plugins");
}
