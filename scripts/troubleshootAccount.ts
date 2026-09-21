#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import Os from 'node:os';
import Path from 'node:path';
import Process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createArgonClient, isValidArgonAccountAddress, NetworkConfig } from '@argonprotocol/apps-core';
import type { ArgonQueryClient, INetworkConfigOverride } from '@argonprotocol/apps-core';
import { getClient } from '@argonprotocol/mainchain';
import type { HistoricalQueryRecord } from '@argonprotocol/runtime-client';
import { u8aToString } from '@polkadot/util';
import { reserveEphemeralPort } from './utils.ts';

const LOCAL_APP_ID = 'com.argon.desktop.local';
const DEFAULT_ETHEREUM_HD_PREFIXES = {
  primary: "m/44'/60'/0'/0'",
  councilSigner: "m/44'/60'/1'/0'",
  mintingAuthority: "m/44'/60'/2'/0'",
} as const;

export type RuntimeOperationalAccount = NonNullable<
  HistoricalQueryRecord<'operationalAccounts', 'operationalAccounts'>
>;

export type ReadonlyAccountLookup = { operatorName: string } | { defaultAccountId: string };

export interface ReadonlyAccountIdentity {
  operatorName: string;
  operationalAccountId: string;
  defaultAccountId: string;
  miningAccountId: string;
}

export async function resolveReadonlyAccount(
  client: ArgonQueryClient,
  lookup: ReadonlyAccountLookup,
): Promise<ReadonlyAccountIdentity> {
  if ('defaultAccountId' in lookup) {
    return await resolveByDefaultAccount(client, lookup.defaultAccountId.trim());
  }

  const operatorName = lookup.operatorName.trim();
  const entries = (await client.query.operationalAccounts.operationalAccounts.entries()) ?? [];
  const matches = entries.flatMap(([key, profile]) => {
    if (!profile || readOperatorName(profile) !== operatorName) return [];
    return [readReadonlyAccountIdentity(String(key.args[0]), profile)];
  });

  if (!matches.length) {
    throw new Error(`No operational account has the operator name "${operatorName}".`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Operator name "${operatorName}" matches multiple accounts: ${matches.map(x => x.defaultAccountId).join(', ')}`,
    );
  }
  return matches[0];
}

export function resolveReadonlyInstanceName(identity: ReadonlyAccountIdentity): string {
  const operatorLabel = identity.operatorName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return `${operatorLabel || `account-${identity.defaultAccountId.slice(0, 8).toLowerCase()}`}-readonly`;
}

function getReadonlyInstanceDirectory(networkName: string, instanceName: string): string {
  let configBaseDirectory: string;
  if (Process.platform === 'darwin') {
    configBaseDirectory = Path.join(Os.homedir(), 'Library', 'Application Support');
  } else if (Process.platform === 'win32') {
    configBaseDirectory = Process.env.APPDATA || Path.join(Os.homedir(), 'AppData', 'Roaming');
  } else {
    configBaseDirectory = Process.env.XDG_CONFIG_HOME || Path.join(Os.homedir(), '.config');
  }
  return Path.join(configBaseDirectory, LOCAL_APP_ID, networkName, instanceName);
}

export function writeReadonlyWallet(instanceDirectory: string, identity: ReadonlyAccountIdentity): string {
  const walletPath = Path.join(instanceDirectory, 'wallet.json');
  const wallet = {
    encryptedMnemonic: '',
    meta: {
      miningHoldAddress: '',
      miningBotAddress: identity.miningAccountId,
      vaultingAddress: identity.defaultAccountId,
      operationalAddress: identity.operationalAccountId,
      ethereumAddress: '',
      ethereumHdPrefixes: DEFAULT_ETHEREUM_HD_PREFIXES,
      sshPublicKey: '',
    },
  };

  if (existsSync(walletPath)) {
    const existing = JSON.parse(readFileSync(walletPath, 'utf8')) as typeof wallet;
    if (
      existing.encryptedMnemonic === '' &&
      existing.meta.vaultingAddress === identity.defaultAccountId &&
      existing.meta.operationalAddress === identity.operationalAccountId &&
      existing.meta.miningBotAddress === identity.miningAccountId &&
      existing.meta.miningHoldAddress === '' &&
      existing.meta.ethereumAddress === '' &&
      existing.meta.sshPublicKey === ''
    ) {
      return walletPath;
    }
    throw new Error(`Refusing to replace the existing wallet at ${walletPath}.`);
  }

  mkdirSync(instanceDirectory, { recursive: true });
  writeFileSync(walletPath, `${JSON.stringify(wallet, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return walletPath;
}

async function resolveByDefaultAccount(
  client: ArgonQueryClient,
  defaultAccountId: string,
): Promise<ReadonlyAccountIdentity> {
  const operationalAccountId = await client.query.operationalAccounts.operationalAccountBySubAccount(defaultAccountId);
  if (!operationalAccountId) {
    return {
      operatorName: '',
      operationalAccountId: '',
      defaultAccountId,
      miningAccountId: '',
    };
  }

  const profile = await client.query.operationalAccounts.operationalAccounts(operationalAccountId);
  if (!profile) {
    throw new Error(`Operational account ${operationalAccountId} has no profile.`);
  }

  const identity = readReadonlyAccountIdentity(operationalAccountId, profile);
  if (identity.defaultAccountId !== defaultAccountId) {
    const label = identity.operatorName || identity.operationalAccountId;
    throw new Error(
      `${defaultAccountId} is linked to ${label}, but it is not the default account ${identity.defaultAccountId}.`,
    );
  }
  return identity;
}

export function readReadonlyAccountIdentity(
  operationalAccountId: string,
  profile: RuntimeOperationalAccount,
): ReadonlyAccountIdentity {
  const miningAccountId = profile.miningAccount ?? profile.miningBotAccount;
  if (!miningAccountId) {
    throw new Error(`Operational account ${operationalAccountId} has no linked mining account.`);
  }
  return {
    operatorName: readOperatorName(profile),
    operationalAccountId,
    defaultAccountId: profile.vaultAccount,
    miningAccountId,
  };
}

function readOperatorName(profile: RuntimeOperationalAccount): string {
  return profile.name ? u8aToString(profile.name).trim() : '';
}

async function main(): Promise<void> {
  const selector = Process.argv.slice(2).join(' ').trim();
  if (!selector) {
    throw new Error('Usage: yarn troubleshoot:account <operator name or account ID>');
  }

  const networkName = Process.env.ARGON_NETWORK_NAME?.trim() || 'mainnet';
  NetworkConfig.setNetwork(networkName as Parameters<typeof NetworkConfig.setNetwork>[0]);
  const runtimeOverride = Process.env.ARGON_NETWORK_CONFIG_OVERRIDE?.trim();
  if (runtimeOverride) {
    NetworkConfig.setRuntimeOverride(
      networkName as Parameters<typeof NetworkConfig.setNetwork>[0],
      JSON.parse(runtimeOverride) as INetworkConfigOverride,
    );
  }
  const archiveUrl = Process.env.ARGON_ARCHIVE_URL?.trim() || NetworkConfig.get().archiveUrl;
  const client = createArgonClient(await getClient(archiveUrl));

  let identity: ReadonlyAccountIdentity;
  try {
    const lookup: ReadonlyAccountLookup = isValidArgonAccountAddress(selector)
      ? { defaultAccountId: selector }
      : { operatorName: selector };
    identity = await resolveReadonlyAccount(client, lookup);
  } finally {
    await client.disconnect();
  }

  const configuredInstance = Process.env.ARGON_APP_INSTANCE?.trim();
  const instanceName = configuredInstance?.split(':')[0] || resolveReadonlyInstanceName(identity);
  const instancePort = configuredInstance?.split(':')[1] || String(await reserveEphemeralPort());
  const appInstance = `${instanceName}:${instancePort}`;
  const instanceDirectory = getReadonlyInstanceDirectory(networkName, instanceName);
  const walletPath = writeReadonlyWallet(instanceDirectory, identity);

  console.log(`Opening ${identity.operatorName || identity.defaultAccountId} in readonly mode.`);
  console.log(`Wallet: ${walletPath}`);

  const app = spawn('yarn', ['tauri:dev'], {
    cwd: Path.resolve(import.meta.dirname, '..'),
    env: { ...Process.env, ARGON_APP_INSTANCE: appInstance, ARGON_NETWORK_NAME: networkName },
    stdio: 'inherit',
  });
  await new Promise<void>((resolve, reject) => {
    app.once('error', reject);
    app.once('exit', code => {
      if (code === 0) resolve();
      else reject(new Error(`Argon exited with code ${code ?? 'unknown'}.`));
    });
  });
}

if (Process.argv[1] && Path.resolve(Process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(error => {
    console.error((error as Error).message);
    Process.exitCode = 1;
  });
}
