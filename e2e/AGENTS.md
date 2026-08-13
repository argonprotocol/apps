# App E2E Rules

These rules extend the repository root instructions for files under `e2e/`.

- Treat `e2e/flows/` as the source of truth for onboarding and Bitcoin automation. Vitest specs wrap those flows.
- Compose operations with `flow.run(...)`, inspect state with `flow.inspect(...)`, wait for operation state with `flow.waitUntilRunnable(...)`, and read app refs with `flow.queryApp(...)`.
- Reserve `flow.command(...)` for raw driver or app commands.
- For reload and reconnect waits, use the driver/app handshake through `client.hello` and `DriverClient.waitForApp()`. Do not add fixed sleeps or scattered retry loops.
- Non-stateful flows default to `E2E_USE_TEST_NETWORK=1`. Stateful or manual continuation requires `E2E_USE_TEST_NETWORK=0`.
- Use `E2E_SESSION_MODE=stateful E2E_USE_TEST_NETWORK=0` when continuing from existing runtime or chain state without cleanup.
- Use `App.flow.runManual` with `E2E_OPERATION_CONTEXT`, `E2E_OPERATIONS`, and optional `E2E_OPERATION_MODE=inspect` for state-aware debugging.
- Use `yarn workspace @argonprotocol/apps-e2e run flows:console` for interactive operation debugging.
- Prefer `E2E_FLOW_APP_LOGS=quiet` and `E2E_DRIVER_TRACE=0` when only operation output is needed. Override the console defaults only when full logs or dependency warnings are relevant.
- Keep internal test and debug objects typed. Use casts and `??` defaults; add runtime validation only for external or untrusted inputs.
- Clean the Docker stack with the repository Yarn commands before isolated E2E runs unless the task explicitly continues stateful runtime data.
- Run `yarn check:operation-rules` after changing flow selectors or test IDs.
