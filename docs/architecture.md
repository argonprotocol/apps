# Application state architecture

This document defines ownership and dependency boundaries for application state. Feature designs may add domain concepts and transitions, but they must preserve these boundaries unless the architecture is deliberately revised first.

## Extend before adding an owner

Start a change from the closest existing end-to-end workflow and its authoritative state owner. Add the new transition to that owner when its identity, lifecycle, and publication rules are the same; do not create another model because an event, screen, or file needs a name. A transaction operation, table, recovery decoder, or Vue component may collaborate with a domain without becoming a second authority.

Introduce a new authoritative model only when the change has a distinct identity or lifecycle that the existing owner cannot represent coherently. State the existing precedent, the invariant it cannot preserve, and the proposed new authority before implementing it. If a new model was not part of the agreed scope, make that ownership decision explicit rather than letting the PR establish it by default. This decision is needed for a new owner, not for every ordinary class or PR.

## Layout

| Layer                                      | Owns                                                                                           | May depend on                                                                                | Must not own                                                                  |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `core/`                                    | Current runtime and service types, protocol objects, and normalization at external boundaries  | Generated clients and protocol libraries                                                     | Application persistence, workflow state, historical reconstruction, Vue state |
| `src-vue/lib/db/`                          | Durable schemas, serialization, queries, and SQLite transactions                               | Record types and the database adapter                                                        | Chain calls, event interpretation, workflow transitions, observer publication |
| Top-level `src-vue/lib/*.ts` domain models | Canonical loaded state, domain lifecycles, live reconciliation, subscriptions, and publication | Core boundaries, tables, transaction operations, external services                           | Historical-version decoding, UI rendering, financial presentation             |
| `src-vue/lib/txs/`                         | Preparing, validating, submitting, resuming, and post-processing one user or operator command  | Domain models, transaction tracking, current clients, tables needed for the command boundary | Historical replay, broad current-state loading, UI workflow composition       |
| `src-vue/lib/recovery/`                    | Version-aware historical decoding, missing-data discovery, and detached reconstruction         | Historical clients and explicit domain publication boundaries                                | Current-state authority, ambient startup loading, incremental live mutation   |
| `src-vue/lib/financials/`                  | Read-only financial projections from published domain state and historical financial facts     | Domain selectors and published revisions                                                     | Domain lifecycle, recovery orchestration, chain subscriptions                 |
| `src-vue/stores/` and controllers          | Vue-facing selection, composition, and readiness                                               | Published domain models                                                                      | Direct database writes, chain reconciliation, duplicate lifecycle state       |
| Vue components                             | Rendering and user intent                                                                      | Stores, controllers, and transaction-operation entry points                                  | Chain, database, recovery, or authoritative workflow logic                    |

Dependencies flow down this table. Recovery may publish through an explicit domain boundary after reconstruction is coherent; it does not become a second domain model.

## Core boundaries

`core/` converts the currently supported runtime or service surface into stable protocol objects used by the application. It may accommodate the repository's declared live compatibility window at the boundary where versions actually differ.

Historical runtime support does not belong in a current protocol object merely because recovery needs it. Recovery owns historical clients and version-aware event translation. For a cold runtime cutover, current core code targets the new runtime directly; historical recovery continues to support every runtime version from which the released app promises to recover.

Core code must not read application tables, publish Vue state, choose recovery policy, or infer workflow state from application history.

## Durable records and tables

A table owns durable representation, not business meaning. It converts trusted record fields to and from SQLite and provides transactions and queries that are durable across restart.

Tables do not call the chain, decode runtime events, start background work, mutate domain caches, or decide which lifecycle transition should occur. A database transaction may make several local records coherent, but it cannot make a chain submission, Bitcoin broadcast, or remote service call atomic with those writes.

Use a small set of durable shapes such as record, insert input, and update patch. Repeated field-by-field mirrors or operation-specific table DTOs are evidence that ownership is leaking across the boundary.

## Top-level domain models

A top-level class in `src-vue/lib/` should represent a durable business domain or a cohesive subdomain workflow. It owns:

- the canonical in-memory view of its loaded records;
- the lifecycle and invariants of those records;
- current chain or service reconciliation;
- current event subscriptions and gap detection;
- retry and restart behavior after durable transitions;
- one explicit publication mechanism for stores, financial projections, alerts, and other observers.

For example, `BitcoinLocks` owns the current Lock aggregate, while `BitcoinReleases` owns the release workflow for those Locks. `BitcoinReleases` is not a transaction builder and is not a historical replay service. It resumes and advances release lifecycles from durable records, finalized current state, and required live event facts. `BitcoinFissions`, `BitcoinUtxoTracking`, and `MyVault` likewise own their named domain state rather than acting as generic helpers for other layers.

A domain model starts an idempotent current-state load on first access. It loads its full durable profile, reconciles it with a coherent finalized chain or service snapshot, publishes usable current state, and maintains a subscription or cursor that cannot silently omit the interval around that snapshot. A detected gap triggers scoped repair; ordinary startup does not trigger broad historical recovery.

Domains publish only after their declared durable boundary succeeds. Already-mounted consumers must receive the new canonical objects or revision. Consumers do not call or await domain `load()` methods and do not substitute recovery completeness for current-state readiness.

## Transaction operations

A class in `src-vue/lib/txs/` represents one command that can cross an external transaction boundary. It owns:

1. validating current command preconditions;
2. building and preparing the transaction;
3. durably recording the local attempt where required;
4. submitting with the intended signer;
5. resuming the same attempt after restart;
6. parsing the events emitted by its finalized extrinsic;
7. reading state at that exact finalized block when the events omit required result facts;
8. translating finalization or submission failure into a domain-owned result;
9. post-processing that is specific to that command.

It does not own the domain's ongoing lifecycle after the command result is published. Long-lived reconciliation belongs to the domain model. UI composition such as preparing several child operations before submitting them concurrently belongs at the application workflow boundary, while each child operation retains its own transaction identity and retry semantics.

Chain access in a transaction operation must be causally scoped to the command it owns. Its submitted extrinsic, finalized result events, and same-block result queries are part of that command boundary. Ambient subscriptions, polling for unrelated state, scanning prior blocks, and reconstructing account history are not. Operation-specific event interpretation should remain in the concrete transaction operation rather than becoming a generic event framework in the base class.

The transaction operation and domain model are not competing authorities. The operation is one producer of a normalized domain result for a locally submitted command. The domain owns the idempotent transition, durable canonical state, and publication. The same transition may also be reached through domain reconciliation when the transaction was submitted elsewhere, the app missed its live event, or command post-processing failed after the external transaction finalized.

No SQLite transaction may remain open across an extrinsic, RPC request, Bitcoin broadcast, or other external side effect. Once an external transaction is submitted or finalized, a later local write failure is repaired by idempotent reconciliation; it is never described or implemented as rolling back the external transaction.

## Live events and historical recovery

The age of an event does not decide whether a read is recovery. The purpose and authority of the read do.

### Live event-derived state

Finalized events are part of current reconciliation when they provide a fact required by the current workflow. A fact may be absent from queryable chain storage while still belonging in the application's durable workflow record. Bitcoin Vault signatures are one example: the matching finalized event is their authority, but the release workflow persists the observed signatures and event location so automatic signing and broadcast survive restart. If that local fact is missing, current runtime state identifies the applicable cosign height and release number so the workflow can retrieve the exact finalized event. This targeted retrieval is current reconciliation, not an account-history replay.

A domain may read a specific finalized event when all of the following are true:

- current authoritative state identifies the exact block or bounded location;
- the event supplies a current workflow fact that queryable chain storage does not retain;
- correlation uses the canonical domain identity;
- the result cannot replace newer current state;
- absence has a bounded retry or terminal meaning.

Normal live subscriptions also interpret finalized events and may persist resulting domain transitions. Missing one creates a concrete gap for that domain to repair. Historical recovery may backfill a missing event-derived fact, but it publishes through the same idempotent domain transition and cannot replace a newer live result.

When this app submitted the transaction, its transaction operation parses that extrinsic's finalized events and publishes the normalized result through the domain boundary. When another actor submitted the transaction, or the local operation is unavailable, the owning domain observes or retrieves the event as current reconciliation. These are two observation paths into one idempotent domain transition, not two owners of the resulting state.

### Historical recovery

Historical recovery runs only for:

- account import;
- an explicit Find Missing Data action;
- a missing historical record or historical fact identified by the owning domain.

A gap in an already-loaded active workflow is not historical recovery merely because filling it requires an older event. When current authoritative state identifies the applicable event or a bounded search location, the owning domain retrieves the missing workflow fact through current reconciliation. Recovery is used only when the missing item is historical backfill: a past record or fact that is absent from the durable history the application promises to reconstruct.

Recovery decodes every historical runtime or service version inside the application's supported recovery window. It constructs detached facts or records and keeps them unobservable until the smallest independently coherent publication unit is complete.

Recovery may add missing historical facts and reconstruct a record that no longer exists in current storage. It must not overwrite a newer live field, choose current actionability from replay progress, call ordinary live transition methods incrementally, or gate otherwise valid current state on a moving global history checkpoint.

The domain receiving recovered data owns the merge policy and publication. Current finalized state wins for current lifecycle, balances, active work, funding, and actionability. Historical evidence wins only for facts whose declared owner is history, such as past capital timing or a terminal record absent from current storage.

## Financial projections

Financials is a consumer and projection layer. It combines published current domain state with finalized historical financial facts to calculate net worth, performance, and completeness. It does not load domains, drive recovery, ingest chain events, or repair records.

If a required historical fact is missing, only the dependent projection is partial or unavailable. Current values and unrelated positions remain visible. Financials recomputes after the owning domain publishes a revision; it does not treat recovery progress as current-state readiness.

Domain-specific financial semantics remain documented in [`src-vue/lib/financials/README.md`](../src-vue/lib/financials/README.md).

## Publication and atomicity

For a local state transition, the normal order is:

1. Read and normalize authoritative external facts.
2. Validate the domain transition.
3. Commit all locally coupled durable records in one SQLite transaction.
4. Update canonical in-memory objects from the committed result.
5. Publish one domain revision or notification.
6. Allow financials, alerts, stores, and UI to recompute.

An external side effect is a separate boundary. The app records enough identity to reconcile it after a crash, performs the side effect, then records and publishes the observed result. A failure after submission leaves retryable reconciliation work; it does not unwind history or pretend the external action did not happen.

Atomicity is scoped to one coherent local unit. Independent Mainchain requests or Bitcoin transactions for a grouped send may proceed concurrently and succeed or fail independently.

## Authority examples

| Fact                                | Authority                                                                                                | Durable?                   | Consumer behavior                                                                                           |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Current Lock funding and status     | Finalized current runtime normalized by `BitcoinLocks`                                                   | Yes                        | Domain reconciles and publishes it                                                                          |
| Locally submitted command result    | The submitted extrinsic's finalized events and same-block state, normalized by its transaction operation | Attempt/result as required | Domain applies one idempotent transition                                                                    |
| Release lifecycle                   | `BitcoinReleases` plus finalized transaction/runtime outcomes                                            | Yes                        | Stores and UI observe the published workflow                                                                |
| Vault cosign signatures             | The matching finalized runtime event                                                                     | Yes, after observation     | Release workflow resumes from the durable signatures and reloads the exact event only when they are missing |
| Transaction submission/finalization | Transaction tracker and the external chain                                                               | Yes, as an attempt/result  | Transaction operation resumes; domain consumes the result                                                   |
| Historical cost or capital timing   | Domain-owned recovered history                                                                           | Yes                        | Financials treats dependent return as partial until present                                                 |
| Net worth and return                | Financial projection over published inputs                                                               | Derived                    | Recomputed; never written back as domain authority                                                          |
| Expanded progress details           | Vue component or store                                                                                   | Presentation only          | May reset without affecting workflow                                                                        |

## Named boundary violations

These patterns are architecture violations even when a particular test passes:

- A core protocol class performs historical scans or translates every historical runtime version for an application recovery caller.
- A recovery event handler calls a live workflow transition and switches behavior based on whether an optional replay object exists.
- Historical replay mutates live maps, queues, alerts, or tables incrementally before its coherent publication boundary.
- Financials starts domain loading or recovery, compares a recovery checkpoint to the moving chain head, or suppresses valid current values while history catches up.
- A table interprets an event, submits a transaction, publishes a domain revision, or decides a lifecycle status.
- A transaction operation becomes the permanent workflow owner or reaches into historical replay to determine its result.
- A domain or controller contains parsing that is specific only to a locally submitted extrinsic even though its transaction operation owns the finalized result context.
- A transaction operation subscribes to ambient events, scans history, or treats its command result as a second durable authority instead of publishing through the domain transition.
- A domain stores two competing representations of the same authority and repeatedly chooses between them, such as `blockHeight ?? resultBlockHeight` outside the boundary that normalizes the transaction result.
- Multiple layers repeat long field-by-field comparisons for the same request. Canonical identity and immutable request equality must be normalized once and owned by the relevant domain boundary.
- Recovery replaces current funding, balances, status, or actionability merely because its scan reached a later checkpoint.
- A fact absent from queryable chain storage is treated as historical authority, discarded despite being required for restart, or accepted without correlation to its authoritative event.
- A local database rollback is treated as though it could undo a submitted extrinsic or broadcast Bitcoin transaction.
- A UI component or store writes tables, queries the chain, or carries a second copy of domain workflow status.

When a feature appears to require one of these patterns, stop and revise the ownership model before adding an exception, compatibility flag, or merge rule.
