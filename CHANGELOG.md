# Changelog — pi-cc-plugins

## [Unreleased]

## [0.6.1] - 2026-11-23

### Fixed
- Trim a copy of Pi's cached settings rows instead of mutating the native render result. Settings typecheck cleanly without changing user configuration values.

### Changed
- Synchronize stable shared settings and current message/key descriptions with Loop, Monitor and Compaction; unfinished custom action pages are not shipped.
- Require tests and typechecking against Pi 1.6.0 before trusted npm publishing; use installed peers in CI without requiring a global Pi installation.

## [0.6.0] - 2026-11-20

### Changed
- **Enter is no longer rebound.** The feature used to write `app.message.followUp = "enter"` into the editor's keybindings, so Enter queued the prompt and waited for the whole run to finish (Pi's follow-up lane). It now leaves every Enter key alone: Pi's own binding applies — while a run is streaming the prompt steers into it and lands at the next tool boundary, when idle it submits — and `keybindings.json` is not touched at all.
- `ccKeys` now only drives the queued-message recall: Up / Ctrl+P on the empty prompt puts a queued message back, Down / Ctrl+N on its last visual line returns the prompt to what it was.
- The recall, the native-dequeue watcher (Alt+Up) and the paste-preserving Down are unchanged.

### Removed
- The keybinding patch, its manager bookkeeping and the Enter-specific interception branches (slash menu, disabled submit, trailing backslash) — Pi's editor handles those keys itself now.

### Notes
- Restoring the old behaviour is one user line in `keybindings.json`: `"app.message.followUp": "enter"`.

## [0.5.10] - 2026-11-18

### Fixed
- Preserve folded paste bodies and paste counters when Alt+Up followed by Down restores the original draft, not just its display marker.
- Invalidate stale recall records on input so sending a recalled message cannot later clear newly typed identical text.
- Keep cleared-draft-before-queue recall priority across feature toggles and stacked editor wrappers without losing held drafts or custom bindings.
- Recognize Ctrl+N at the default-keymap recall boundary while preserving menus, dedicated history actions and unowned shortcuts.
- Catch shared settings-panel save errors and refuse destructive rewrites after settings read failures.
- Do not report a prior turn's statistics when a failure emits agent_end before agent_start.

### Changed
- Represent active statistics with an optional record instead of duplicate idle state; inline the fixed binding and stop copying constant action arrays on each key press.
- Document the preserved compaction-only queue limitation: use native dequeue (Alt+Up on macOS/Linux, Alt+Q on Windows/WSL, or the user's binding), since the public pending query cannot see that queue. Add a guard proving native dequeue drains it; this does not claim Up/Ctrl+P support for compaction-only queues.
- Add paste, recall, toggle-order, default-keymap and startup-failure regressions; verify this release against Pi 1.5.2.

## [0.5.9] - 2026-11-18

### Fixed
- Keep the shared editor key chain intact when another extension patches `CustomEditor.handleInput` on top: toggling a feature off and on no longer recurses until the stack overflows and leaves the editor patched.
- Stop injecting Ctrl+C drafts into ↑-history once Draft recall is turned off, even when another extension wrapped the editor's history method.
- Scope the CC keys keybinding patch to each install, so one session's shutdown no longer removes another live session's Enter binding.
- Stop writing Pi's own `tui.input.submit` default into user keybindings, which registered a spurious `enter` conflict.

## [0.5.8] - 2026-11-14

### Changed
- Show only loaded-package settings pages in `/pi_cc`; standalone Plugins no longer displays irrelevant Loop/Monitor or Compaction controls. Text commands still preconfigure unloaded packages and preserve unrelated values.
- Scope shared command ownership and capabilities to each Pi runtime, including safe same-package reloads and mixed-version registry upgrades. Prompt editing and turn summaries are unchanged.
- Replace hard-coded Pi 1.3.0 typecheck paths with portable local peer/Pi release discovery and optional `PI_AGENT_DIR` / `PI_TYPESCRIPT_PATH` overrides.

## [0.5.7] - 2026-11-14

### Changed
- Synchronize shared pi-cc settings with Monitor and Loop: normalize panel/CLI values while retaining boolean storage and environment override behavior.
- Update the shared footer description to the count-first labels (`1 loop`, `2 monitors`); prompt editing and tool/turn summaries are unchanged.

## [0.5.6] - 2026-11-06

### Fixed
- Keep Pi's native visual-line navigation inside recalled prompt history: cursor Down and its aliases
  no longer jump straight to the next query before reaching the last visual line.
- Preserve dedicated history-action precedence, including keys also bound to cursor Down.
- Add real-editor regression tests for multi-line and soft-wrapped history, terminal resize, cursor
  aliases, draft restoration, autocomplete, and both prompt interceptors together or separately.

## [0.5.5] - 2026-11-04

### Changed
- Ctrl+P recalls a queued message on an empty prompt by its own byte, so it no longer depends on
  `keybindings.json` mapping it to `tui.editor.cursorUp`. It still only acts in the narrow state where
  Up already did: empty prompt and something queued.

## [0.5.4] - 2026-11-03

### Added
- `tests/pi-internals.test.mjs` fails when a Pi release renames a `CustomEditor` method the prompt keys patch, instead of silently switching the keys off.

### Changed
- The `/pi_cc` settings panel reports Pi as waiting on input (OSC 7501) while it is open.
