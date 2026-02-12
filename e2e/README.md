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
- `miningOnboarding`
- `vaultingOnboarding`

Run flow scripts:

```bash
# Run selected/default flows
yarn e2e:docker

# Run a single flow
E2E_FLOWS=miningOnboarding yarn e2e:docker
E2E_FLOWS=vaultingOnboarding yarn e2e:docker

# Directly through the e2e workspace script
yarn workspace @argonprotocol/apps-e2e run flows

# Opt in to isolated ephemeral docker test-network mode
E2E_USE_TEST_NETWORK=1 yarn e2e:docker

# Optional: force a specific test-network session/project identity
E2E_USE_TEST_NETWORK=1 E2E_SESSION_NAME=vaultingOnboarding yarn e2e:docker
```

Common flow inputs:

```bash
E2E_FLOWS=miningOnboarding MINING_FUNDING_ARGONS=500 yarn e2e:docker
E2E_FLOWS=vaultingOnboarding VAULTING_EXTRA_FUNDING_ARGONS=1200 yarn e2e:docker
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

## Custom Runtime (Chainspec)

```bash
yarn docker:argon:chainspec /path/to/your/custom/wasm/file.wasm
```

This writes a custom chainspec that can be used with:

```bash
yarn dev:docker:custom
```
