# Local mainnet release qualification

This tooling is a dry run against a finalized mainnet snapshot: can the released app load production-derived accounts, and can the candidate runtime and app load, recover, and preserve them? It does not replay an already-deployed runtime upgrade.

The top-level API and implementation directory both model a local mainnet environment. A runtime deployment is one transition performed inside that environment.

## Checkouts

Use three explicit checkouts:

- an Apps checkout at the currently published desktop release;
- the current Apps checkout containing the candidate app and this tooling;
- a Mainchain checkout containing the candidate runtime.

The previous and current Apps checkouts need their own installed dependencies. Capture generates the previous checkout's runtime client; the candidate checkout needs its own generated client. They share the local fork APIs, but they must never have the same application database open concurrently.

The candidate runtime is built from the Mainchain checkout in its existing Cargo target directory. `RuntimeCandidate.build` copies the exact compressed WASM selected from Cargo's build output into the run directory and records its source revision and checksum.

## Flow

1. Load a manifest that pins a mainnet block, its Chopsticks state database, and an indexer database at the same block.
2. Call `LocalMainnet.start`. It copies both source databases into a new run directory, starts the fork and indexer, produces one deployed-runtime block, and waits for the indexer to commit it.
3. Capture signing-disabled account instances with the published Apps checkout. Each starts against the pinned runtime and indexer, recovers through the snapshot block, and closes with a complete, checkpointed database. Account failures are recorded without stopping the other captures.
4. Call `deployRuntime` with the pinned Mainchain checkout's compressed WASM. It submits `system.setCode` for a newer spec, or `system.setCodeWithoutChecks` for a same-spec dry run, on the local fork. It then produces the candidate blocks, checks indexer ingestion, and restarts the indexer. An older spec is rejected.
5. For each captured account, copy its instance into a separate candidate-app instance, start the candidate app, recover through the candidate block, and verify current positions and captured history. Failures are recorded per account.
6. Checkpoint, force recovery again, then restart the candidate app and compare durable database and financial state.
7. Call `close` on the local mainnet environment. Run artifacts remain in the run directory for inspection.

In abbreviated TypeScript:

```ts
const mainnet = await LocalMainnet.start({ manifest, runDirectory });

const deployment = await mainnet.deployRuntime(candidateWasm, candidateSpecVersion);
await mainnet.launchApp({
  appsDirectory: currentAppsDirectory,
  instanceName: 'scenario-001',
  sourceInstancePackagePath: capturedAccount.instancePackagePath,
});

await mainnet.closeApp();
await mainnet.close();
```

Capture and review use separate local environments over copies of the same immutable snapshot. `closeApp` supports candidate-app restart checks.

## What is and is not tested

This is a candidate dry run on current state:

```text
published app + deployed runtime snapshot
             |
             | recover and checkpoint each account
             v
candidate runtime WASM on local fork + indexer
             |
             v
candidate app + recovered account databases
```

The candidate app is launched directly from its checkout. This tests its real Tauri startup and any pending SQLite migrations, but it does not test download, signature verification, or installation by the desktop updater. A new runtime migration is exercised only if the candidate pin actually introduces one. A same-spec `setCodeWithoutChecks` dry run activates the pinned WASM but does not rerun runtime upgrade hooks.

Chopsticks provides local execution and synthetic finalized heads. Mock signatures are used only to authorize the local sudo runtime-code call; production account keys and signatures are not required. This does not test consensus or real Bitcoin settlement. Production-derived Bitcoin state can still be loaded and inspected, while a locally simulated Bitcoin lifecycle is a separate follow-up.

Source state packages are never modified. Every run uses copied fork, indexer, and account databases. Use a fresh absolute run directory for every attempt; a partial run is evidence to inspect, not a workspace to reuse.

The indexer seed must use the candidate app's account-activity definition. Definition 4 associates bond flexibility changes with the bond owner, not just the vault operator. Upgrade a definition-3 seed with the indexer's seed sync before a local-mainnet review. The launcher rejects a seed whose account-activity definition cannot be brought current from the available fork history.

## API layers

Use `LocalMainnet.ts` for workflow orchestration:

- `LocalMainnet.start` starts the production-derived fork and indexer and establishes the deployed-runtime side of the boundary.
- `launchApp` starts the requested Apps checkout against the environment's current archive and indexer endpoints. An optional `sourceInstancePackagePath` copies an existing account package into a new instance and loads it before returning.
- `deployRuntime` deploys the pinned runtime on the local fork, advances the fork, verifies indexer ingestion, and restarts the indexer.
- `closeApp` supports explicit candidate restart checks.
- `close` shuts down the app, indexer, and fork without deleting evidence.

`AppSession` owns the real Tauri process, driver connection, instance loading, database checkpointing, and shutdown. `LocalMainnet` uses this app-control layer and does not load the E2E flow registry. A test that needs application assertions can explicitly supply `FlowSession.start` to `launchApp`; the production-derived test does this only for `App.flow.accountReview`.

`LocalMainnet`, `LocalMainnetFork`, `LocalMainnetIndexer`, and `RuntimeCandidate` own their respective lifecycle or orchestration. `manifest.ts` remains a stateless parser for the external JSON input.

## Read-only account inspection

Generate a pinned fork database, indexer database, and their manifest from the archive:

```sh
yarn local-mainnet:prepare \
  --output /absolute/path/to/new-preparation-directory \
  --block <finalized-block-hash> \
  --seed /absolute/path/to/mainnet-activity-v2.db.gz
```

The optional seed is the public indexer checkpoint published by `.github/workflows/docker-indexer.yml`; without it, preparation indexes from genesis. `--block` can select a historical finalized snapshot; otherwise preparation starts at the current finalized head. It chooses a block at or just before that head with the no-op Bitcoin sync required by the fork's inherents, verifies the seed's checkpoint against the archive, and advances the copied indexer to that exact block. A seed newer than the chosen historical snapshot is retained separately and replaced with a fresh replay from genesis, so later ownership projections cannot enter the fork. Preparation creates a fresh Chopsticks cache, closes both databases, checks SQLite integrity, and writes `manifest.json` with their checksums. Database paths in generated manifests are relative to the manifest, so the clean baseline can move between runners; existing absolute paths remain supported. Uncached chain state is still read from the pinned archive block when the fork runs.

Create a release-review set of previous-app databases from the pinned runtime's operational-account graph:

```sh
yarn local-mainnet:capture \
  --manifest /absolute/path/to/manifest.json \
  --previous-apps /absolute/path/to/previous-apps-checkout \
  --previous-app-ref v2.4.0 \
  --output /absolute/path/to/new-capture-directory \
  --account-limit 12
```

Capture regenerates the previous checkout's runtime client after verifying its release ref and records both generated artifact hashes. It then starts Vite directly for each account, so it never downloads runtime sources between account launches.

The manifest needs only the pinned archive, indexer, and network fields; it does not need candidate-runtime, `capturedDatabase`, or `restore` fields. `--previous-app-ref` must resolve to the exact clean commit checked out at `--previous-apps`, preventing a different working tree from silently becoming the release baseline. The command reads the pinned runtime's operational accounts and upstream relationships, then chooses a connected, anonymous slice that covers Bitcoin, bonds, mining, upstream, and vault roles. It labels the selected records `scenario-001`, `scenario-002`, and so on; no operator names or release-specific account selectors are stored in tracked source.

For each selected identity, the command opens a signing-disabled instance with the published Apps checkout and lets that release perform its normal startup and recovery against the pinned fork. It does not call candidate-only history APIs. The capture polls the published release's real SQLite checkpoints until wallet, Bitcoin, bond, and vault history all reach the pinned block without partial or pending work, checkpoints the database, and only then packages the instance. The full instance is copied under the output directory and registered in `starting-databases.json` with its checksum, migration version, SQLite integrity result, recovery status, graph features, selected upstream relationship, and an independent inventory of the positions that the candidate app must load.

Graph membership is only the ordinary scenario-selection authority. The copied database remains the authority for recovered history, while the pinned chain inventory is the independent expectation for current bonds, stakes, flexible bonds, vault-map contents, and active Bitcoin Fissions. The capture also records current and archived Bitcoin Liquid IDs from each database. Incomplete published-release history disqualifies the package because it is not a coherent publication boundary.

Each account is independent. Startup or recovery failures are recorded in `failures` and do not abort the remaining accounts, but incomplete instances are not registered as candidate inputs. Qualification requires every selected account to have complete history and full graph feature coverage. The capture command refuses to reuse an existing output directory.

For visible review of several captured accounts, start the interactive runner with the candidate app checkout:

```sh
yarn local-mainnet:review \
  --manifest /absolute/path/to/manifest.json \
  --candidate /absolute/path/to/candidate/attestation.json
```

The attestation is produced beside the compressed WASM by `RuntimeCandidate.build`; it binds the reviewed candidate to the expected runtime spec and WASM checksum. The runner activates the pinned candidate runtime on the local fork before opening the captured databases with the candidate app. By default it opens the first selected scenario. Use `open <account>` to close that disposable instance and open another captured database, `list` to show the anonymous labels and their review traits, and `quit` to stop the environment. Pass `--account <label>` to choose the first account or `--accounts <path>` to use a registry outside the manifest directory.

To retry the entire registry without opening each window manually, run the same command with `--all` and `ARGON_E2E_HEADLESS=1`. It recovers and validates each account independently, continues after individual failures, writes `account-results.json` in the review run directory, and exits unsuccessfully if any account fails. This scripted pass does not replace the visible release click-through.

For diagnostics after a partially failed capture, also pass `--diagnostic`. It reviews only captured accounts with complete starting history, checks each database before opening it, and continues after individual account failures. The results include per-account durations and are persisted after each account. Incomplete capture still exits unsuccessfully even when every reviewed account passes; the ordinary review command continues to reject an incomplete registry before starting.

Pass `--verify-recovery-idempotence` for the final recovery gate. For each opened account, the runner captures its financial projection and normalized SQLite state, forces recovery through the same pinned block again, and requires both snapshots to remain identical. It repeats the comparison after restarting the app. Observation timestamps are excluded from the database fingerprint; position facts, history, checkpoints, row identities, and financial values are not.

Each account is copied to a uniquely named local app instance before it is opened, and the E2E driver does not enable operations or otherwise opt the account into a different product mode. After candidate recovery reaches the candidate block, the read-only flow verifies every independently captured current bond, stake, flexible bond, and vault-map count. It also checks current and archived Bitcoin Liquid IDs against the pinned runtime and captured database history. The source packages and pinned fork/indexer seeds are not modified. The run directory defaults to a timestamped `reviews` directory beside the manifest and is retained as evidence.

The visible release review remains manual. Run the capture for the pinned production-derived state, run the review after building the candidate runtime, and click through the selected scenarios. Confirm normal account data and any captured archived Bitcoin records in the candidate app.

The `Release qualification` workflow runs on pushes to version branches matching `v[0-9]+.*`, and on pull requests that change the qualification workflow or harness. It also exposes manual dispatch once the workflow is on the default branch. The path-filtered PR route allows a first hosted measurement before a release branch exists, without maintaining a duplicate workflow. It is an informative release check and has no dependency relationship with the distribution workflow. One GitHub-hosted Ubuntu job runs preparation, runtime build, capture, and review as separate steps. Its six-hour timeout is a runner ceiling, not a duration estimate.

The preparation steps generate and verify a clean baseline, cache it by pinned block and preparation-source hashes, and copy it into the qualification run on the same runner. The verified baseline is saved before later build or account-test failures can prevent cache publication. There is no database artifact transfer between jobs. Cached manifests and closed SQLite databases are immutable inputs: mutated forks, candidate account databases, and review results are never cached. Cache keys are not tied to release numbers, but [GitHub cache branch restrictions](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching#restrictions-for-accessing-a-cache) still apply: a PR-created cache only warms reruns of that PR. A default-branch manual run can populate a cache accessible to subsequent release branches with matching pinned block and source hashes. Cache availability is not guaranteed. Its shell steps handle runner setup, cloning, dependency installation, Docker checkpoint extraction, and the preparation/capture/review sequence. TypeScript stays in code files: `qualificationInputs.ts` selects release refs and snapshot provenance, `RuntimeCandidate.ts` builds the runtime WASM and attestation, and `qualificationReport.ts` renders the final results. The build can also be invoked locally:

```bash
yarn local-mainnet:build-runtime \
  --mainchain /absolute/path/to/pinned-mainchain-checkout \
  --output /absolute/path/to/qualification-run
```

The qualification job checks out the published Apps tag in `release-channels/desktop-stable.json` and the exact Mainchain tag pinned in `server/.env.mainnet`. It pins a current finalized mainnet head as the source snapshot. On a cache miss, preparation searches seven daily indexer images preceding that snapshot, starting with the day before it. If none is available, it explicitly reports a cold replay from genesis. It generates the pinned fork and indexer manifest, builds the candidate runtime WASM and attestation, discovers accounts, and captures their databases with the published Apps release. It then runs `local-mainnet:review --all --diagnostic --verify-recovery-idempotence` against every complete captured account. Selection is the operational-account graph capped at 12, not every account on mainchain. No runner-local manifest, app instance package, or prebuilt candidate runtime is required.

The workflow retains its manifest, attestation, capture registry, account results, phase timings, and final qualification report as run artifacts. Its summaries record download, preparation, baseline verification, runtime build, capture, and review durations, along with selected/captured/reviewed counts and individual account results. Each phase also records remaining disk space, including failed phases, so the first hosted run can expose storage limits without assuming them. A partial capture continues to candidate diagnostics where possible but cannot pass qualification. Infrastructure failure can still stop a shared environment before every account is reviewed; the report identifies captured accounts without a completed review. The candidate runtime spec may match the deployed spec but cannot be older. A failed run is retained as evidence; retry with a fresh output path.

For an additional scripted inspection from the published Apps checkout, point its account troubleshooting command at the local fork and indexer with `ARGON_NETWORK_CONFIG_OVERRIDE`, then provide either an operator name or a default Argon account address.

```sh
ARGON_NETWORK_NAME=mainnet \
ARGON_NETWORK_CONFIG_OVERRIDE='{"archiveUrl":"ws://127.0.0.1:...","indexerHost":"http://127.0.0.1:..."}' \
yarn troubleshoot:account <account>
```

The command creates or reuses a signing-disabled instance using the published release's own database schema and recovery behavior. Close it when the scenario is ready; capture and review keep source packages separate from candidate instances.

After activating the candidate runtime on the fork, the candidate app's read-only flow forces and verifies its wallet and financial-history checkpoints through the candidate block. It cannot detect activity omitted by an upstream index snapshot that incorrectly claims complete coverage.
