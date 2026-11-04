import type { IKeyringPair } from '@polkadot/types/types';
import { expect, it, vi } from 'vitest';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { cryptoWaitReady, signatureVerify } from '@polkadot/util-crypto';
import { createPinia, setActivePinia } from 'pinia';
import {
  encryptBootstrapEndpoint,
  decryptBootstrapEndpoint,
  encryptBootstrapRecovery,
  decryptBootstrapRecovery,
  BlockWatch,
  Currency,
  createTypedEventEmitter,
  UserRole,
  JsonExt,
} from '@argonprotocol/apps-core';
import { hexToU8a, u8aToHex, Keyring } from '@argonprotocol/mainchain';
import type { ArgonClient, MainchainClients, Mining, MiningFrames } from '@argonprotocol/apps-core';
import type { TransactionTracker } from '../lib/TransactionTracker.ts';
import type { Config } from '../lib/Config.ts';
import type { IWalletFile } from '../interfaces/IWalletFile.ts';
import { ServerType, InstallStepKey, type IConfig } from '../interfaces/IConfig.ts';

const external = vi.hoisted(() => ({
  wallet: undefined as IWalletFile | undefined,
  decryptions: 0,
  client: undefined as ArgonClient | undefined,
  clients: undefined as MainchainClients | undefined,
  tracker: undefined as TransactionTracker | undefined,
  native: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: external.native }));
vi.mock('@tauri-apps/api', () => ({ app: { getVersion: async () => '2.5.1' } }));
vi.mock('@tauri-apps/plugin-updater', () => ({ check: async () => null }));
vi.mock('../lib/tauriApi.ts', () => ({ invokeWithTimeout: external.native }));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ onCloseRequested: async () => () => undefined }),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({ message: vi.fn(), confirm: vi.fn() }));
vi.mock('../stores/mainchain.ts', () => ({
  getMainchainClients: () => external.clients,
  getMainchainClient: async () => external.client,
  getMiningFrames: () => ({ load: async () => undefined }) as unknown as MiningFrames,
  getMining: () => ({}) as Mining,
  getBlockWatch: () => new BlockWatch(external.clients!),
  refreshPrunedClientFromConfig: () => undefined,
}));
vi.mock('../stores/currency.ts', () => ({ getCurrency: () => new Currency(external.clients!) }));
vi.mock('../stores/transactions.ts', () => ({ getTransactionTracker: () => external.tracker }));
vi.mock('../stores/appUpdater.ts', async importOriginal => ({
  ...(await importOriginal<typeof import('../stores/appUpdater.ts')>()),
  isAppUpdateBlockingServerInstall: () => false,
}));

it.each(['encrypted', 'plaintext', 'encryption failure', 'decryption failure'] as const)(
  'uses startup approval for a saved DigitalOcean token (%s)',
  async storage => {
    vi.resetModules();
    delete (globalThis as { __argonConfig?: unknown }).__argonConfig;
    setActivePinia(createPinia());
    vi.stubGlobal('ResizeObserver', class {});
    await cryptoWaitReady();
    const { createTestDb } = await import('./helpers/db.ts');
    const { setDbPromise } = await import('../stores/helpers/dbPromise.ts');
    const { WalletKeys } = await import('../lib/WalletKeys.ts');
    const { getConfig } = await import('../stores/config.ts');
    const { Config } = await import('../lib/Config.ts');
    const { useStartupStore } = await import('../stores/startup.ts');
    const { getAccountSecurity } = await import('../stores/wallets.ts');
    const { default: basicEmitter } = await import('../emitters/basicEmitter.ts');
    const mnemonic = 'test test test test test test test test test test test junk';
    const token = 'synthetic-digitalocean-token';
    const passcode = 'synthetic startup passcode';
    const key = Buffer.alloc(32, 0x37);
    const wrappingKey = scryptSync(passcode, Buffer.alloc(16), 32, {
      N: 131072,
      r: 8,
      p: 1,
      maxmem: 256 * 1024 * 1024,
    });
    const encrypt = (plaintext: string) => {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      return Buffer.concat([nonce, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]).toString('base64');
    };
    const encryptedToken = encrypt(token);
    const wallet = {
      encryptedMnemonic: encrypt(mnemonic),
      meta: WalletKeys.deriveIdentity(mnemonic),
      protection: 'passcode',
    };
    external.native.mockReset().mockImplementation(async (command: string, args: any) => {
      if (command === 'delete_wallet_file') return;
      if (command === 'read_wallet_file') return args.filename === 'wallet.tmp.json' ? null : JSON.stringify(wallet);
      if (command === 'keychain_info')
        return {
          method: 'passcode',
          kdf: { algorithm: 'scrypt', salt: '00'.repeat(16), parameters: { N: 131072, r: 8, p: 1, dkLen: 32 } },
        };
      if (command === 'system_authentication_option') return null;
      expect(Buffer.from(args.authentication.wrappingKey)).toEqual(wrappingKey);
      if (command === 'keychain_encrypt') {
        if (storage === 'encryption failure') throw new Error('Synthetic keychain failure');
        return encrypt(args.plaintext);
      }
      if (command === 'keychain_decrypt')
        return (args.ciphertexts as string[]).map((ciphertext, index) => {
          if (storage === 'decryption failure' && ciphertext === encryptedToken) {
            if (index < (args.requiredCount ?? args.ciphertexts.length))
              throw new Error('Synthetic credential read failed');
            return null;
          }
          const bytes = Buffer.from(ciphertext, 'base64');
          const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
          decipher.setAuthTag(bytes.subarray(-16));
          return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString();
        });
      throw new Error(`Unexpected native command: ${command}`);
    });
    const db = await createTestDb();
    setDbPromise(Promise.resolve(db));
    external.clients = {
      get: () => new Promise(() => undefined),
      events: createTypedEventEmitter(),
    } as unknown as MainchainClients;
    external.client = undefined;
    external.tracker = { load: async () => undefined } as unknown as TransactionTracker;
    await db.configTable.insertOrReplace({
      walletAccountsHadPreviousLife: 'false',
      certificationDetails: JsonExt.stringify({ hasSavedMnemonic: true }),
      userJurisdiction: JsonExt.stringify({
        ...(Config.getDefault('userJurisdiction') as IConfig['userJurisdiction']),
        countryCode: 'US',
      }),
      serverAdd: JsonExt.stringify({
        digitalOcean:
          storage === 'encrypted' || storage === 'decryption failure'
            ? { encryptedApiKey: encryptedToken }
            : { apiKey: token },
      }),
    });
    let promptCount = 0;
    let approvalOpen = false;
    const approve = async (prompt: import('../emitters/basicEmitter.ts').IAccountAuthenticationRequest) => {
      promptCount += 1;
      approvalOpen = true;
      try {
        await prompt.verify(passcode);
        approvalOpen = false;
        prompt.resolve();
      } catch (error) {
        prompt.reject(error instanceof Error ? error : new Error(String(error)));
      }
    };
    basicEmitter.on('requestAccountAuthentication', approve);
    const provision = vi.fn(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      expect(approvalOpen).toBe(false);
      expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${token}`);
      if (init?.body && JSON.parse(init.body as string).name === 'perm-scope-probe') return Response.json({});
      throw new Error('Synthetic provider unavailable');
    });
    vi.stubGlobal('fetch', provision);
    const store = useStartupStore();
    try {
      const config = getConfig();
      await config.load();
      await store.initialize();
      expect(store.isWalletReady).toBe(true);
      expect(external.native.mock.calls.some(([command]) => command === 'cleanup_mnemonic_files')).toBe(false);
      expect(promptCount).toBe(1);
      const saved = await db.configTable.fetchAllAsObject();
      const connection = JsonExt.parse<IConfig['serverAdd']>(saved.serverAdd!)!.digitalOcean!;
      expect(getConfig().serverAdd?.digitalOcean).toEqual(connection);
      if (storage === 'encryption failure') {
        expect(connection.apiKey).toBe(token);
        expect(config.digitalOceanApiKey).toBeUndefined();
        expect(provision).not.toHaveBeenCalled();
      } else if (storage === 'decryption failure') {
        expect(connection.encryptedApiKey).toBe(encryptedToken);
        expect(config.digitalOceanApiKey).toBeUndefined();
        expect(provision).not.toHaveBeenCalled();
      } else {
        expect(config.digitalOceanApiKey).toBe(token);
        expect(promptCount).toBe(1);
        expect(external.native.mock.calls.filter(([command]) => command === 'keychain_decrypt')).toHaveLength(1);
        config.selectedTab = 'Mining' as IConfig['selectedTab'];
        await config.save();
        expect((await db.configTable.fetchAllAsObject()).serverAdd).not.toContain(token);
        expect(saved.serverAdd).not.toContain(token);
        expect(connection.apiKey).toBeUndefined();
        expect(provision).toHaveBeenCalledOnce();
        const bytes = Buffer.from(connection.encryptedApiKey!, 'base64');
        const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
        decipher.setAuthTag(bytes.subarray(-16));
        expect(Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString()).toBe(token);

        const nativeAccesses = external.native.mock.calls.length;
        await store.installer!.connect(config.serverAdd!, getAccountSecurity());
        await vi.waitFor(() => expect(provision).toHaveBeenCalledTimes(3));
        await vi.waitFor(() => expect(store.installer!.isRunning).toBe(false));
        expect(promptCount).toBe(1);
        expect(external.native).toHaveBeenCalledTimes(nativeAccesses);
        expect(JsonExt.parse((await db.configTable.fetchAllAsObject()).serverAdd!).digitalOcean).toEqual(connection);
      }
      expect(store.installer?.isRunning).toBe(false);
      expect(store.installer?.reasonToSkipInstall).not.toBe('InstallAlreadyRunning');
      expect(getConfig().serverInstaller.errorMessage).toBeTruthy();
    } finally {
      store.bot?.dispose();
      store.installer?.stop();
      basicEmitter.off('requestAccountAuthentication', approve);
      setDbPromise(undefined);
      await db.close();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  },
);

it.each([true, false])(
  'enrolls upstream recovery with startup/connection approval, without unlocking for a session refresh (RPC connected: %s)',
  async connectedOnStartup => {
    vi.resetModules();
    delete (globalThis as { __argonConfig?: unknown }).__argonConfig;
    setActivePinia(createPinia());
    vi.stubGlobal('ResizeObserver', class {});
    await cryptoWaitReady();
    const { createTestDb } = await import('./helpers/db.ts');
    const { setDbPromise } = await import('../stores/helpers/dbPromise.ts');
    const { WalletKeys } = await import('../lib/WalletKeys.ts');
    const { Config } = await import('../lib/Config.ts');
    const { useStartupStore } = await import('../stores/startup.ts');
    const { getWalletKeys } = await import('../stores/wallets.ts');
    const { getUpstreamOperatorAuthClient } = await import('../stores/server.ts');
    const { enrollUpstreamRecovery } = await import('../stores/bootstrapRecovery.ts');
    const mnemonic = 'test test test test test test test test test test test junk';
    const reference = WalletKeys.fromMnemonic(mnemonic);
    const recoverySeed = await reference.getUpstreamEndpointRecoverySeed();
    const savedRecovery = await encryptBootstrapRecovery(
      { version: 1, endpointSecret: `0x${'21'.repeat(32)}` },
      recoverySeed,
    );
    const db = await createTestDb();
    setDbPromise(Promise.resolve(db));
    await db.configTable.insertOrReplace({
      walletAccountsHadPreviousLife: 'false',
      upstreamOperator: JsonExt.stringify({
        name: 'Synthetic operator',
        encryptedBootstrapRecovery: u8aToHex(savedRecovery),
      }),
      userJurisdiction: JsonExt.stringify({
        ...(Config.getDefault('userJurisdiction') as IConfig['userJurisdiction']),
        countryCode: 'US',
      }),
    });
    external.wallet = {
      encryptedMnemonic: 'synthetic-ciphertext',
      meta: WalletKeys.deriveIdentity(mnemonic),
      protection: 'none',
    };
    external.decryptions = 0;
    const approvedUnlocks = 1;
    external.native.mockReset().mockImplementation(async (command: string, args: any) => {
      if (command === 'delete_wallet_file') return;
      if (command === 'read_wallet_file' && args.filename === 'wallet.tmp.json') return null;
      if (command === 'read_wallet_file') return JSON.stringify(external.wallet);
      if (command === 'keychain_info') return { method: 'system' };
      if (command === 'system_authentication_option') return null;
      if (command === 'keychain_decrypt') {
        if (++external.decryptions > approvedUnlocks) throw new Error('Fresh approval required');
        return [mnemonic];
      }
      throw new Error(`Unexpected native command: ${command}`);
    });
    let currentRecovery: Uint8Array | undefined;
    let pendingRecovery: string;
    const tx = {};
    const retained: IKeyringPair[] = [];
    const challenge = new TextEncoder().encode('synthetic upstream enrollment');
    let connected = connectedOnStartup;
    let finishConnecting!: VoidFunction;
    const connection = new Promise<void>(resolve => {
      finishConnecting = resolve;
    });
    if (connected) finishConnecting();
    external.client = {
      get isConnected() {
        return connected;
      },
      query: {
        system: { account: async () => ({ data: { free: 1_000_000n } }) },
        bootstrap: { encryptedRecoveryPayloadByPubkey: async () => currentRecovery },
      },
      tx: {
        bootstrap: {
          setRecoveryPayload: (_key: Uint8Array, _proof: string, ciphertext: string) => {
            pendingRecovery = ciphertext;
            return tx;
          },
        },
      },
    } as unknown as ArgonClient;
    external.clients = {
      get: async () => {
        await connection;
        return external.client;
      },
      get currentClient() {
        return connected ? external.client : undefined;
      },
      events: createTypedEventEmitter(),
    } as unknown as MainchainClients;
    external.tracker = {
      submitAndWatch: async ({ txSigner }: Parameters<TransactionTracker['submitAndWatch']>[0]) => {
        expect(
          signatureVerify(
            challenge,
            'sign' in txSigner ? txSigner.sign(challenge) : new Uint8Array(),
            reference.defaultArgonAddress,
          ).isValid,
        ).toBe(true);
        if ('sign' in txSigner) retained.push(txSigner);
        return {
          txResult: {
            waitForFinalizedBlock: Promise.resolve().then(() => {
              currentRecovery = hexToU8a(pendingRecovery);
            }),
          },
        };
      },
    } as unknown as TransactionTracker;
    const store = useStartupStore();
    try {
      await store.initialize();
      if (connected) await vi.waitFor(() => expect(currentRecovery).toEqual(savedRecovery));
      else expect(currentRecovery).toBeUndefined();
      expect(external.decryptions).toBe(1);
      if (connected)
        expect(signatureVerify(challenge, retained[0].sign(challenge), reference.defaultArgonAddress).isValid).toBe(
          true,
        );

      connected = true;
      finishConnecting();

      const keys = getWalletKeys();
      const member = await keys.getUpstreamOperatorAuthSigner();
      let endpointSecret = `0x${'22'.repeat(32)}`;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string | URL) => {
          const url = new URL(String(input));
          if (url.pathname === '/auth/challenge')
            return new Response(
              JsonExt.stringify({
                role: UserRole.Member,
                authAccountId: member.address,
                nonce: 'synthetic-nonce',
                expiresAt: Date.now() + 60_000,
              }),
            );
          if (url.pathname === '/auth/login')
            return new Response(
              JsonExt.stringify({
                sessionId: 'synthetic-session',
                role: UserRole.Member,
                expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
                bootstrapEndpointSecret: endpointSecret,
              }),
            );
          if (url.pathname === '/auth/verify/member') return new Response(null, { status: 204 });
          throw new Error(`Unexpected synthetic auth path: ${url.pathname}`);
        }),
      );
      const auth = getUpstreamOperatorAuthClient();
      await auth.getMemberSessionId('https://operator.example');
      await enrollUpstreamRecovery();
      expect(await decryptBootstrapRecovery(currentRecovery!, recoverySeed)).toMatchObject({ endpointSecret });
      expect(external.decryptions).toBe(1);
      expect(signatureVerify(challenge, retained.at(-1)!.sign(challenge), reference.defaultArgonAddress).isValid).toBe(
        true,
      );

      endpointSecret = `0x${'23'.repeat(32)}`;
      await auth.invalidateMemberSessionId('https://operator.example');
      await auth.getMemberSessionId('https://operator.example');
      await new Promise(resolve => setImmediate(resolve));
      const saved = JsonExt.parse<IConfig['upstreamOperator']>(
        (await db.configTable.fetchAllAsObject()).upstreamOperator!,
      );
      expect(await decryptBootstrapRecovery(hexToU8a(saved!.encryptedBootstrapRecovery), recoverySeed)).toMatchObject({
        endpointSecret,
      });
      await vi.waitFor(async () => {
        expect(await decryptBootstrapRecovery(currentRecovery!, recoverySeed)).toMatchObject({ endpointSecret });
      });
      expect(external.decryptions).toBe(1);
    } finally {
      store.bot?.dispose();
      store.installer?.stop();
      const { useRuntimeCompatibility } = await import('../stores/runtimeCompatibility.ts');
      useRuntimeCompatibility().$dispose();
      setDbPromise(undefined);
      await db.close();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  },
);

it.each([
  'database load failure',
  'configuration read failure',
  'read failure',
  'unreadable account',
  'unlock failure',
  'cancelled approval',
  'secure storage failure',
  'configuration failure',
] as const)('shows a readable startup error without native details, then clears it after retry (%s)', async failure => {
  vi.resetModules();
  delete (globalThis as { __argonConfig?: unknown }).__argonConfig;
  setActivePinia(createPinia());
  vi.stubGlobal('ResizeObserver', class {});
  await cryptoWaitReady();
  const { createTestDb } = await import('./helpers/db.ts');
  const { setDbPromise } = await import('../stores/helpers/dbPromise.ts');
  const { WalletKeys } = await import('../lib/WalletKeys.ts');
  const { useStartupStore } = await import('../stores/startup.ts');
  const { default: basicEmitter } = await import('../emitters/basicEmitter.ts');
  const cancelApproval = (request: import('../emitters/basicEmitter.ts').IAccountAuthenticationRequest) =>
    request.reject(nativeError);
  const mnemonic = 'test test test test test test test test test test test junk';
  const wallet = JSON.stringify({
    encryptedMnemonic: 'synthetic-ciphertext',
    meta: WalletKeys.deriveIdentity(mnemonic),
  });
  const nativeError = new Error('Synthetic native failure: /synthetic/private/profile/wallet.json (OS error 13)');
  let blocked = true;
  external.native.mockReset().mockImplementation(async (command: string, args: any) => {
    if (command === 'sql_start_transaction_session') {
      if (blocked && failure === 'database load failure') throw nativeError;
      return;
    }
    if (command === 'delete_wallet_file') return;
    if (command === 'read_wallet_file' && args.filename === 'wallet.tmp.json') return null;
    if (command === 'read_wallet_file') {
      if (blocked && failure === 'secure storage failure') return null;
      if (blocked && failure === 'read failure') throw nativeError;
      if (blocked && failure === 'unreadable account') return 'not valid JSON';
      return wallet;
    }
    if (command === 'keychain_info') {
      if (blocked && failure === 'secure storage failure') throw nativeError;
      if (blocked && failure === 'cancelled approval') {
        return {
          method: 'passcode',
          kdf: {
            algorithm: 'scrypt',
            parameters: { N: 131072, r: 8, p: 1, dkLen: 32 },
            salt: '01010101010101010101010101010101',
          },
        };
      }
      return { method: failure === 'unlock failure' ? 'system' : 'none' };
    }
    if (command === 'system_authentication_option') return null;
    if (command === 'request_system_authentication') throw nativeError;
    if (command === 'keychain_decrypt') {
      if (blocked && failure === 'unlock failure') throw nativeError;
      return [mnemonic];
    }
    throw new Error(`Unexpected native command: ${command}`);
  });
  const db = await createTestDb();
  setDbPromise(failure === 'database load failure' ? undefined : Promise.resolve(db));
  await db.configTable.insertOrReplace({
    ...(failure === 'configuration failure' ? {} : { walletAccountsHadPreviousLife: 'false' }),
    userJurisdiction: JsonExt.stringify({ countryCode: 'US' }),
  });
  if (failure === 'configuration read failure') {
    vi.spyOn(db.sql, 'select').mockRejectedValueOnce(nativeError);
  }
  external.clients = {
    get: () => new Promise(() => undefined),
    events: createTypedEventEmitter(),
  } as unknown as MainchainClients;
  external.tracker = { load: async () => undefined } as unknown as TransactionTracker;
  if (failure === 'configuration failure') {
    external.clients = {
      get: async () => {
        throw nativeError;
      },
      events: createTypedEventEmitter(),
    } as unknown as MainchainClients;
  }
  basicEmitter.on('requestAccountAuthentication', cancelApproval);
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const store = useStartupStore();
  try {
    await expect(store.initialize()).rejects.toThrow();
    expect(store.isWalletReady).toBe(failure === 'configuration failure');
    expect(store.isLoading).toBe(false);
    const messages = {
      'database load failure': 'Your account could not be opened. Please try again.',
      'configuration read failure': 'Your account could not be opened. Please try again.',
      'read failure': 'Your saved account could not be read.',
      'unreadable account': 'Your saved account could not be read.',
      'unlock failure': 'Your device could not unlock this account. Please try again.',
      'cancelled approval': 'Your account is still locked. Try again to unlock it.',
      'secure storage failure': 'Your account could not be opened. Please try again.',
      'configuration failure': 'Your account could not be opened. Please try again.',
    };
    expect(store.errorMessage).toBe(messages[failure]);
    expect(store.errorMessage).not.toMatch(/wallet\.json|OS error|synthetic|backup|profile/i);
    expect(log.mock.calls.flat().some(value => value === nativeError || value?.cause === nativeError)).toBe(
      failure !== 'unreadable account',
    );

    blocked = false;
    if (['database load failure', 'configuration read failure', 'configuration failure'].includes(failure)) {
      const reload = vi.fn();
      vi.stubGlobal('window', { location: { reload } });
      await store.initialize();
      expect(reload).toHaveBeenCalledOnce();
      return;
    }
    await store.initialize();
    expect(store.isWalletReady).toBe(true);
    expect(store.isLoading).toBe(false);
    expect(store.errorMessage).toBe('');
  } finally {
    store.bot?.dispose();
    store.installer?.stop();
    basicEmitter.off('requestAccountAuthentication', cancelApproval);
    setDbPromise(undefined);
    await db.close();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

it.each([
  'published',
  'port changed',
  'registration missing',
  'publication rejected',
  'funding delayed',
  'upstream recovery pending',
  'unsupported webview',
  'runtime incompatible',
] as const)(
  'reconciles server registration with approved startup/setup access using session signing (%s)',
  async outcome => {
    vi.resetModules();
    delete (globalThis as { __argonConfig?: unknown }).__argonConfig;
    setActivePinia(createPinia());
    vi.stubGlobal('ResizeObserver', class {});
    if (outcome === 'unsupported webview') vi.stubGlobal('ResizeObserver', undefined);
    let compatibleSpecVersion = 160;
    if (outcome === 'runtime incompatible') {
      vi.stubGlobal('__ARGON_APP_ENABLE_AUTOUPDATE__', true);
      vi.stubGlobal('fetch', async () => Response.json({ '2.5.1': { maxSpecVersion: compatibleSpecVersion } }));
    }
    await cryptoWaitReady();
    const { createTestDb } = await import('./helpers/db.ts');
    const { setDbPromise } = await import('../stores/helpers/dbPromise.ts');
    const { WalletKeys } = await import('../lib/WalletKeys.ts');
    const { Config } = await import('../lib/Config.ts');
    const { ServerAdmin, InstallStepStatusType } = await import('../lib/ServerAdmin.ts');
    const { SSH } = await import('../lib/SSH.ts');
    const { ServerApiClient } = await import('../lib/ServerApiClient.ts');
    const { BotWsClient } = await import('../lib/BotWsClient.ts');
    const { WalletRecovery } = await import('../lib/WalletRecovery.ts');
    const { useStartupStore, getAppStartup, getInstaller, getBot } = await import('../stores/startup.ts');
    const { getConfig } = await import('../stores/config.ts');
    const { getWalletKeys } = await import('../stores/wallets.ts');
    const mnemonic = 'test test test test test test test test test test test junk';
    const reference = WalletKeys.fromMnemonic(mnemonic);
    external.wallet = {
      encryptedMnemonic: 'synthetic-ciphertext',
      meta: WalletKeys.deriveIdentity(mnemonic),
      protection: 'none',
    };
    external.decryptions = 0;
    const approvedUnlocks = 1;
    external.native.mockReset().mockImplementation(async (command: string, args: any) => {
      if (command === 'delete_wallet_file') return;
      if (command === 'read_wallet_file' && args.filename === 'wallet.tmp.json') return null;
      if (command === 'read_wallet_file') return JSON.stringify(external.wallet);
      if (command === 'keychain_info') return { method: 'system' };
      if (command === 'system_authentication_option') return null;
      if (command === 'read_embedded_file') return 'synthetic-sha server-1.0.0.tar.gz';
      if (command === 'keychain_decrypt') {
        external.decryptions += 1;
        if (external.decryptions > approvedUnlocks) throw new Error('Fresh approval required');
        return [mnemonic];
      }
      throw new Error(`Unexpected native command: ${command}`);
    });
    const db = await createTestDb();
    setDbPromise(Promise.resolve(db));
    await db.configTable.insertOrReplace({
      walletAccountsHadPreviousLife: String(outcome === 'upstream recovery pending'),
      isServerInstalled: 'true',
      showWelcomeOverlay: 'false',
      postWelcomeLaunchCount: '2',
      userJurisdiction: JsonExt.stringify({
        ...(Config.getDefault('userJurisdiction') as IConfig['userJurisdiction']),
        countryCode: 'US',
      }),
      serverDetails: JsonExt.stringify({
        type: ServerType.CustomServer,
        ipAddress: '203.0.113.10',
        sshUser: 'argon',
        sshPort: 2222,
        workDir: '/srv/argon',
        gatewayPort: 443,
        bootstrapEndpointIndex: 2,
      }),
    });
    const endpointSecret = await reference.getOwnServerBootstrapEndpointSecret(2);
    let currentEndpoint: Uint8Array | undefined = await encryptBootstrapEndpoint(
      {
        version: 1,
        host: '203.0.113.9',
        port: 443,
        sequence: 1,
      },
      endpointSecret,
    );
    const recoverySeed = await reference.getOwnServerEndpointRecoverySeed();
    const upstreamRecoverySeed = await reference.getUpstreamEndpointRecoverySeed();
    const upstreamRecoveryPubkey = new Keyring({ type: 'ed25519' }).addFromSeed(
      hexToU8a(upstreamRecoverySeed),
    ).publicKey;
    let finishUpstreamRecovery!: () => void;
    const upstreamRecovery = new Promise<undefined>(resolve => {
      finishUpstreamRecovery = () => resolve(undefined);
    });
    if (outcome === 'upstream recovery pending') {
      // Historical scanning is separate from the startup/installer eligibility race under review.
      vi.spyOn(WalletRecovery.prototype, 'findHistory').mockResolvedValue({
        miningHistory: [{ frameId: 40, seats: [], bids: [] }],
      });
    }
    let currentRecovery: Uint8Array | undefined = await encryptBootstrapRecovery(
      { version: 1, endpointSecret, endpointIndex: 2, ssh: { user: 'argon', port: 22 } },
      recoverySeed,
    );
    if (outcome === 'registration missing') {
      currentEndpoint = undefined;
      currentRecovery = undefined;
    }
    let balance = outcome === 'funding delayed' ? 0n : 1_000_000n;
    const endpointTx = {};
    const recoveryTx = {};
    let submittedCiphertext: string | undefined;
    let submittedRecovery: string | undefined;
    let endpointSubmissions = 0;
    let endpointReads = 0;
    let failRecoveryRead = false;
    let retainedSigner: IKeyringPair | undefined;
    let finishPublication!: () => void;
    const finalization = new Promise<void>((resolve, reject) => {
      finishPublication = () => {
        if (outcome === 'publication rejected') reject(new Error('Synthetic publication rejected'));
        else resolve();
      };
    });
    external.client = {
      rpc: {
        state: {
          getRuntimeVersion: async () => ({ specVersion: { toNumber: () => 161 } }),
          subscribeRuntimeVersion: async () => () => undefined,
        },
      },
      query: {
        system: { account: async () => ({ data: { free: balance } }) },
        bootstrap: {
          encryptedEndpointByPubkey: async () => {
            endpointReads += 1;
            return currentEndpoint;
          },
          endpointOwnerByPubkey: async () => reference.defaultArgonAddress,
          encryptedRecoveryPayloadByPubkey: async (pubkey: Uint8Array) => {
            if (failRecoveryRead) throw new Error('Synthetic recovery unavailable');
            if (outcome === 'upstream recovery pending' && u8aToHex(pubkey) === u8aToHex(upstreamRecoveryPubkey)) {
              return upstreamRecovery;
            }
            return currentRecovery;
          },
        },
      },
      tx: {
        bootstrap: {
          setEndpoint: (_key: Uint8Array, ciphertext: string) => {
            submittedCiphertext = ciphertext;
            return endpointTx;
          },
          setRecoveryPayload: (_key: Uint8Array, _proof: string, ciphertext: string) => {
            submittedRecovery = ciphertext;
            return recoveryTx;
          },
        },
      },
    } as unknown as ArgonClient;
    external.clients = {
      archiveClientPromise: Promise.resolve(external.client),
      get: async () => external.client,
      currentClient: external.client,
      events: createTypedEventEmitter(),
    } as unknown as MainchainClients;
    external.tracker = {
      submitAndWatch: async ({ tx, txSigner }: Parameters<TransactionTracker['submitAndWatch']>[0]) => {
        if ('sign' in txSigner) retainedSigner = txSigner;
        if (tx === recoveryTx) {
          return {
            txResult: {
              waitForFinalizedBlock: Promise.resolve().then(() => {
                currentRecovery = hexToU8a(submittedRecovery);
              }),
            },
          };
        }
        const confirmation = endpointSubmissions++ === 0 ? finalization : Promise.resolve();
        return {
          txResult: {
            waitForFinalizedBlock: confirmation.then(() => {
              currentEndpoint = hexToU8a(submittedCiphertext);
            }),
          },
        };
      },
    } as unknown as TransactionTracker;
    vi.spyOn(SSH, 'setConfig').mockImplementation(() => undefined);
    vi.spyOn(SSH, 'getOrCreateConnection').mockResolvedValue(
      {} as Awaited<ReturnType<typeof SSH.getOrCreateConnection>>,
    );
    vi.spyOn(ServerAdmin.prototype, 'downloadAccountAddress').mockResolvedValue(reference.miningBotAddress);
    vi.spyOn(ServerAdmin.prototype, 'uploadInstallManifest').mockResolvedValue();
    vi.spyOn(ServerAdmin.prototype, 'downloadRemoteShasum').mockResolvedValue('synthetic-sha server-1.0.0.tar.gz');
    vi.spyOn(ServerAdmin.prototype, 'downloadInstallStepStatuses').mockResolvedValue(
      Object.fromEntries(Object.values(InstallStepKey).map(key => [key, InstallStepStatusType.Finished])),
    );
    vi.spyOn(ServerAdmin.prototype, 'isInstallerScriptRunning').mockResolvedValue(false);
    vi.spyOn(ServerApiClient.prototype, 'isGatewayReady').mockResolvedValue(false);
    const connectBot = vi
      .spyOn(BotWsClient, 'connectToServerGateway')
      .mockRejectedValue(new Error('Synthetic gateway offline'));
    const store = useStartupStore();
    let initialization = store.initialize();
    let concurrentInitialization = store.initialize();
    let endpointPublication: Promise<void> | undefined;
    try {
      if (outcome === 'runtime incompatible') {
        await Promise.all([initialization, concurrentInitialization]);
        const { useRuntimeCompatibility } = await import('../stores/runtimeCompatibility.ts');
        const compatibility = useRuntimeCompatibility();
        await vi.waitFor(() => expect(compatibility.phase).toBe('paused'));
        expect(store.isWalletReady).toBe(false);
        expect(external.decryptions).toBe(0);
        expect((await db.configTable.fetchAllAsObject()).postWelcomeLaunchCount).toBe('2');

        compatibleSpecVersion = 161;
        await compatibility.refreshCompatibility('manual');
        expect(compatibility.shouldShowCompatibilityScreen).toBe(false);
        initialization = store.initialize();
        concurrentInitialization = store.initialize();
      }
      if (outcome === 'unsupported webview') {
        await Promise.all([initialization, concurrentInitialization]);
        const { useRuntimeCompatibility } = await import('../stores/runtimeCompatibility.ts');
        expect(useRuntimeCompatibility().isBrowserUnsupported).toBe(true);
        expect(store.isWalletReady).toBe(false);
        expect(external.decryptions).toBe(0);
        expect(() => getAppStartup()).toThrow('App startup has not initialized');
        expect(() => getInstaller()).toThrow('Installer startup has not initialized');
        expect(() => getBot()).toThrow('Bot startup has not initialized');
        expect((await db.configTable.fetchAllAsObject()).postWelcomeLaunchCount).toBe('2');
        return;
      }

      if (outcome === 'funding delayed') {
        await Promise.all([initialization, concurrentInitialization]);
        expect(retainedSigner).toBeUndefined();
      } else {
        await vi.waitFor(() => expect(endpointSubmissions).toBe(1));
      }
      expect(store.isWalletReady).toBe(true);
      expect(getAppStartup().isReady).toBe(true);
      expect(external.decryptions).toBe(1);
      const challenge = new TextEncoder().encode('synthetic startup publication');
      if (retainedSigner) {
        expect(signatureVerify(challenge, retainedSigner.sign(challenge), reference.defaultArgonAddress).isValid).toBe(
          true,
        );
      }
      expect(
        JsonExt.parse((await db.configTable.fetchAllAsObject()).serverDetails!).bootstrapEndpointSequence,
      ).toBeUndefined();

      expect(getInstaller().isLoaded).toBe(true);
      await vi.waitFor(() => expect(connectBot).toHaveBeenCalled());

      if (outcome === 'published') {
        await vi.waitFor(() => expect(store.isLoading).toBe(false));
        expect(
          JsonExt.parse((await db.configTable.fetchAllAsObject()).serverDetails!).bootstrapEndpointSequence,
        ).toBeUndefined();
        const { publishOwnServerEndpoint } = await import('../stores/bootstrapRecovery.ts');
        endpointPublication = publishOwnServerEndpoint();
        expect(
          await Promise.race([
            endpointPublication.then(() => 'published'),
            new Promise(resolve => setTimeout(() => resolve('pending'), 100)),
          ]),
        ).toBe('pending');
      }

      finishPublication();
      await endpointPublication;
      if (outcome === 'published') expect(endpointSubmissions).toBe(1);
      if (outcome === 'upstream recovery pending') {
        await vi.waitFor(() => {
          expect(getInstaller().isLoaded).toBe(true);
          expect(
            signatureVerify(challenge, retainedSigner!.sign(challenge), reference.defaultArgonAddress).isValid,
          ).toBe(true);
          expect(connectBot).toHaveBeenCalled();
        });
        await vi.waitFor(async () => {
          const settings = await db.configTable.fetchAllAsObject();
          expect(JsonExt.parse(settings.serverDetails!).bootstrapEndpointSequence).toBe(2);
        });
        const saved = await db.configTable.fetchAllAsObject();
        expect(JsonExt.parse(saved.serverDetails!).bootstrapEndpointSequence).toBe(2);
        expect(JsonExt.parse(saved.serverDetails!).ipAddress).toBe('203.0.113.10');
        expect(saved.walletPreviousLifeRecovered).not.toBe('true');
        expect(getAppStartup().isRecoveringHistory).toBe(true);
        expect(external.decryptions).toBe(1);
        finishUpstreamRecovery();
      }
      await Promise.all([initialization, concurrentInitialization]);

      const expectedSequence = outcome === 'registration missing' ? 1 : 2;
      if (outcome !== 'publication rejected' && outcome !== 'funding delayed') {
        await vi.waitFor(async () => {
          expect(
            JsonExt.parse((await db.configTable.fetchAllAsObject()).serverDetails!).bootstrapEndpointSequence,
          ).toBe(expectedSequence);
        });
      }
      const saved = await db.configTable.fetchAllAsObject();
      if (outcome === 'upstream recovery pending') {
        expect(saved.walletPreviousLifeRecovered).toBe('true');
        expect(saved.oldestFrameIdToSync).toBe('40');
        expect(saved.hasMiningBids).toBe('true');
        expect(getAppStartup().isRecoveringHistory).toBe(false);
      }
      if (outcome === 'publication rejected' || outcome === 'funding delayed') {
        expect(JsonExt.parse(saved.serverDetails!).bootstrapEndpointSequence).toBeUndefined();
      } else {
        expect(JsonExt.parse(saved.serverDetails!).bootstrapEndpointSequence).toBe(expectedSequence);
      }
      expect(saved.postWelcomeLaunchCount).toBe('3');
      expect(getInstaller().isLoaded).toBe(true);
      expect(external.decryptions).toBe(1);
      if (retainedSigner)
        expect(signatureVerify(challenge, retainedSigner.sign(challenge), reference.defaultArgonAddress).isValid).toBe(
          true,
        );

      if (outcome === 'publication rejected' || outcome === 'funding delayed') {
        // Reconnecting an up-to-date server skips installation, but must still retry publication using the unlocked session.
        const finalizedRecovery = currentRecovery;
        if (outcome === 'publication rejected') {
          expect(await decryptBootstrapRecovery(finalizedRecovery!, recoverySeed)).toMatchObject({
            ssh: { user: 'argon', port: 2222 },
          });
        }
        balance = 1_000_000n;
        await getInstaller().run();
        await vi.waitFor(async () => {
          expect(
            JsonExt.parse((await db.configTable.fetchAllAsObject()).serverDetails!).bootstrapEndpointSequence,
          ).toBe(expectedSequence);
        });
        expect(external.decryptions).toBe(1);
        if (outcome === 'publication rejected') expect(currentRecovery).toEqual(finalizedRecovery);
      }

      expect(await decryptBootstrapEndpoint(currentEndpoint!, endpointSecret)).toMatchObject({
        host: '203.0.113.10',
        port: 443,
        sequence: expectedSequence,
      });
      expect(await decryptBootstrapRecovery(currentRecovery!, recoverySeed)).toMatchObject({
        endpointIndex: 2,
        ssh: { user: 'argon', port: 2222 },
      });
      expect(JsonExt.parse((await db.configTable.fetchAllAsObject()).serverDetails!).bootstrapEndpointSequence).toBe(
        expectedSequence,
      );
      expect(signatureVerify(challenge, retainedSigner!.sign(challenge), reference.defaultArgonAddress).isValid).toBe(
        true,
      );
      if (outcome === 'port changed') {
        const config = getConfig();
        config.serverDetails = { ...config.serverDetails, type: ServerType.LocalComputer };
        vi.spyOn(ServerAdmin.prototype, 'waitForGatewayPort').mockResolvedValue(9443);
        failRecoveryRead = true;
        await getInstaller().refreshLocalGatewayPort();
        expect(await decryptBootstrapEndpoint(currentEndpoint!, endpointSecret)).toMatchObject({
          host: '203.0.113.10',
          port: 9443,
          sequence: expectedSequence + 1,
        });
        expect(JsonExt.parse((await db.configTable.fetchAllAsObject()).serverDetails!)).toMatchObject({
          gatewayPort: 9443,
          bootstrapEndpointSequence: expectedSequence + 1,
        });
        expect(external.decryptions).toBe(1);
        const readsAfterPortChange = endpointReads;
        await getInstaller().refreshLocalGatewayPort();
        expect(endpointReads).toBe(readsAfterPortChange);
      }
      await expect(getWalletKeys().exposeMasterMnemonic()).rejects.toThrow('Fresh approval required');
    } finally {
      finishPublication();
      finishUpstreamRecovery();
      await Promise.allSettled([initialization, concurrentInitialization]);
      await endpointPublication;
      store.bot?.dispose();
      store.installer?.stop();
      const { useRuntimeCompatibility } = await import('../stores/runtimeCompatibility.ts');
      useRuntimeCompatibility().$dispose();
      setDbPromise(undefined);
      await db.close();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  },
);
