/**
 * One patch on CustomEditor.handleInput for the whole package.
 *
 * Two features act on a key press: cc-keys.ts (Claude Code's Enter /
 * Ctrl+Enter, and Up on an empty prompt) and draft.ts (Ctrl+C keeps what it
 * clears). Each used to wrap the method itself and remember "the method as it
 * was", which only works while the wrappers come off in the order they went
 * on. With the CC keys turned off, Up no longer brought a cleared draft back
 * (cc-keys was the inner wrapper, so its uninstall put Pi's method back over
 * draft's), and every session that ended left one more stale wrapper behind
 * (draft's uninstall restored the cc-keys wrapper it had captured). Both
 * reproduced against Pi 1.4.0's CustomEditor.
 *
 * So the method is wrapped once, here, and a feature adds an interceptor: it
 * handles the key itself, or calls `next` to pass it down the chain. The chain
 * ends at Pi's own method. Registration order is the order a key travels, so
 * index.ts registers draft before cc-keys: Up on an empty editor brings back
 * what Ctrl+C just cleared before it reaches for an older queued message.
 *
 * The chain is kept on the prototype itself (under a symbol shared by every
 * load of the package), not in module state: /reload ends the session, and the
 * next load finds the chain the previous one left, so nothing is wrapped
 * twice. The last interceptor off puts Pi's method back.
 */

import { CustomEditor } from "@earendil-works/pi-coding-agent";

/** An editor as the chain hands it on; each interceptor narrows it to what it needs. */
export type ChainEditor = Record<PropertyKey, unknown> & { handleInput(data: string): void };

/** What a feature asks of one key: handle it, or call `next` to pass it on. */
export type InputInterceptor = (editor: ChainEditor, data: string, next: () => void) => void;

interface InputChain {
	readonly interceptors: InputInterceptor[];
	/** Pi's own method, under the wrapper. */
	readonly original: (this: unknown, data: string) => void;
	/** The wrapper this chain installed. */
	wrapper: (this: unknown, data: string) => void;
}

const CHAIN = Symbol.for("pi-cc-plugins:editor-input");

type EditorPrototype = Record<PropertyKey, unknown>;

function chainOf(target: EditorPrototype): InputChain | undefined {
	const held = target[CHAIN];
	return held !== undefined && typeof held === "object" ? (held as InputChain) : undefined;
}

/**
 * Add an interceptor to `proto`'s key handling, wrapping the method when the
 * first one arrives. Returns what takes it off again, or undefined when the
 * class has no handleInput to wrap.
 */
export function interceptEditorInput(
	interceptor: InputInterceptor,
	proto: object = CustomEditor.prototype,
): (() => void) | undefined {
	const target = proto as EditorPrototype;
	let chain = chainOf(target);
	// A chain whose wrapper is no longer the method in place belongs to a patch
	// someone put on top of ours; a new chain goes under it, and the old one
	// keeps working as the `original` of the new.
	if (!chain || target.handleInput !== chain.wrapper) {
		if (typeof target.handleInput !== "function") return undefined;
		const original = target.handleInput as InputChain["original"];
		// Written in two steps: the wrapper closes over the chain that holds it.
		const created: InputChain = { interceptors: [], original, wrapper: () => {} };
		created.wrapper = function (this: unknown, data: string): void {
			const list = created.interceptors;
			const run = (index: number): void => {
				if (index < list.length) list[index](this as ChainEditor, data, () => run(index + 1));
				else created.original.call(this, data);
			};
			run(0);
		};
		target.handleInput = created.wrapper;
		target[CHAIN] = created;
		chain = created;
	}
	chain.interceptors.push(interceptor);
	return () => {
		const index = chain.interceptors.indexOf(interceptor);
		if (index !== -1) chain.interceptors.splice(index, 1);
		if (chain.interceptors.length > 0) return;
		// The last one off gives Pi its method back, unless someone patched on top.
		if (target.handleInput === chain.wrapper) target.handleInput = chain.original;
		if (chainOf(target) === chain) delete target[CHAIN];
	};
}

/**
 * The editor's own key handling, skipping the chain: for a key an interceptor
 * takes over (the slash menu's Enter must not reach the queue action). A no-op
 * when nothing is patched.
 */
export function editorInput(editor: object, data: string, proto: object = CustomEditor.prototype): void {
	chainOf(proto as EditorPrototype)?.original.call(editor, data);
}
