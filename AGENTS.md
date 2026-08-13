# Argon Desktop Engineering Rules

These rules apply to implementation and review in this repository. Keep changes narrow, preserve existing interaction models, and use concrete repository evidence.

## Working Boundary

- Never stage changes unless the user explicitly asks. The user stages reviewed work as a review marker.
- Never push to `main` or identify users in branch names, commits, or pull-request text.
- Never SSH to a server without an explicit permission prompt.
- Do not mix unrelated cleanup into a feature or fix.

## Vue and UI

- Keep rendering choices visible in Vue templates. Do not move one-use labels, class strings, markup choices, or display conditions into computed values merely to shorten a template.
- Use computed values for meaningful domain or presentation state that is reused or materially clarifies behavior.
- When a template becomes difficult to read, reduce states and visual variants or extract a coherent component. Do not hide the same complexity in the script block.
- Reuse established components, controls, checklist items, overlays, and status sources. Do not add duplicate affordances or fake intermediate states.
- Reuse the repository's established spacing, typography, control sizes, and responsive patterns. Avoid page-specific size systems, arbitrary Tailwind values, and near-duplicate style variants.
- Keep directly related declarations together, with spacing between separate concerns. Do not crunch setup code into dense blocks or nested ternaries.

## Domain and State Design

- Name the authoritative owner for each durable or externally observed state. Do not let flags, cached projections, and UI state become competing authorities.
- Do not patch combinations of flags when the recurring problem is a missing domain concept, transition, or ownership boundary.
- Map the user-visible state at every durable transition. Recovery, replay, refresh, or migration must not replace valid visible data with less information merely because newer reconstruction is incomplete. Preserve last-known-valid state when safe, identify exactly what becomes unavailable, and publish repaired state atomically at its declared boundary.
- Every visible loading, pending, blocked, or recovery state must have a reachable exit: success, bounded retry, explicit quarantine, or an actionable terminal error. Verify that already-mounted consumers cannot remain stuck after the underlying state becomes valid.
- Run the `stateful-workflow-review` skill for changes involving persistence, events, replay, recovery, retries, migrations, backfills, subscriptions, or reconstructed state.

## Types and Boundaries

- Prefer real repository, runtime, and client types. Do not introduce fake `FooLike`, codec-like, DTO-like, or wrapper types when a real type or narrow `Pick`/`Omit` exists.
- Prefer codec-native and client-native operations, including typed clients, `toBigInt()`, and existing whole-object serialization.
- Never cast Substrate types merely to work around Polkadot.js codecs.
- Do not unwrap trusted internal TypeScript data with bespoke validation ladders. Reserve runtime validation for external or untrusted input; otherwise use narrow types, optional chaining, and nullish defaults.
- Pass an object shape or destructure it instead of expanding a stable shape into many positional properties.
- Do not hard-code a caller-specific signer, wallet, role, or selector inside a shared helper.

## Runtime and Service Compatibility

- Add compatibility code only when a change alters a boundary that can actually run at mixed versions: runtime transactions, queries, events, storage codecs, or a separately deployed service protocol. Do not add compatibility infrastructure to unrelated changes.
- Maintain a rolling two-version window: the currently deployed runtime or service and the next version being introduced. When the next version becomes current, remove support for the older version as the following compatibility change is developed. Do not accumulate three or more versions unless explicitly required.
- Use `yarn mainchain:pin` for runtime updates. It preserves the finalized deployed-mainnet TypeScript surface in `core/src/runtimeCompatibility.ts` before updating the client pin; do not maintain separate compatibility snapshots by hand.
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

- Do not use test count or coverage as evidence of correctness.
- Do not add tests that only prove a mock returns its input, a helper calls another helper, or the implementation follows its own wiring.
- A test must identify a production history, domain invariant, durable boundary, or previously defective behavior. It must assert the resulting durable and observable state, not merely calls made.
- Prefer real SQLite, real state owners, and real queues. Fake external chain, indexer, network, clock, or process boundaries only where necessary.
- For recovery and replay, simulate restart by constructing a new service over the same durable database when practical.
- For user-visible recovery, begin with valid loaded data, cross the failure or reconstruction boundary, and assert both information preservation and the mounted consumer's eventual exit from pending state.
- Runtime compatibility tests are required only for a changed runtime boundary. Run the application branch containing the compatibility consumer and next client against both the deployed runtime and candidate next runtime; assert equivalent domain outcomes and visible terminal behavior.
- Service compatibility tests are required only for a changed service boundary. Exercise the current downstream with the next server and the next downstream with the current server.
- Do not substitute fake DTOs that merely resemble either version in compatibility tests.
- A regression test must fail for the defective behavior. Fold it into an existing behavioral scenario when it is not a distinct lifecycle.
- Keep tests flat and behavior-focused. Avoid helper-heavy fixtures and verbose internal type contracts.

## Delivery

- Commit and pull-request summaries should explain what changed and why in ordinary language. Do not list routine verification or internal methodology unless it is critical to the change.
- Do not mention tool use or add AI, plugin, or generated-by signatures, co-author trailers, or badges to commits or pull requests.
- Do not wrap commit-message text manually unless explicitly requested.
