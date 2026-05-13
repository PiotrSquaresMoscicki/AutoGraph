# AutoGraph contributor instructions for GitHub Copilot

These instructions apply to all changes proposed in this repository, including
ones authored by Copilot, the Copilot coding agent, or any other AI assistant.

## Project at a glance

AutoGraph is a small, client-side graph editor built with Vite. The
single-source-of-truth model lives in `src/main.js`; `src/dot.js` parses and
serializes a minimal subset of the DOT language. Rendering is handled by
`d3-graphviz` directly in the browser — there is no server component.

Common scripts:

- `npm install` — install dependencies.
- `npm run build` — production build via Vite (the canonical validation step).
- `npm run dev` — local dev server.
- `npm test` — run the Playwright UI test suite (see below).

## Always add automated tests for new functionality

Whenever you add or change user-facing behavior — a new button, keyboard
shortcut, gesture, DOT-source rule, save/load behavior, viewport interaction,
etc. — you **must** add or extend an automated UI test that covers it. Tests
live under `tests/` and run with Playwright against a production build served
by `vite preview`.

Concretely:

1. Add a test in the relevant file under `tests/` (or create a new
   `tests/<feature>.spec.js` file when the area is new). Group related
   assertions under a `test.describe(...)` block.
2. Reuse helpers from `tests/helpers.js` (`openApp`, `clickNode`,
   `nodeLocator`, `edgeLocator`, `fillRenameDialog`, `expectNodeCount`,
   `expectEdgeCount`, etc.) rather than re-implementing low-level interactions.
   Extend the helpers when a new primitive is genuinely reusable.
3. Prefer **behavioural assertions** (e.g. "after pressing Delete, the node is
   gone") over checking transient DOM attributes such as the `selected` CSS
   class — d3-graphviz repeatedly re-applies attributes during render
   transitions, which makes attribute-based assertions flaky. The
   application's `state.selected` is most reliably observed through follow-up
   actions such as Delete, F2, or rename.
4. Avoid sleeps. Use Playwright's auto-waiting locators (`expect(...).toHaveCount`,
   `toBeVisible`, `toHaveText`, etc.) and the `openApp` helper, which waits
   for the initial render to finish (the `#status` text is set at the end of
   each render and is the canonical "render done" signal).
5. Run `npm test` locally before opening a PR. The test job invokes
   `npm run build` and then a `vite preview` server automatically (configured
   in `playwright.config.js`).

When you remove or change existing functionality, update the corresponding
test(s) in the same PR. Do not delete tests just because they fail — fix the
test to match the new intended behaviour, or, if the behaviour was wrong, fix
the production code.

## Coding conventions

- This codebase is plain ES modules (no TypeScript, no JSX). Match the
  existing import / formatting style.
- Keep state mutations going through the existing helpers in `src/main.js`
  (`pushSnapshot`, `setSingleSelection`, `render`, etc.) so undo/redo and
  rendering remain correct.
- The graph is the source of truth; the DOT pane stays in sync via
  `serialize` (graph → DOT) and `parse` (DOT → graph). Both directions must
  continue to work after your change.
- Do not introduce a server, build step beyond Vite, or test runner other
  than Playwright without explicit reason.

## Build & test verification

Before finishing a change:

1. `npm install` (only needed once per checkout).
2. `npm run build` to ensure the project still builds.
3. `npm test` to ensure all UI tests still pass, including any you added.

If a test is genuinely flaky (not failing due to your change), prefer to make
it more robust rather than retrying or disabling it.
