/**
 * The Pi internals this package patches, checked against the Pi it runs on.
 *
 * cc-keys wraps `CustomEditor.handleInput` to put Enter's queue/submit decision in
 * front of Pi's own key handling. The patch guards with `typeof x === "function"`
 * and returns undefined when a method is gone, so a rename in a Pi release would
 * silently switch the prompt keys off. This test fails the day that release is
 * installed instead.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { findPiInstall } from "./helpers.mjs";

const install = findPiInstall();
const { CustomEditor } = await import(pathToFileURL(install.piCodingAgent).href);

/** Editor methods the patch reads or wraps (`REQUIRED` in cc-keys.ts). */
const REQUIRED = ["handleInput", "isShowingAutocomplete", "getText", "setText"];

test("every CustomEditor method the prompt keys patch is still there", () => {
	const missing = REQUIRED.filter((method) => typeof CustomEditor?.prototype?.[method] !== "function");
	assert.deepEqual(missing, [], `Pi ${install.version}: the editor patch targets changed; update cc-keys.ts`);
});