# Argon Desktop Engineering Rules

These rules apply to implementation and review in this repository. Keep changes narrow, preserve existing interaction models, and use concrete repository evidence.

## Working Boundary

- Never stage changes unless the user explicitly asks. The user stages reviewed work as a review marker.
- Never push to `main` or identify users in branch names, commits, or pull-request text.
- Never SSH to a server without an explicit permission prompt.
- Do not mix unrelated cleanup into a feature or fix.

## Claude Code Reviews

- Claude Code is an approved external reviewer for this repository. Agents may send repository source, including private source, diffs, tests, and necessary review instructions and context through the existing authenticated Claude Code installation as part of requested engineering work without requesting approval for each review.
- Keep these reviews read-only and limit the material to the review scope. Exclude credentials, session data, and real user or production-account information. This allowance does not authorize staging, commits, pushes, publishing comments, or changes to provider accounts or subscriptions; the other approval and privacy rules still apply.

## Evidence and User Privacy

- Tracked source, fixtures, stories, PR descriptions, review comments, shared artifacts, and task handoffs must not contain real user or production-account information. Use deterministic synthetic data or test accounts. Do not copy real names, emails, user wallet addresses, account identifiers, account-specific financial values, credentials, or session data into this evidence. Authorized diagnostic material stays out of tracked source and shared PR evidence; report a non-identifying outcome instead.
- Screenshots used as evidence must come from test apps with synthetic data or test accounts. Do not attach, embed, or link screenshots from real user or production-account sessions, including cropped, blurred, or otherwise redacted versions.

## Vue and UI

- Keep rendering choices visible in Vue templates. Do not move one-use labels, class strings, markup choices, or display conditions into computed values merely to shorten a template.
- Keep numeral conversion and formatting calls such as `microgonToArgonNm(...)` and `micronotToArgonotNm(...)` directly in Vue templates. Do not move them into script helpers such as `formatAmount` merely to shorten the template.
- Use computed values for meaningful domain or presentation state that is reused or materially clarifies behavior.
- When a template becomes difficult to read, reduce states and visual variants or extract a coherent component. Do not hide the same complexity in the script block.
- Reuse established components, controls, checklist items, overlays, and status sources. Do not add duplicate affordances or fake intermediate states.
- Reuse the repository's established spacing, typography, control sizes, and responsive patterns. Avoid page-specific size systems, arbitrary Tailwind values, and near-duplicate style variants.
- Keep a Vue element's opening tag on one line when it has exactly one attribute, regardless of line length. If Prettier would wrap it, add `<!-- prettier-ignore -->` immediately before the element.
- Keep directly related declarations together, with spacing between separate concerns. Do not crunch setup code into dense blocks or nested ternaries.

## Storybook UI States

- When a change alters visible UI, text, or workflow state, add or update the applicable Storybook stories for every materially changed reachable state. If no story applies, state why in the handoff.
- Prefer the highest meaningful production screen, overlay, or workflow panel. Full-screen stories should use the shared app frame so the real TopBar and LeftBar are visible; focused overlays and independently useful panels can remain isolated. Do not recreate production markup or initialize the entire application service graph.
- Cover affected empty, loading, progress, blocked, error, success, recovery, and populated states without generating every internal flag combination or inventing intermediate states.
- Mock only external boundaries and store accessors. Use deterministic synthetic data, real exported types, and the production component's actual state selectors.
- Use `play` interactions only to reveal the visual state represented by a story. Do not put behavior assertions in Storybook or count passing stories as behavior verification; put those assertions in Vitest or E2E coverage. Represent service-driven progress and failure states as explicit stories rather than timers or fake buttons.
- Keep fixed state stories inert and visibly labeled. Mark a story interactive only while every reachable control in that state has a deterministic mocked outcome; never expose production controls that fall through to unavailable Tauri, database, chain, or network services.
- Follow `.storybook/README.md`, run `yarn storybook:test` and `yarn storybook:build`, and never commit generated `storybook-static` output.

## Domain and State Design

- Name the authoritative owner for each durable or externally observed state. Do not let flags, cached projections, and UI state become competing authorities.
- Do not patch combinations of flags when the recurring problem is a missing domain concept, transition, or ownership boundary.
- Treat recovered history as backfill, never as the authority for current state. Start recovery only during account import, an explicit missing-data scan, or when the owning domain detects a concrete gap. Domains that require historical events must own their recovery and publish repaired canonical state. Consumers must not compare recovery checkpoints to the moving chain head, gate valid live data on global recovery coverage, or let older backfill overwrite newer live state.
- Domain stores start their idempotent current-state load on first access. Ordinary consumers observe readiness; they do not call or await domain `load()` methods.
- Treat background domain load failures as retryable unless application identity or durable local state is unusable. Do not route transient chain, block, or service failures through the global fatal-error dialog.
- Map the user-visible state at every durable transition. Recovery, replay, refresh, or migration must not replace valid visible data with less information merely because newer reconstruction is incomplete. Preserve last-known-valid state when safe, identify exactly what becomes unavailable, and publish repaired state atomically at its declared boundary.
- Historical recovery must define its coherent publication boundary. Keep reconstructed state detached until every fact required at that boundary is coherent; never expose mid-replay state, trigger alerts from replay state, or replace previously valid state with a partial reconstruction.
- Every visible loading, pending, blocked, or recovery state must have a reachable exit: success, bounded retry, explicit quarantine, or an actionable terminal error. Verify that already-mounted consumers cannot remain stuck after the underlying state becomes valid.
- Run the `stateful-workflow-review` skill for changes involving persistence, events, replay, recovery, retries, migrations, backfills, subscriptions, or reconstructed state.

## Types and Boundaries

- Prefer real repository, runtime, and client types. Do not introduce fake `FooLike`, codec-like, DTO-like, or wrapper types when a real type or narrow `Pick`/`Omit` exists.
- Prefer codec-native and client-native operations, including typed clients, `toBigInt()`, and existing whole-object serialization.
- Never cast Substrate types merely to work around Polkadot.js codecs.
- Do not unwrap trusted internal TypeScript data with bespoke validation ladders. Reserve runtime validation for external or untrusted input; otherwise use narrow types, optional chaining, and nullish defaults.
- Pass an object shape or destructure it instead of expanding a stable shape into many positional properties.
- Destructure object parameters such as `args` and `request` at the start of a method instead of repeatedly accessing `args.field` or `request.field` throughout the method.
- Do not hard-code a caller-specific signer, wallet, role, or selector inside a shared helper.

## Runtime and Service Compatibility

- Add compatibility code only when a change alters a boundary that can actually run at mixed versions: runtime transactions, queries, events, storage codecs, or a separately deployed service protocol. Do not add compatibility infrastructure to unrelated changes.
- Maintain a rolling two-version window: the currently deployed runtime or service and the next version being introduced. When the next version becomes current, remove support for the older version as the following compatibility change is developed. Do not accumulate three or more versions unless explicitly required.
- Use `yarn mainchain:pin` for runtime updates. It preserves the finalized deployed-mainnet TypeScript surface in `core/src/runtimeCompatibility.ts` before updating the client pin; do not maintain separate compatibility snapshots by hand.
- A runtime pin is incomplete until the pinned package and spec are registered in the historical runtime source registry, historical event artifacts are regenerated, and every added, removed, or renamed event has an explicit indexer and recovery disposition. Typecheck alone is not structural compatibility evidence.
- At a changed runtime boundary, explicitly combine the newly pinned client type with the generated `RuntimeSpec<version>` type, probe the real property or callable surface directly, use native codec values, and normalize once into the stable domain model. Preserve equivalent signer, result, error, finalization, and published-state behavior.
- Do not dispatch only by spec number or use `Reflect`, codec casts, string parsing, fake DTOs, copied client libraries, or global augmentation for compatibility.
- For a changed server boundary, check both relevant mixed-version directions: the current downstream with the next server, and the next downstream with the current server. Preserve the current contract through additive fields, compatible defaults, or explicit capability negotiation.
- If either pairing cannot be supported safely, detect the missing version or capability before starting the workflow and show an actionable upgrade requirement. Do not allow it to become a decode failure, partial write, spinner, or retry loop.

## Structure and Simplicity

- Put primary execution and flow logic before private helpers unless a framework requires another order.
- Do not add pass-through wrappers, facade layers, duplicate interfaces, field-by-field DTO copies, or single-use helpers unless they hide meaningful complexity or establish a materially narrower boundary.
- Prefer durable domain names. Avoid vague names such as `target`, historical names such as `legacy`, and public names that expose transitional storage details.
- Before finishing substantial work, remove unnecessary single-use helpers, pass-through layers, duplicated DTOs, validation ceremony, duplicate UI states, and manual client/codec plumbing.

## Tests

- Prefer an integration scenario across the real state owners and durable boundaries when a unit test would mock away the behavior being changed. Keep the scenario focused; do not add duplicate unit coverage merely to increase test count.
- New chain integration files use the shared `integration` Vitest project, common network setup, and run-scoped accounts from `integrationAccountUri`. Use native Vitest `tags: ['mining-auction']` for exclusive auction access or `tags: ['exclusive-argon-network']` for a sequential scenario that controls prices on the shared chain. Scenarios that require a fresh chain or cannot restore shared protocol state use `tags: ['isolated-argon-network']` and an explicitly owned network. Local and external-transport scenarios use `tags: ['no-argon-network']` with ordinary Vitest tests. Do not use comment metadata or filename registries. See `core/__test__/README.md`.
- Do not use test count or coverage as evidence of correctness.
- Do not shape production models, interfaces, or dependency boundaries around what is convenient to mock in tests. Production code must use the real repository objects and domain boundaries; adapt the test at a genuine external boundary instead.
- Do not add tests that only prove a mock returns its input, a helper calls another helper, or the implementation follows its own wiring.
- A test must identify a production history, domain invariant, durable boundary, or previously defective behavior. It must assert the resulting durable and observable state, not merely calls made.
- Use real SQLite when persistence is part of the behavior under review, together with real state owners and queues. A database alone does not establish integration coverage; assert the outcome of the relevant production components working together. Pure calculations do not need a database.
- When the risk lies in components interacting, prefer a focused integration scenario over additional isolated mock tests. Run the affected production flow with the smallest setup that exercises the risk. Fake external chain, indexer, network, clock, or process boundaries only where necessary; keep the boundary under review real. Use the full application or network setup when the behavior depends on it, rather than by default.
- For recovery and replay, simulate restart by constructing a new service over the same durable database when practical.
- For user-visible recovery, begin with valid loaded data, cross the failure or reconstruction boundary, and assert both information preservation and the mounted consumer's eventual exit from pending state.
- Runtime compatibility tests are required only for a changed runtime boundary. Run the application branch containing the compatibility consumer and next client against both the deployed runtime and candidate next runtime; assert equivalent domain outcomes and visible terminal behavior.
- Service compatibility tests are required only for a changed service boundary. Exercise the current downstream with the next server and the next downstream with the current server.
- Do not substitute fake DTOs that merely resemble either version in compatibility tests.
- A regression test must fail for the defective behavior. Fold it into an existing behavioral scenario when it is not a distinct lifecycle.
- Keep tests flat and behavior-focused. Avoid helper-heavy fixtures and verbose internal type contracts.

## Task Completion and PR Readiness

- Before implementing a behavioral change, identify the intended user-visible or domain outcome, the authoritative producers that can create it, and the boundary at risk. Choose test scenarios from those production histories and invariants rather than from the implementation's branches or mocks.
- Review the final diff, including uncommitted changes. Run `stateful-workflow-review` for the stateful changes listed above and `architecture-boundary-review` when authority, ownership, layer placement, or a durable handoff changes. Cosmetic, documentation, and behavior-preserving changes do not require these reviews unless they alter those boundaries.
- When the changed fact can arrive through a submitted transaction, ambient live collection, current reconciliation, or historical recovery, include each supported producer in the stateful review. Verify that equivalent facts reach the same domain-owned result and that older recovery cannot overwrite newer live state.
- Before describing a behavioral change as complete or ready, have one independent reviewer, a separate agent or human, inspect the decisive test scenarios and assertions and verify which boundary reviews apply. The reviewer must check the production producers and expected outcomes rather than accepting the author's case list, mock setup, or `PASS` label. One reviewer can perform both applicable boundary reviews; reuse completed review evidence when it covers the final diff.
- Start with relevant existing tests. Add or extend coverage only for a concrete gap in the changed behavior; prefer strengthening an existing scenario over adding another test. A bug fix needs a regression that detects the original defect, and an existing test can satisfy that requirement. There is no requirement for a new test, test file, or suite on every PR.
- The independent reviewer must explicitly return `Test evidence: PASS` or `BLOCKED` after inspecting all added or updated tests and any existing tests relied on for readiness. The confirmation must cite the decisive test or scenario, identify the real production code and boundary exercised, name the mocked boundaries, and explain which observable or durable assertion would fail for incorrect production behavior. A generic assurance that there are no mock tests is insufficient. Use the inspection procedure in `.agents/skills/stateful-workflow-review/references/test-evidence.md` even when no stateful review is otherwise required; this does not require expanding the change into a stateful audit.
- Tests that mock the behavior under review, inject the asserted result through fixture setup, or merely check passthrough values or helper calls do not qualify as behavior evidence. Replace, strengthen, or remove newly added tests that do only that. Synthetic inputs and external-service mocks are valid when real production behavior crosses the claimed boundary and the expected outcome is independently justified. For a bug regression, a compile, import, or fixture-setup failure on the old revision is not evidence that the test caught the defect.
- Record the scenario, resulting observable or durable state, and relevant test or run result. For a bug fix, demonstrate a failing regression on the defective behavior and a passing result with the correction. For a feature, demonstrate its stated acceptance outcome. Add failure, retry, restart, or mounted-consumer scenarios only when the change puts those behaviors at risk and existing coverage does not already catch the failure. Test counts, mock calls, and Storybook results do not establish behavior correctness.
- Keep verification proportional to the change. Inspect supported production paths to find concrete risks; do not turn the review checklist into a test for every producer, branch, flag, or lifecycle combination. Each additional scenario must catch a specific realistic failure missed by existing coverage. Run relevant tests and required repository checks; add new test infrastructure only when an identified gap cannot be exercised with the existing setup.
- Test-evidence review and applicable boundary reviews must return `PASS` with supporting evidence before the behavioral task is complete or the PR is ready. `BLOCKED`, `NEEDS DECISION`, missing evidence, and failed or skipped required checks remain unfinished work. Report the exact gap; do not turn an unresolved finding into a passing verdict. A draft PR may expose incomplete work if its remaining gaps are explicit.
- A later behavior or ownership change invalidates the affected review and verification evidence. Re-run the affected checks and reviews on the final change before claiming readiness; the implementation author cannot recertify an independent review on the reviewer's behalf.
- Use `.github/PULL_REQUEST_TEMPLATE/bug.md` for bug fixes, `.github/PULL_REQUEST_TEMPLATE/feature.md` for new behavior, and `.github/pull_request_template.md` for other changes. Select by the PR's primary purpose and write the final description using that template; do not assume the hosting UI or PR tool chooses it automatically.
- Keep ordinary PR descriptions around 100–200 words. Explain the problem or purpose, what changed, the tests or checks and their results, and any remaining issues. Link longer evidence rather than repeating it. Keep review verdicts, reviewer identity, reviewed commit or working diff, logs, and detailed analysis in the task or review record; the author does not need to repeat that checklist in the PR description. Review reports should state decisive evidence and exceptions; a passing review does not need a subsystem walkthrough. Link updated stories for visual review when the UI changes; Storybook does not establish behavior correctness. Remove inapplicable sections. A change with no application behavior impact needs one clear verification statement, not additional tests or review ceremony.

## Delivery

- Commit and pull-request summaries should explain what changed and why in ordinary language. Do not list routine verification or internal methodology unless it is critical to the change.
- Do not mention tool use or add AI, plugin, or generated-by signatures, co-author trailers, or badges to commits or pull requests.
- Do not wrap commit-message text manually unless explicitly requested.
