# Changelog — pi-cc-plugins

## [Unreleased]

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
