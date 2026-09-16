---
name: architecture-boundary-review
description: Review an Apps design, diff, or named method for ownership and placement across core, domain models, transaction operations, recovery, tables, financials, stores, and Vue. Use before or during architectural changes when responsibilities, authority, event handling, or historical versus live behavior may be crossing layers. Do not use for general style cleanup.
---

# Architecture Boundary Review

Determine whether each responsibility has one authoritative owner and is implemented in the correct layer. A passing test or a cleaner file layout is not evidence that ownership is correct.

## Operating boundary

- Default to review-only. Do not edit, stage, commit, or push unless the user separately asks for implementation.
- Resolve the exact diff or symbols under review and inspect their baseline behavior. Distinguish an introduced violation from an existing one.
- Read [`docs/architecture.md`](../../../docs/architecture.md) completely before judging placement. Treat its layer table, event-read distinction, authority matrix, and named violations as the repository contract.
- Review responsibilities, not filenames. Moving unchanged behavior behind a helper, facade, or `recovery/` class does not change its owner.
- Recommend the smallest ownership correction. Do not propose broad reorganization merely to make the directory tree look uniform.

## Method-level review

For every changed method, class, or coherent code block that crosses a boundary, establish:

1. The domain fact or command it exists to handle.
2. The authoritative producer: current chain state, finalized event, submitted transaction result, durable application record, historical evidence, or presentation state.
3. Its temporal purpose: command finalization, active-workflow reconciliation, historical gap backfill, historical reconstruction, projection, or rendering.
4. Durable reads and writes, external side effects, in-memory mutation, and publication.
5. The layer that owns the resulting state and the layers it may depend on.
6. Retry, restart, concurrency, and absence semantics when those affect ownership.

Do not accept a vague label such as "recovery" or "sync" as the classification. State what is being recovered or synchronized, from which authority, and for whose lifecycle.

## Event and recovery classification

Classify event access by purpose rather than age:

- A transaction operation owns events and same-block reads caused by the command it submitted.
- For a batch or composite transaction, the outer command owns finalization and event parsing. It publishes each normalized child result through the child domain's idempotent transition; a separate concrete transaction operation must not claim attempts submitted by the outer command.
- A top-level domain owns ambient live events, current-state reconciliation, and retrieval of a specific finalized event needed by its active durable workflow.
- A domain may detect missing historical data and request scoped historical backfill. The recovered fact must enter through the domain's declared merge and publication boundary and cannot replace newer current state.
- `lib/recovery/` owns version-aware historical decoding, broad missing-data discovery, and detached reconstruction of records or facts absent from current state.
- A raw historical scan is not made correct merely by placing it in `lib/recovery/`; inspect its trigger, authority, merge policy, publication boundary, and stopping condition.

Before classifying any gap, name the missing item and choose exactly one category:

1. An already-loaded active workflow is missing an event-only fact, and current authoritative state identifies the event or a bounded search location. This is current reconciliation owned by the top-level domain.
2. A past record or historical fact is absent from the durable history promised by account import, Find Missing Data, or domain-triggered historical backfill. This is historical recovery.

Do not use `repair`, `gap`, `missed event`, or the age of a block as a substitute for this classification.

Do not classify a read as historical recovery merely because it reads an earlier block or searches several finalized blocks. When an active durable workflow needs an event-only fact, and current state identifies the applicable block or bounded interval, the owning top-level domain performs current reconciliation. Vault cosign signatures and release-settlement events are examples. `lib/recovery/` is for historical backfill or reconstructing missing historical records, not for progressing an already-loaded live workflow.

For a targeted event retrieval to remain current reconciliation, require all of these:

- current authoritative state identifies an exact block or bounded search location;
- the event supplies a fact the active workflow still needs and current storage does not retain;
- correlation uses canonical domain identity;
- the result cannot overwrite a newer transition;
- absence has a bounded retry, quarantine, or actionable terminal meaning.

If any condition is missing, report the exact missing boundary instead of automatically relocating the code.

## Layer verdicts

Apply the repository layout directly:

- `core/`: current protocol normalization; no application persistence or historical reconstruction.
- `lib/db/`: serialization, queries, and SQLite transactions; no event interpretation or lifecycle decisions.
- top-level `lib/*.ts`: canonical loaded domain state, ongoing lifecycle, current reconciliation, subscriptions, gap detection, and publication.
- `lib/txs/`: one command from validation through finalized result and command-specific post-processing; no ambient monitoring or historical scans.
- `lib/recovery/`: historical-version decoding, missing-data discovery, detached reconstruction, and coherent handoff to the domain.
- `lib/financials/`: read-only projections from published domain and historical financial facts.
- stores/controllers: Vue-facing selection and composition only.
- Vue: rendering and user intent only.

Flag duplicated authority, not ordinary collaboration between layers. A transaction operation and current reconciliation may observe the same result, but both must publish through one domain-owned idempotent transition.

If direct and composite commands can produce the same domain result, keep their transaction identities and retry semantics separate. Unify only the normalized domain transition or a domain-owned selector that intentionally spans both command types.

## Stateful changes

When the reviewed change also affects persistence, events, replay, retries, migrations, subscriptions, or reconstructed state, run `stateful-workflow-review` after the placement review. Use it to validate transition completeness and observer convergence; do not treat it as a substitute for this ownership review.

## Report

Lead with `Architecture boundary: PASS`, `BLOCKED`, or `NEEDS DECISION`. Keep the report exception-focused and include:

- scope and intended responsibility;
- correctly placed responsibilities that are decisive to the verdict;
- each violation with the symbol, present layer, actual authority, violated rule, and smallest correction;
- unresolved ownership choices;
- stateful-workflow follow-up required, when applicable.

Do not reward file movement, helper extraction, test count, or naming changes unless they materially narrow authority or side effects.
