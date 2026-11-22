export function seedVirtualFrontendGlobals(args?: {
  appInstance?: string;
  network?: string;
  serverEnvVars?: NodeJS.ProcessEnv;
}) {
  const globals = {
    __ARGON_APP_ID__: 'com.argon.desktop',
    __ARGON_APP_INSTANCE__: args?.appInstance ?? process.env.ARGON_APP_INSTANCE ?? '',
    __ARGON_NETWORK_NAME__: args?.network ?? process.env.ARGON_NETWORK_NAME ?? 'dev-docker',
    __ARGON_APP_NAME__: 'Argon Desktop',
    __ARGON_NETWORK_CONFIG_OVERRIDE__: undefined,
    __ARGON_APP_ENABLE_AUTOUPDATE__: false,
    __SERVER_ENV_VARS__: args?.serverEnvVars ?? process.env,
    __ARGON_APP_SECURITY__: undefined,
    __ARGON_DRIVER_WS__: '',
    __IS_TEST__: false,
    __LOG_DEBUG__: false,
  };
  const virtualWindow = ((globalThis as { window?: object }).window ??= {});

  Object.assign(virtualWindow, globals);
  Object.assign(globalThis, globals);
}
