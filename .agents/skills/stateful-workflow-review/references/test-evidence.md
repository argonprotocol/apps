# Test Evidence Rubric

Do not use test count, line coverage, or mock call coverage as evidence of stateful correctness.

## Strong Evidence

A strong test identifies:

- the production history that creates the state;
- the durable, temporal, or external boundary crossed;
- the domain invariant asserted;
- the durable and already-loaded observable outcomes;
- why it fails on the defective revision.

When the risk is user-facing recovery, start with valid visible or actionable state. Cross the failure or reconstruction boundary, then prove both information preservation and the already-mounted consumer's exit from pending state.

Prefer real SQLite, real state owners, real queues, and service reconstruction over the same database. Fake only the external chain, indexer, transport, clock, or process boundary needed to make the history deterministic.

## Weak or Misleading Evidence

Treat these as little or no gate evidence:

- inputs assembled from the implementation and asserted unchanged at the output;
- mocks that return the exact state the consumer expects;
- assertions that one helper called another helper;
- one test per branch or flag combination without deriving the input universe from producers;
- recovery proven only by reloading the entire app when live consumers should converge immediately;
- persistence asserted without subscriptions, queues, caches, alerts, or mounted consumers;
- recovery that starts empty and therefore cannot detect loss of previously valid visible data;
- tests that cannot fail on the defective commit.

## Valuable Stateful Scenarios

Select only scenarios that close an identified gate cell:

- every supported origin of the same terminal domain state;
- failure immediately after each durable or external side effect;
- retry after temporary failure;
- restart over the same durable data;
- newer live state arriving during older replay;
- duplicate, delayed, or reordered external facts where supported;
- migration followed by ordinary startup and observation;
- bounded unsupported-state behavior.

Fold a regression into an existing scenario when it is the same lifecycle. Add a new test only for a distinct production history, boundary, or invariant.
