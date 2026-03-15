# E2E and Flow Testing

This workspace uses code-based flows in `e2e/flows/` as the source of truth for onboarding automation.
Vitest specs wrap the same flows for test reporting.

## Quick Start

```bash
# 1) Pin runtime/docker + package resolutions
#    (tag, commit, or main)
yarn mainchain:pin v1.3.27
# yarn mainchain:pin <commit-hash>
# yarn mainchain:pin main

# 2) Install after pinning
yarn install

# 3) Run flows directly (includes clean:dev:docker reset)
yarn e2e:docker

# 4) Run e2e Vitest suite (also flow-driven, from root)
yarn vitest --run --project e2e

# 5) Keep UI visible while running flows
ARGON_E2E_HEADLESS=0 yarn e2e:docker

# 6) Capture screenshots during flow execution (saved under your OS temp directory by default)
E2E_SCREENSHOT_MODE=1 ARGON_E2E_HEADLESS=0 yarn e2e:docker
```

Cleanup:

```bash
yarn clean:dev:docker
yarn docker:down
```

## Runtime Pinning

Pinning is managed by one entrypoint:

```bash
yarn mainchain:pin <tag-or-commit|main>
yarn install
```

Pinning updates:

- `e2e/argon/.env` (`VERSION`)
- `server/.env.dev-docker` (`ARGON_VERSION`)
- root `package.json` `resolutions` for `@argonprotocol/mainchain`, `@argonprotocol/testing`, and `@argonprotocol/bitcoin`

`main` and commit pins resolve runtime package versions from published npm versions using
`-dev.<first8-of-commit-hash>`, and write `sha-<first7-of-commit-hash>` to docker env versions.

## Run Flows

Available flows:

- `Mining.flow.onboarding`
- `Vaulting.flow.onboarding`
- `Bitcoin.flow.lockUnlock`
- `Bitcoin.flow.mismatchAccept`
- `Bitcoin.flow.mismatchReturn`
- `App.flow.runManual`

Run flow scripts:

```bash
# Run selected/default flows
yarn e2e:docker

# Run a single flow
E2E_FLOWS=Mining.flow.onboarding yarn e2e:docker
E2E_FLOWS=Vaulting.flow.onboarding yarn e2e:docker

# Directly through the e2e workspace script
yarn workspace @argonprotocol/apps-e2e run flows

# Opt in to isolated ephemeral docker test-network mode
E2E_USE_TEST_NETWORK=1 yarn e2e:docker

# Optional: force a specific test-network identity
E2E_USE_TEST_NETWORK=1 ARGON_APP_INSTANCE=Vaulting.flow.onboarding yarn e2e:docker
```

## Flow Runtime Surface

Flow and operation code should use one runtime surface:

- `flow.run(...)` runs an operation or flow
- `flow.inspect(...)` inspects the current operation by default, or another operation when passed
- `flow.waitUntilRunnable(...)` waits on operation state
- `flow.queryApp(...)` runs a read-only callback against app refs
- `flow.command(...)` sends a raw driver/app command when you really need it, except for reserved `command.*` internals

That means:

- operation composition should go through `flow.run(...)`
- self-inspect should be `flow.inspect()`
- cross-op inspect is the optional case: `flow.inspect(otherOperation)`
- app-state reads should go through `flow.queryApp(...)`
- raw commands like `app.waitForReady` should go through `flow.command(...)`, not `flow.run(...)`

Common flow inputs:

```bash
E2E_FLOWS=Mining.flow.onboarding MINING_FUNDING_ARGONS=500 yarn e2e:docker
E2E_FLOWS=Vaulting.flow.onboarding VAULTING_EXTRA_FUNDING_ARGONS=1200 yarn e2e:docker
E2E_FLOWS=Bitcoin.flow.lockUnlock yarn e2e:docker
E2E_FLOWS=Bitcoin.flow.mismatchAccept BITCOIN_MISMATCH_OFFSET_SATOSHIS=25000 yarn e2e:docker
E2E_FLOWS=Bitcoin.flow.mismatchReturn BITCOIN_MISMATCH_DIRECTION=above yarn e2e:docker
```

Run operations directly (state-aware debugging on top of current app state):

```bash
# Example: drive bitcoin lock/unlock path step-by-step
E2E_FLOWS=Vaulting.flow.onboarding,App.flow.runManual \
E2E_OPERATION_CONTEXT=bitcoin \
E2E_OPERATIONS=Bitcoin.op.startBitcoinLock,Bitcoin.op.openLockFundingOverlay,Bitcoin.op.readLockFundingDetails,Bitcoin.op.fundLockExact,Bitcoin.op.waitUnlockReady,Bitcoin.op.unlockBitcoin \
yarn e2e:docker

# Continue from existing runtime/chain state (no auto reset)
E2E_SESSION_MODE=stateful \
E2E_USE_TEST_NETWORK=0 \
E2E_FLOWS=App.flow.runManual \
E2E_OPERATION_CONTEXT=bitcoin \
E2E_OPERATIONS=Bitcoin.op.waitUnlockReady,Bitcoin.op.unlockBitcoin \
yarn workspace @argonprotocol/apps-e2e run flows

# Inspect preconditions only (no clicks/submissions)
E2E_FLOWS=App.flow.runManual \
E2E_OPERATION_CONTEXT=bitcoin \
E2E_OPERATIONS=Bitcoin.op.waitUnlockReady \
E2E_OPERATION_MODE=inspect \
yarn workspace @argonprotocol/apps-e2e run flows

# Mismatch actions step-by-step
E2E_FLOWS=App.flow.runManual \
E2E_OPERATION_CONTEXT=bitcoin \
E2E_OPERATIONS=Bitcoin.op.startBitcoinLock,Bitcoin.op.openLockFundingOverlay,Bitcoin.op.readLockFundingDetails,Bitcoin.op.fundLockMismatch,Bitcoin.op.ensureMismatchActionPanel,Bitcoin.op.acceptMismatch \
yarn workspace @argonprotocol/apps-e2e run flows
```

Run operations interactively (step -> inspect result -> next step in same live session):

```bash
E2E_SESSION_MODE=stateful \
E2E_USE_TEST_NETWORK=0 \
ARGON_E2E_HEADLESS=1 \
E2E_CONSOLE_APP_LOGS=quiet \
yarn workspace @argonprotocol/apps-e2e run flows:console

# then in the console:
# ops> status
# ops> runnable
# ops> inspect Bitcoin.op.waitUnlockReady
# ops> run Bitcoin.op.waitUnlockReady
# ops> run Bitcoin.op.unlockBitcoin
# ops> exit
```

Notes:

- `E2E_SESSION_MODE=stateful` runs `tauri:dev:docker` only and skips cleanup/reset on close.
- Stateful mode requires `E2E_USE_TEST_NETWORK=0`.
- `E2E_OPERATIONS` is a comma-separated list and must match operation names under `e2e/flows/operations`.
- `E2E_OPERATION_TIMEOUT_MS` overrides per-command driver timeout for that operation run.
- `E2E_OPERATION_MODE=inspect` runs operation `inspect` only; it does not execute side effects.
- `E2E_OPERATION_MODE=run` is the normal execution mode. Legacy `wait-run`, `waitrun`, and `wait` values alias to `run`.
- `flows:console` defaults to `E2E_CONSOLE_APP_LOGS=quiet` to keep the prompt readable; set `E2E_CONSOLE_APP_LOGS=inherit` for full app/runtime logs.
- `flows:console` also defaults to `E2E_CONSOLE_DRIVER_TRACE=0`; set `E2E_CONSOLE_DRIVER_TRACE=1` to see per-command driver trace logs.
- `flows:console` defaults to `E2E_CONSOLE_SUPPRESS_POLKADOT_WARNINGS=1`; set `E2E_CONSOLE_SUPPRESS_POLKADOT_WARNINGS=0` if you need dependency dedupe warnings.
- `E2E_FLOW_APP_LOGS=quiet` can also be used with non-console flow runs when you only want operation output.
- `E2E_DRIVER_TRACE=0` suppresses per-command driver trace logs for any flow runner.
- `E2E_SCREENSHOT_MODE` controls automatic capture:
  - `off` (default)
  - any truthy value enables screenshots
  - captures operation start/end/failure
  - captures phase-change screenshots when an operation `inspect` state emits a new `phase`
  - captures pre-interaction and failure screenshots for clicks/types/copy/paste
- `E2E_SCREENSHOT_DIR` overrides output directory (default: `<os-temp-dir>/e2e-screenshots`).
- `E2E_SCREENSHOT_SESSION` sets the session subdirectory name under `E2E_SCREENSHOT_DIR`.
  If omitted, a non-timestamp session folder like `session-pid12345-ab12cd34` is created.

## Operation Selector Rules

- Clickable selector test IDs are generated by the Vue transform in `vite.config.ts`.
- Operation selectors must match generated IDs (for example `SetupChecklist.openServerConnectPanel()` and `TabSwitcher.goto(OperationsTab.Mining)`).
- `e2e/scripts/checkOperationRules.mjs` validates that PascalCase action targets used by flows resolve to generated/static Vue `data-testid` values.
- Run selector enforcement directly with:

```bash
yarn workspace @argonprotocol/apps-e2e run check:operation-rules
```

## Run Vitest

```bash
# Preferred top-level command
yarn vitest --run --project e2e

# Direct e2e workspace command (uses root `--project e2e`)
yarn workspace @argonprotocol/apps-e2e run test
```

Headless behavior:

- `yarn e2e:docker` inherits `ARGON_E2E_HEADLESS` (use `0` for visible UI).
- `yarn workspace @argonprotocol/apps-e2e run test` defaults to headless (`ARGON_E2E_HEADLESS=1`) and runs the root Vitest `e2e` project.

## Runtime Controls

```bash
VERSION=v1.3.27 yarn e2e:docker
ARGON_E2E_HEADLESS=0 yarn e2e:docker
E2E_SCREENSHOT_MODE=1 ARGON_E2E_HEADLESS=0 yarn e2e:docker
```

## Driver Websocket Mode (Advanced)

Frontend driver mode is activated when `ARGON_DRIVER_WS` is set to a websocket URL that includes
`session` query param.

Example:

```bash
ARGON_DRIVER_WS="ws://127.0.0.1:45123/control?session=my-session" yarn dev:docker
```

Frontend command payload shape:

```json
{
  "type": "driver.command",
  "id": "cmd-1",
  "command": "ui.click",
  "args": { "testId": "WelcomeOverlay.closeOverlay()" }
}
```

Supported commands:

- `ui.waitFor` (`testId` or `selector`, `state`, `timeoutMs`)
- `ui.isVisible` (`testId` or `selector`)
- `ui.count` (`testId` or `selector`, optional `index`)
- `ui.click` (`testId` or `selector`, `timeoutMs`)
- `ui.type` (`testId` or `selector`, `text`, `clear`, `timeoutMs`)
- `ui.getText` (`testId` or `selector`, `timeoutMs`)
- `ui.getAttribute` (`testId` or `selector`, `attribute`, `timeoutMs`)
- `ui.copy` (`testId` or `selector`, `timeoutMs`)
- `ui.paste` (`testId` or `selector`, `clear`, `timeoutMs`)
- `clipboard.write` (`text`)
- `clipboard.read`
- `app.location`
- `app.captureScreenshot` (`name`, `outputPath`, `timeoutMs`)

## Custom Runtime (Chainspec)

```bash
yarn docker:argon:chainspec /path/to/your/custom/wasm/file.wasm
```

This writes a custom chainspec that can be used with:

```bash
yarn dev:docker:custom
```
