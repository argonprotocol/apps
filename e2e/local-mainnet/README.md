# Local mainnet fork upgrade tooling

This tooling answers one question: can a production-derived account opened by the currently deployed app survive the runtime and desktop migrations in the next release?

The top-level API and implementation directory both model a local mainnet environment. A runtime deployment is one transition performed inside that environment.

## Checkouts

Use three explicit checkouts:

- a previous Apps checkout at the release that supports the deployed runtime;
- the current Apps checkout containing the candidate desktop migration and this tooling;
- a Mainchain checkout containing the candidate runtime.

The previous and current Apps checkouts need their own installed dependencies. Capture generates the previous checkout's runtime client; the candidate checkout needs its own generated client. They share the local fork APIs, but they must never have the same application database open concurrently.

The candidate runtime is built from the Mainchain checkout in its existing Cargo target directory. `RuntimeCandidate.build` copies the exact compressed WASM selected from Cargo's build output into the run directory and records its source revision and checksum.

## Flow

1. Load a manifest that pins a mainnet block, its Chopsticks state database, and an indexer database at the same block.
2. Call `LocalMainnet.start`. It copies both source databases into a new run directory, starts the fork and indexer, produces one deployed-runtime block, and waits for the indexer to commit it.
3. Call `launchApp` with the previous Apps checkout. It copies the source instance into the old app's data directory before startup, then starts that checkout against the deployed runtime and seeded indexer without loading the E2E flow registry. A startup, decode, recovery, or UI failure is part of the captured scenario; catch it and continue to `deployRuntime` as long as the instance directory exists.
4. Call `deployRuntime` with the candidate compressed WASM. If an app is open, the environment attempts a database checkpoint and stops it first. Whether the old app succeeded or failed, it copies the preserved instance directory to `pre-upgrade-app` before submitting `system.setCode`, producing the upgrade, migration, and candidate blocks, waiting for the indexer to ingest them, and restarting the indexer from its updated database.
5. Call `launchApp` with the current Apps checkout and the same instance name. This is a new process using the candidate app code. Its normal startup path migrates the live SQLite database before the UI opens.
6. Exercise the account, checkpoint it, restart the candidate app, and compare the durable database and visible account state.
7. Call `close` on the local mainnet environment. Run artifacts remain in the run directory for inspection.

In abbreviated TypeScript:

```ts
const mainnet = await LocalMainnet.start({ manifest, runDirectory });

try {
  await mainnet.launchApp({
    appsDirectory: previousAppsDirectory,
    instanceName,
    sourceInstancePackagePath: manifest.capturedDatabase.instancePackagePath,
  });
} catch (error) {
  console.warn('The previous app failed; preserving its instance for the candidate app.', error);
}

const deployment = await mainnet.deployRuntime(candidateWasm);
if (!deployment.preUpgradeAppSnapshotPath) throw new Error('The previous app left no instance to preserve');

await mainnet.launchApp({
  appsDirectory: currentAppsDirectory,
  instanceName,
});

await mainnet.closeApp();
await mainnet.close();
```

Do not close `previousApp` directly in this normal flow. `deployRuntime` owns the checkpoint attempt, shutdown, and pre-upgrade copy as one ordered boundary. An old-app failure is diagnostic state, not a reason to discard the instance; only an infrastructure failure that leaves no instance to preserve prevents that scenario from reaching the candidate app. `closeApp` is available for candidate-app restart checks.

## What is and is not tested

This is a hard cutover test:

```text
previous app + deployed runtime
             |
             | checkpoint, stop, immutable copy
             v
runtime deployment + indexer transition
             |
             v
candidate app + candidate runtime + SQLite migration
```

The candidate app is launched directly from its checkout. This tests its real Tauri startup and database migration, but it does not test download, signature verification, or installation by the desktop updater. It also does not require the candidate app to operate against the previous runtime: the previous app owns the pre-upgrade side of the cutover.

Chopsticks provides local execution and synthetic finalized heads. Mock signatures are used only to authorize the local sudo `system.setCode`; production account keys and signatures are not required. This does not test consensus or real Bitcoin settlement. Production-derived Bitcoin state can still be loaded and inspected, while a locally simulated Bitcoin lifecycle is a separate follow-up.

Source state packages are never modified. Every run uses copied fork and indexer databases, and the pre-upgrade app instance is retained separately from the database migrated by the candidate app. Use a fresh absolute run directory for every attempt; a partially completed runtime transition is evidence to inspect, not a workspace to reuse.

The indexer seed must use the candidate app's account-activity definition. Definition 4 associates bond flexibility changes with the bond owner, not just the vault operator. Upgrade a definition-3 seed with the indexer's seed sync before a local-mainnet review: it retains blocks before runtime spec 158 and replays only from the first stored spec-158 block. The launcher still rejects an older seed because the local fork cannot supply the pre-fork history needed for that replay.

## API layers

Use `LocalMainnet.ts` for workflow orchestration:

- `LocalMainnet.start` starts the production-derived fork and indexer and establishes the deployed-runtime side of the boundary.
- `launchApp` starts the requested Apps checkout against the environment's current archive and indexer endpoints. An optional `sourceInstancePackagePath` copies an existing account package into a new instance and loads it before returning.
- `deployRuntime` stops and preserves any active app, deploys the runtime, advances the fork through migration, verifies indexer ingestion, and restarts the indexer.
- `closeApp` supports explicit candidate restart checks.
- `close` shuts down the app, indexer, and fork without deleting evidence.

`AppSession` owns the real Tauri process, driver connection, instance loading, database checkpointing, and shutdown. `LocalMainnet` uses this app-control layer and does not load the E2E flow registry. A test that needs application assertions can explicitly supply `FlowSession.start` to `launchApp`; the production-derived test does this only for `App.flow.accountReview`.

`LocalMainnet`, `LocalMainnetFork`, `LocalMainnetIndexer`, `RuntimeCandidate`, and `CapturedDatabaseScenario` own their respective lifecycle or orchestration. `manifest.ts` remains a stateless parser for the external JSON input.

## Read-only account inspection

Create a release-review set of previous-app databases from the pinned runtime's operational-account graph:

```sh
yarn local-mainnet:capture \
  --manifest /absolute/path/to/manifest.json \
  --previous-apps /absolute/path/to/previous-apps-checkout \
  --previous-app-ref v2.3.8 \
  --output /absolute/path/to/new-capture-directory \
  --account-limit 12 \
  --include-package /absolute/path/to/released-legacy-bitcoin-instance
```

Capture regenerates the previous checkout's runtime client after verifying its release ref and records both generated artifact hashes. It then starts Vite directly for each account, so it never downloads runtime sources between account launches.

The manifest needs only the pinned archive, indexer, and network fields; it does not need candidate-runtime, `capturedDatabase`, or `restore` fields. `--previous-app-ref` must resolve to the exact clean commit checked out at `--previous-apps`, preventing a different working tree from silently becoming the release baseline. The command reads the pinned runtime's operational accounts and upstream relationships, then chooses a connected, anonymous slice that covers Bitcoin, bonds, mining, upstream, and vault roles. It labels the selected records `scenario-001`, `scenario-002`, and so on; no operator names or release-specific account selectors are stored in tracked source.

For each selected identity, the command opens a signing-disabled instance with the previous Apps checkout and lets that release perform its normal startup and recovery against the pinned fork. It does not call candidate-only history APIs. The capture polls the previous release's real SQLite checkpoints until wallet, Bitcoin, bond, and vault history all reach the pinned block without partial or pending work, checkpoints the database, and only then packages the instance. The full instance is copied under the output directory and registered in `starting-databases.json` with its checksum, migration version, SQLite integrity result, recovery status, graph features, selected upstream relationship, and an independent inventory of the positions that the candidate app must load.

Graph membership is only the ordinary scenario-selection authority. The copied database remains the authority for records already owned by the previous release, while the pinned chain inventory is the independent expectation for current bonds, stakes, flexible bonds, and vault-map contents. The capture also inspects each database for old Bitcoin lock rows that the candidate migration can archive. Incomplete old-release history disqualifies the package because it is not a coherent pre-upgrade publication boundary.

When the selected operational-account graph slice contains no account with a released legacy Bitcoin row, pass a prior signing-disabled instance with `--include-package`. The source package is inspected for released legacy rows and its database checksum is recorded, but its database is not reused. The capture takes only its read-only wallet identity and lets v2.3.8 reconstruct a fresh database against the canonical pinned fork. That release does not start financial-history recovery for an otherwise inactive account, so archived packages must have a current vault; unsupported packages are rejected before launch. This keeps legacy migration coverage without treating an orphaned or stale database as canonical evidence. The option can be repeated for multiple packages.

Each account is independent. Startup or recovery failures are recorded in `failures` and do not abort the remaining accounts, but incomplete instances are not registered as candidate inputs. Qualification requires every selected account to have complete history, full graph feature coverage, and at least one canonically recaptured released legacy Bitcoin record. The capture command refuses to reuse an existing output directory.

For visible review of several captured accounts, start the interactive runner with the candidate app checkout:

```sh
yarn local-mainnet:review \
  --manifest /absolute/path/to/manifest.json \
  --candidate /absolute/path/to/candidate/attestation.json
```

The attestation is produced beside the compressed WASM by `RuntimeCandidate.build`; it binds the reviewed candidate to the expected runtime spec and WASM checksum. The runner upgrades the fork and indexer before opening the first captured database with the candidate app. This matches the release order: runtime first, then desktop update. By default it opens a scenario with a released legacy Bitcoin record first. Use `open <account>` to close that disposable instance and open another captured database, `list` to show the anonymous labels and their review traits, and `quit` to stop the environment. Pass `--account <label>` to choose the first account or `--accounts <path>` to use a registry outside the manifest directory.

To retry the entire registry without opening each window manually, run the same command with `--all` and `ARGON_E2E_HEADLESS=1`. It recovers and validates each account independently, continues after individual failures, writes `account-results.json` in the review run directory, and exits unsuccessfully if any account fails. This scripted pass does not replace the visible release click-through.

Pass `--verify-recovery-idempotence` for the final recovery gate. For each opened account, the runner captures its financial projection and normalized SQLite state, forces recovery through the same pinned block again, and requires both snapshots to remain identical. It repeats the comparison after restarting the app. Observation timestamps are excluded from the database fingerprint; position facts, history, checkpoints, row identities, and financial values are not.

Each account is copied to a uniquely named local app instance before it is opened, and the E2E driver does not enable operations or otherwise opt the account into a different product mode. After candidate recovery reaches the pinned post-upgrade block, the read-only flow verifies every independently captured current bond, stake, flexible bond, and vault-map count. It compares migrated Bitcoin Liquids against the funded locks at the pinned pre-upgrade block and released local history, rejecting both missing positions and positions published from unproved migration seeds. The source packages and pinned fork/indexer seeds are not modified. The run directory defaults to a timestamped `reviews` directory beside the manifest and is retained as evidence.

This is a manual release qualification, not a CI job. Run the capture for the pinned production-derived state, run the review after building the candidate runtime, and click through the selected scenarios. Confirm normal account data for every scenario and explicitly confirm that the first scenario's released pre-migration Bitcoin records appear in the candidate app's archived Bitcoin view.

For an additional scripted inspection from the previous Apps checkout, point its account troubleshooting command at the local fork and indexer with `ARGON_NETWORK_CONFIG_OVERRIDE`, then provide either an operator name or a default Argon account address.

```sh
ARGON_NETWORK_NAME=mainnet \
ARGON_NETWORK_CONFIG_OVERRIDE='{"archiveUrl":"ws://127.0.0.1:...","indexerHost":"http://127.0.0.1:..."}' \
yarn troubleshoot:account <account>
```

The command creates or reuses a signing-disabled instance using the old release's own database schema and recovery behavior. Close it when the scenario is ready, or preserve the resulting instance even if that release fails. Do not open this source instance with the candidate checkout before `deployRuntime` has preserved it.

After the runtime transition, the candidate app's read-only flow can force and verify its wallet and financial-history checkpoints through the pinned candidate block. That is a post-upgrade observation; it does not gate preservation of the old database, and it cannot detect activity omitted by an upstream index snapshot that incorrectly claims complete coverage.
