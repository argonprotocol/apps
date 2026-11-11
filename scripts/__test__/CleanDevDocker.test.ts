import { cleanDevDocker } from '../../dev/cleanDocker.ts';
import { stopDevEnvironment } from '../../dev/stopEnvironment.ts';
import Fs from 'node:fs';
import Os from 'node:os';
import Path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('clean dev docker', () => {
  let testDir: string | undefined;

  afterEach(() => {
    if (testDir) Fs.rmSync(testDir, { recursive: true, force: true });
  });

  it.skipIf(process.platform === 'win32')(
    'removes only the Ethereum enclave recorded by this checkout',
    async () => {
      testDir = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'argon-clean-dev-docker-'));
      const binDir = Path.join(testDir, 'bin');
      const runtimeStateDir = Path.join(testDir, 'ethereum-state');
      const removalsPath = Path.join(testDir, 'removed-enclaves.txt');
      const instanceName = `cleanup-test-${process.pid}`;
      const keychainDir = Path.join(testDir, 'synthetic-keychain');
      const account = `dev-docker/${instanceName}`;
      const keychainEntries = [
        `com.argon.desktop.local.mnemonic/${account}`,
        'com.argon.desktop.local.mnemonic/dev-docker/other-profile',
        'com.argon.desktop.mnemonic/mainnet/default',
      ];
      for (const entry of keychainEntries) {
        const entryPath = Path.join(keychainDir, entry);
        Fs.mkdirSync(Path.dirname(entryPath), { recursive: true });
        Fs.writeFileSync(entryPath, 'synthetic credential');
      }
      const configDir =
        process.platform === 'darwin'
          ? Path.join(testDir, 'Library', 'Application Support')
          : Path.join(testDir, 'config');
      const instanceDir = Path.join(configDir, 'com.argon.desktop.local', 'dev-docker', instanceName);
      const vmDir = Path.join(instanceDir, 'virtual-machine');
      Fs.mkdirSync(vmDir, { recursive: true });
      Fs.writeFileSync(Path.join(vmDir, 'docker-compose.yml'), 'services: {}');
      Fs.mkdirSync(binDir, { recursive: true });
      Fs.mkdirSync(runtimeStateDir, { recursive: true });
      Fs.writeFileSync(
        Path.join(runtimeStateDir, 'latest.json'),
        JSON.stringify({
          beaconPreset: 'minimal',
          enclaveName: 'argon-eth-owned',
          executionRpcUrl: 'http://127.0.0.1:32003',
          beaconApiUrl: 'http://127.0.0.1:33001',
          chainId: '0x301824',
          serverExecutionRpcUrl: 'http://host.docker.internal:32003/',
          serverBeaconApiUrl: 'http://host.docker.internal:33001/',
          usdcTokenAddress: '0x5fbdb2315678afecb367f032d93f642f64180aa3',
          setupStatus: 'ready',
          updatedAt: '2026-09-04T12:00:00.000Z',
        }),
      );
      writeExecutable(
        Path.join(binDir, 'kurtosis'),
        `#!/bin/sh
if [ "$1" = "enclave" ] && [ "$2" = "ls" ]; then
  printf 'UUID Name Status Creation Time\\n1 argon-eth-owned RUNNING now\\n2 argon-eth-foreign RUNNING now\\n'
elif [ "$1" = "enclave" ] && [ "$2" = "rm" ]; then
  printf '%s\\n' "$4" >> "$KURTOSIS_REMOVALS"
fi
`,
      );
      writeExecutable(
        Path.join(binDir, 'docker'),
        `#!/bin/sh
if [ "$1" = "network" ] && [ "$2" = "inspect" ]; then
  printf '[]'
fi
`,
      );
      writeExecutable(Path.join(binDir, 'ps'), '#!/bin/sh\n');
      writeExecutable(
        Path.join(binDir, 'security'),
        `#!/bin/sh
while [ "$#" -gt 0 ]; do
  case "$1" in
    -a) shift; account="$1" ;;
    -s) shift; service="$1" ;;
  esac
  shift
done
entry="$SYNTHETIC_KEYCHAIN/$service/$account"
[ -f "$entry" ] || exit 44
rm "$entry"
`,
      );

      const parentInstance = process.env.ARGON_APP_INSTANCE;
      const parentRuntimeStateDir = process.env.ARGON_DEV_ETHEREUM_RUNTIME_STATE_DIR;
      await cleanDevDocker({
        env: {
          ...process.env,
          HOME: testDir,
          XDG_CONFIG_HOME: configDir,
          ARGON_APP_INSTANCE: instanceName,
          ARGON_DEV_ETHEREUM_RUNTIME_STATE_DIR: runtimeStateDir,
          ARGON_DEV_UPSTREAM_DIR: Path.join(testDir, 'upstream'),
          ARGON_NETWORK_NAME: 'dev-docker',
          COMPOSE_PROJECT_NAME: `dev-docker-cleanup-test-${process.pid}`,
          KURTOSIS_REMOVALS: removalsPath,
          SYNTHETIC_KEYCHAIN: keychainDir,
          PATH: `${binDir}${Path.delimiter}${process.env.PATH}`,
        },
      });

      expect(Fs.readFileSync(removalsPath, 'utf8').trim().split('\n')).toEqual(['argon-eth-owned']);
      expect(Fs.existsSync(instanceDir)).toBe(false);
      if (process.platform === 'darwin') {
        expect(keychainEntries.map(entry => Fs.existsSync(Path.join(keychainDir, entry)))).toEqual([false, true, true]);
      }
      expect(process.env.ARGON_APP_INSTANCE).toBe(parentInstance);
      expect(process.env.ARGON_DEV_ETHEREUM_RUNTIME_STATE_DIR).toBe(parentRuntimeStateDir);
    },
    15_000,
  );
});

it
  .skipIf(process.platform === 'win32')
  .each(['present', 'absent', 'unavailable', 'orphaned', 'remove-failed', 'foreign-endpoint'] as const)(
  'resets only the owned environment when its cached Ethereum enclave is %s',
  async enclaveState => {
    const directory = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'argon-dev-reset-'));
    const instanceDir = Path.join(directory, 'reset-test');
    const foreignDir = Path.join(directory, 'other-profile');
    const binDir = Path.join(directory, 'bin');
    const removalsPath = Path.join(directory, 'removed-enclaves');
    const resourcesPath = Path.join(directory, 'docker-resources.json');
    const enclaveId = '1'.repeat(32);
    const resources = {
      container: { 'foreign-container': 'foreign', 'shared-proxy': 'shared' },
      volume: { 'foreign-volume': 'foreign' },
      network: { 'foreign-network': 'foreign' },
      endpoints: { 'foreign-network': ['shared-proxy'] } as Record<string, string[]>,
    };
    if (['orphaned', 'remove-failed', 'foreign-endpoint'].includes(enclaveState)) {
      Object.assign(resources.container, { 'owned-api': enclaveId, 'owned-geth': enclaveId });
      Object.assign(resources.volume, { 'owned-volume': enclaveId });
      Object.assign(resources.network, { 'owned-network': enclaveId });
      resources.endpoints['owned-network'] =
        enclaveState === 'foreign-endpoint' ? ['foreign-container'] : ['shared-proxy'];
    }
    Fs.mkdirSync(Path.join(instanceDir, 'dev-ethereum'), { recursive: true });
    Fs.mkdirSync(foreignDir);
    Fs.mkdirSync(binDir);
    Fs.writeFileSync(Path.join(instanceDir, 'wallet.json'), 'synthetic wallet');
    Fs.writeFileSync(Path.join(foreignDir, 'wallet.json'), 'unrelated synthetic wallet');
    Fs.writeFileSync(
      Path.join(instanceDir, 'dev-ethereum', 'state.json'),
      JSON.stringify({ enclaveName: 'argon-eth-owned' }),
    );
    Fs.writeFileSync(
      Path.join(instanceDir, 'dev-ethereum', 'latest.json'),
      JSON.stringify({ enclaveName: 'argon-eth-owned' }),
    );
    Fs.writeFileSync(
      Path.join(instanceDir, 'dev-ethereum', 'stabilizer-prices.json'),
      JSON.stringify({ argon_usd_price: '0.95' }),
    );
    Fs.writeFileSync(resourcesPath, JSON.stringify(resources));
    writeExecutable(
      Path.join(binDir, 'docker'),
      `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const file = process.env.TEST_DOCKER_RESOURCES;
const resources = JSON.parse(fs.readFileSync(file, 'utf8'));
const kind = args[0] === 'ps' || args[0] === 'rm' ? 'container' : args[0];
if (args[0] === 'ps' || args[1] === 'ls') {
  const filter = args[args.indexOf('--filter') + 1];
  const prefix = 'label=com.kurtosistech.enclave-id=';
  const enclaveId = filter?.startsWith(prefix) ? filter.slice(prefix.length) : undefined;
  for (const [id, owner] of Object.entries(resources[kind] ?? {})) {
    if (owner === enclaveId) console.log(id);
  }
} else if (args[0] === 'inspect') {
  console.log(JSON.stringify(args.at(-1) === 'shared-proxy' ? {
    'com.kurtosistech.app-id': 'kurtosis',
    'com.kurtosistech.container-type': 'kurtosis-reverse-proxy',
  } : null));
} else if (args[0] === 'network' && args[1] === 'inspect') {
  console.log(JSON.stringify(Object.fromEntries(
    (resources.endpoints[args.at(-1)] ?? []).map(id => [id, {}]),
  )));
} else if (args[0] === 'network' && args[1] === 'disconnect') {
  const [, , network, container] = args;
  resources.endpoints[network] = resources.endpoints[network].filter(id => id !== container);
  fs.writeFileSync(file, JSON.stringify(resources));
} else if (args[0] === 'rm' || args[1] === 'rm') {
  for (const id of args.slice(kind === 'container' ? 1 : 2)) {
    if (id.startsWith('-')) continue;
    if (kind === 'network' && resources.endpoints[id]?.length) {
      console.error('network has active endpoints');
      process.exit(1);
    }
    delete resources[kind][id];
    if (kind === 'network') delete resources.endpoints[id];
  }
  fs.writeFileSync(file, JSON.stringify(resources));
}
`,
    );

    writeExecutable(Path.join(binDir, 'security'), '#!/bin/sh\nexit 44\n');
    writeExecutable(
      Path.join(binDir, 'kurtosis'),
      `#!/bin/sh
if [ "$1" = "enclave" ] && [ "$2" = "ls" ]; then
  if [ "$TEST_ENCLAVE_STATE" = "unavailable" ]; then
    printf 'Kurtosis engine unavailable\\n' >&2
    exit 2
  fi
  printf 'UUID Name Status Creation Time\\nforeign argon-eth-other RUNNING now\\n'
  if [ "$TEST_ENCLAVE_STATE" != "absent" ]; then
    printf '${enclaveId} argon-eth-owned STOPPED now\\n'
  fi
elif [ "$1" = "enclave" ] && [ "$2" = "rm" ]; then
  if [ "$TEST_ENCLAVE_STATE" = "orphaned" ] || [ "$TEST_ENCLAVE_STATE" = "foreign-endpoint" ]; then
    printf "No enclave found with identifier '%s'\\n" "$4" >&2
    exit 1
  fi
  if [ "$TEST_ENCLAVE_STATE" = "remove-failed" ]; then
    printf 'Docker permission denied\\n' >&2
    exit 2
  fi
  if [ "$TEST_ENCLAVE_STATE" != "present" ]; then
    printf 'No enclave found with identifier %s\\n' "$4" >&2
    exit 1
  fi
  printf '%s\\n' "$4" >> "$TEST_ENCLAVE_REMOVALS"
else
  exit 2
fi
`,
    );
    for (const key of [
      'ARGON_NETWORK_NAME',
      'COMPOSE_PROJECT_NAME',
      'JOIN_COMPOSE_NETWORK',
      'ARGON_DEV_UPSTREAM_DIR',
      'ARGON_DEV_ETHEREUM_RUNTIME_STATE_DIR',
      'ARGON_CHAIN_SPEC_PATH',
      'ARGON_CHAIN',
    ])
      vi.stubEnv(key, process.env[key]);
    vi.stubEnv('ARGON_APP_INSTANCE_DIR', instanceDir);
    vi.stubEnv('ARGON_APP_INSTANCE', 'reset-test');
    vi.stubEnv('DOCKER_HOST', 'unix:///synthetic-docker.sock');
    vi.stubEnv('PATH', `${binDir}${Path.delimiter}${process.env.PATH}`);
    vi.stubEnv('TEST_ENCLAVE_STATE', enclaveState);
    vi.stubEnv('TEST_ENCLAVE_REMOVALS', removalsPath);
    vi.stubEnv('TEST_DOCKER_RESOURCES', resourcesPath);

    try {
      const resetting = stopDevEnvironment({ network: 'dev-docker', instance: 'reset-test' }, true);
      let message: string | undefined;
      if (enclaveState === 'unavailable') message = 'Kurtosis engine unavailable';
      else if (enclaveState === 'remove-failed') message = 'Could not remove Ethereum enclave';
      else if (enclaveState === 'foreign-endpoint') message = 'Unrecognized container';
      if (message) {
        await expect(resetting).rejects.toThrow(message);
        expect(Fs.existsSync(instanceDir)).toBe(true);
      } else {
        await resetting;
        expect(Fs.existsSync(instanceDir)).toBe(false);
      }
      expect(Fs.readFileSync(Path.join(foreignDir, 'wallet.json'), 'utf8')).toBe('unrelated synthetic wallet');
      const remaining = JSON.parse(Fs.readFileSync(resourcesPath, 'utf8'));
      if (enclaveState === 'orphaned') {
        expect(remaining).toEqual({
          container: { 'foreign-container': 'foreign', 'shared-proxy': 'shared' },
          volume: { 'foreign-volume': 'foreign' },
          network: { 'foreign-network': 'foreign' },
          endpoints: { 'foreign-network': ['shared-proxy'] },
        });
      } else if (enclaveState === 'foreign-endpoint') {
        expect(remaining).toEqual({
          ...resources,
          container: { 'foreign-container': 'foreign', 'shared-proxy': 'shared' },
          volume: { 'foreign-volume': 'foreign' },
        });
      } else expect(remaining).toEqual(resources);
      if (enclaveState === 'present') {
        expect(Fs.readFileSync(removalsPath, 'utf8')).toBe('argon-eth-owned\n');
      } else {
        expect(Fs.existsSync(removalsPath)).toBe(false);
      }
    } finally {
      vi.unstubAllEnvs();
      Fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);

function writeExecutable(filePath: string, contents: string): void {
  Fs.writeFileSync(filePath, contents, { mode: 0o755 });
}
