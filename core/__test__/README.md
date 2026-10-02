# Integration tests

Use integration tests to exercise real state owners together: the runtime/client, domain services, SQLite tables, subscriptions, and recovery. Mock an external boundary only when necessary to create the failure or history being tested. Assert the resulting durable and observable state.

## Running tests

- `yarn test:integration` runs every integration file through the single `integration` Vitest project.
- `yarn vitest --run --project integration` runs the same project, with retries disabled. Chain files share one network; database and replay files run without starting one.
- Add a file filter for focused work: `yarn vitest --run --project integration TransactionTracker.integration.test.ts`.
- `yarn test:network:start` starts a dedicated local network for this checkout. Subsequent chain test commands reuse it. `yarn test:network:stop` removes its containers, volumes, and metadata.

Without a persistent local network, setup starts one network for the shared project and removes it after the tests, including test failures. CI always uses that owned lifecycle. The dedicated test network is separate from `dev:docker`. Recreate the persistent network when changing the runtime pin or Docker service code. A different runtime pin or genesis produces an explicit setup error. RPC ports stay fixed across container restarts; setup also resolves current published ports when reusing the same network.

## Writing a chain scenario

Add a normal `*.integration.test.ts` file using ordinary Vitest `it` and hooks. Shared network setup is automatic:

```ts
import { beforeAll, describe, expect, inject, it } from 'vitest';
import { Keyring } from '@argonprotocol/mainchain';
import { integrationNetwork } from '@argonprotocol/apps-core/__test__/integration.setup.ts';
import { integrationAccountUri } from '@argonprotocol/apps-core/__test__/integrationNetwork.ts';

const sender = new Keyring({ type: 'sr25519' }).addFromUri(
  integrationAccountUri(inject('argonIntegrationRunId'), import.meta.filename, 'funded'),
);

beforeAll(async () => {
  // integrationNetwork is ready before file hooks start.
});
```

Setup loads runtime configuration and funds the file's account before its scenarios start. Each command, watch rerun, and file has a different account namespace. Derive additional roles within that namespace; fund them through ordinary transfers from the file's own account when needed. Do not reuse genesis actors. Capture the beginning of a scenario’s history when testing reconstruction on a continuing chain; replay that history rather than every unrelated block since genesis. Account-specific sudo setup uses the existing `submitAndFinalize` helper, which coordinates the shared sudo nonce across workers and commands. Normal account transactions remain parallel.

Use `integrationNetwork.archiveUrl` with the existing clients and `createTestDb()` for private real SQLite. Construct a new production service over the same database to test restoration. Close clients, services, queues, and databases through existing teardown patterns. Tests never own teardown of the shared network.

Keep steps of one history sequential. Use finalized receipts for historical activity and capture one recovery checkpoint instead of comparing to a moving tip. Assertions should concern your own accounts and records, rather than the global number of vaults or the chain's starting height. `TransactionTracker.integration.test.ts`, `WalletBalances.integration.test.ts`, and `indexer.integration.test.ts` provide complete examples.

## Network ownership

Declare special requirements using native Vitest suite or test options:

```ts
describe('Competing bidders', { tags: ['mining-auction'] }, () => {
  // Tests share the network but hold exclusive access to its auction.
});
```

`mining-auction` serializes auction scenarios and funds ownership for the runtime's current seat stake. `exclusive-argon-network` gives one sequential test exclusive use of the shared chain. Other chain files finish before it starts, new files wait, and the price oracle pauses until the test finishes. Setup waits for normal finalized prices before releasing the chain. If the oracle cannot resume, subsequent files fail with a request to recreate the test network. `isolated-argon-network` identifies scenarios that manage their own network because they mutate protocol-wide state. `no-argon-network` identifies local, recorded-corpus, archive, and external-transport scenarios; common setup skips network startup for these tests. Tags are defined in `vitest.config.ts` and declared in code. There are no comment tags, source scanning, or filename registries.

Bitcoin Liquids uses the shared network for creation, funding recovery, concurrency, and close scenarios. Only its ratchet test takes exclusive access to control oracle prices. Ethereum Crosschain initializes a particular Ethereum chain and gateway, so it explicitly creates a dedicated network in the owning test and can run alongside shared scenarios. Its isolated tag does not disable file parallelism. The network factory serializes preparation of the common bundles and Compose assets, then starts each Docker project independently. Replay tests import their capture fixture directly; capture mode serializes publication of the shared SQLite corpus without serializing unrelated integration tests.

`startArgonTestNetwork.ts` owns Docker creation, readiness, ports, and shutdown. `integrationNetwork.ts` owns the integration manifest, borrowing verification, account namespaces, and cross-process coordination. `integration.globalSetup.ts` supplies session ownership and a fresh run ID, then cleans up only a network owned by that session. `integration.setup.ts` reads Vitest's collected tags, wraps the file lifecycle, installs configuration, and funds the scenario. The start/stop CLI uses the same network and manifest owners. Shared setup scopes its session with Node’s `AsyncLocalStorage`; Bitcoin commands and sudo coordination use that session without setting or restoring `process.env`. Docker receives the Compose project explicitly in each command’s child environment. Outside a shared test session, the existing helpers retain their normal behavior.

Use synthetic test accounts and data. Do not add real user information, production accounts, or real user screenshots to fixtures or artifacts. This infrastructure replaces repeated setup; it does not require additional test scenarios or a larger release checklist.
