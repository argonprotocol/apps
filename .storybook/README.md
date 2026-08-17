# Storybook UI states

Storybook is the reviewable catalog of user-visible application states. Chromatic builds these stories in CI and compares them with the pull request's merge base. The generated `storybook-static` directory is temporary output and must not be committed.

The catalog lives under `.storybook/stories`, grouped by the same product areas shown in the Storybook sidebar. Shared synthetic state belongs in `.storybook/scenarios`; Storybook-only components and test utilities belong in `.storybook/components` and `.storybook/support`. Keep production component names in story filenames so the rendered source remains easy to locate.

## What gets a story

Use the highest production component that owns the experience:

- a screen inside `AppScreen.vue` for a full-screen mode, so the real TopBar and LeftBar remain visible;
- an overlay for a focused workflow;
- a major panel when it has meaningful states independent of its parent.

Do not add stories for every leaf component. Full-screen release stories should render the production parent screen in the app frame, while focused overlays and independently useful panels can remain isolated. Do not mount `App.vue`; `AppScreen.vue` supplies its visible chrome without initializing unrelated application services and global overlays.

Add or update stories when a change affects visible layout, copy, controls, or workflow state. Cover each materially different reachable state affected by the change, including relevant empty, loading, progress, blocked, error, success, recovery, and populated states. Avoid permutations that render identically.

## Defining state

Render the production Vue component. Mock its store accessor, Tauri API, network client, database, or chain boundary so the story cannot reach external state. Use deterministic synthetic values and real exported repository types. Reuse `setupAppScenario` for the common app boundary, then override only the state that makes the scenario distinct.

Keep state setup in the story file until the same setup is genuinely reused. Do not create a parallel application-state model, fake DTO hierarchy, or shared helper for a single story file.

Register module mocks statically in `.storybook/preview.ts`, provide typed manual mocks in the source module's `__mocks__` directory, and configure their return values in the story's `beforeEach` hook. Reset every mutable value for every story.

## Interactions

Use a `play` function when the user causes the transition by clicking, typing, or selecting. Assert the resulting visible state or authoritative production state change.

Progress, connection loss, backend errors, and other externally driven transitions should be separate deterministic stories. Do not use timers to imitate application activity and do not add controls that do not exist in production.

`AppScreen` stories are fixed, inert state previews by default. Set `interactive` only while every reachable click in that state has a deterministic mocked outcome. If an interaction transitions into a state whose remaining controls are not supported by that story, switch the frame back to its fixed preview mode. The mode badge must accurately describe what the reviewer can do; do not leave production controls live when their external boundaries are absent.

## Naming

Group stories by the app's product and navigation areas, such as `Mining/Overview`, `Bitcoin/Locking`, or `Wallets/Ethereum import`. Do not organize the sidebar by implementation form such as screens, panels, or overlays. Name exports after the visible state or action, such as `Start`, `Installing`, `DownloadFailed`, or `ConfirmFunding`.

## Verification

Run:

```sh
yarn storybook:test
yarn storybook:build
```

`yarn storybook:test` renders every story in headless Chromium and executes every `play` function. The Storybook testing widget runs the same component tests interactively and marks failing stories in the sidebar. Generated output belongs in `storybook-static`, which is ignored by Git.

The pre-commit typecheck includes Storybook configuration, fixtures, and stories. CI reports interaction failures informationally while the initial catalog is stabilized, and runs the full Storybook build because TypeScript alone does not validate Storybook's indexing, module mocks, Vue transforms, assets, or Vite bundle. These checks do not attempt to infer whether a UI change should have added a new story. Chromatic publishes visual changes for review without failing the job solely because snapshots changed.
