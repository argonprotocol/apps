#!/usr/bin/env tsx

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { NetworkConfigSettings, isValidArgonAccountAddress } from '@argonprotocol/apps-core';
import { getClient } from '@argonprotocol/mainchain';
import { parseUnits } from 'viem';
import { sudoFundWallet } from '../flows/helpers/sudoFundWallet.ts';

type SupportedToken = 'ARGN' | 'ARGNOT';

type FundArgonAccountArgs = {
  to: string;
  archiveUrl?: string;
  microgons?: bigint;
  micronots?: bigint;
};

type FundArgonAccountResult = {
  archiveUrl: string;
  address: string;
  requestedMicrogons: bigint;
  requestedMicronots: bigint;
  fundedMicrogons: bigint;
  fundedMicronots: bigint;
};

const currentFilePath = fileURLToPath(import.meta.url);
const isDirectExecution = !!process.argv[1] && path.resolve(process.argv[1]) === currentFilePath;

if (isDirectExecution) {
  void main().catch(error => {
    console.error(`[fund-argon-account] ${(error as Error).message}`);
    process.exit(1);
  });
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      token: { type: 'string' },
      to: { type: 'string' },
      archive: { type: 'string' },
      amount: { type: 'string' },
      argons: { type: 'string' },
      argonots: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: false,
  });

  if (values.help) {
    printUsage();
    return;
  }

  const token = values.token ? parseTokenArg(values.token) : undefined;
  const genericRuntimeAmount = parseRuntimeAmountArg(values.amount);
  if (token && (values.argons || values.argonots)) {
    throw new Error('Use either --token with --amount, or the explicit --argons / --argonots flags. Do not mix both.');
  }
  if (!token && values.amount) {
    throw new Error('Provide --token when using --amount.');
  }

  const result = await fundArgonAccount({
    to: parseAccountArg(values.to),
    archiveUrl: values.archive,
    microgons: token === 'ARGN' ? genericRuntimeAmount : parseRuntimeAmountArg(values.argons),
    micronots: token === 'ARGNOT' ? genericRuntimeAmount : parseRuntimeAmountArg(values.argonots),
  });

  console.info(`[fund-argon-account] Archive: ${result.archiveUrl}`);
  console.info(`[fund-argon-account] Recipient: ${result.address}`);
  console.info(`[fund-argon-account] Requested ARGN (microgons): ${result.requestedMicrogons}`);
  console.info(`[fund-argon-account] Requested ARGNOT (micronots): ${result.requestedMicronots}`);
  console.info(`[fund-argon-account] Funded ARGN (microgons): ${result.fundedMicrogons}`);
  console.info(`[fund-argon-account] Funded ARGNOT (micronots): ${result.fundedMicronots}`);
}

export async function fundArgonAccount(args: FundArgonAccountArgs): Promise<FundArgonAccountResult> {
  const address = parseAccountArg(args.to);
  const microgons = resolveRuntimeAmount(args.microgons, 'ARGN');
  const micronots = resolveRuntimeAmount(args.micronots, 'ARGNOT');
  if (microgons === 0n && micronots === 0n) {
    throw new Error('Provide an ARGN or ARGNOT amount to fund on Argon.');
  }

  const archiveUrl = resolveArchiveUrl(args.archiveUrl);

  const client = await getClient(archiveUrl);
  let existingMicrogons = 0n;
  let existingMicronots = 0n;
  try {
    const [microgonBalance, micronotBalance] = await Promise.all([
      client.query.system.account(address),
      client.query.ownership.account(address),
    ]);
    existingMicrogons = microgonBalance.data.free.toBigInt();
    existingMicronots = micronotBalance.free.toBigInt();
  } finally {
    await client.disconnect();
  }

  const result = await sudoFundWallet({
    address,
    archiveUrl,
    microgons: existingMicrogons + microgons,
    micronots: existingMicronots + micronots,
  });

  return {
    archiveUrl,
    address: result.address,
    requestedMicrogons: result.requestedMicrogons,
    requestedMicronots: result.requestedMicronots,
    fundedMicrogons: result.fundedMicrogons,
    fundedMicronots: result.fundedMicronots,
  };
}

function parseTokenArg(value: string | undefined): SupportedToken {
  const normalized = value?.trim().toUpperCase();
  if (normalized === 'ARGN' || normalized === 'ARGNOT') {
    return normalized;
  }

  throw new Error('Provide --token ARGN or --token ARGNOT');
}

function parseAccountArg(value: string | undefined): string {
  if (!value?.trim()) {
    throw new Error('Missing required --to address');
  }
  if (!isValidArgonAccountAddress(value)) {
    throw new Error(`Invalid Argon address: ${value}`);
  }

  return value;
}

function parseRuntimeAmountArg(amount: string | undefined): bigint | undefined {
  if (!amount) {
    return;
  }

  return parseUnits(amount, 6);
}

function resolveRuntimeAmount(runtimeAmount: bigint | undefined, label: string): bigint {
  if (runtimeAmount !== undefined) {
    if (runtimeAmount < 0n) {
      throw new Error(`${label} runtime amount must be non-negative: ${runtimeAmount}`);
    }
    return runtimeAmount;
  }

  return 0n;
}

function resolveArchiveUrl(archiveUrl?: string): string {
  if (archiveUrl?.trim()) {
    return archiveUrl.trim();
  }

  const runtimeOverride = readRuntimeArchiveUrl();
  if (runtimeOverride) {
    return runtimeOverride;
  }

  const configuredArchiveUrl = process.env.ARGON_ARCHIVE_URL?.trim();
  if (configuredArchiveUrl) {
    return configuredArchiveUrl;
  }

  const networkName = process.env.ARGON_NETWORK_NAME ?? 'dev-docker';
  const config = NetworkConfigSettings[networkName as keyof typeof NetworkConfigSettings];
  if (config?.archiveUrl) {
    return config.archiveUrl;
  }

  throw new Error(
    `fund-argon-account: unable to resolve archive URL for network "${networkName}". Set ARGON_ARCHIVE_URL, ARGON_NETWORK_CONFIG_OVERRIDE, or provide --archive.`,
  );
}

function readRuntimeArchiveUrl(): string | null {
  const raw = process.env.ARGON_NETWORK_CONFIG_OVERRIDE?.trim();
  if (!raw) return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const candidate = (parsed as { archiveUrl?: unknown }).archiveUrl;
    return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : null;
  } catch {
    return null;
  }
}

function printUsage(): void {
  console.info(`Usage:
  yarn dev:argon:add-argn --to 5Recipient --amount 100
  yarn dev:argon:add-argnot --to 5Recipient --amount 25.5

Direct:
  yarn exec tsx e2e/scripts/fundArgonAccount.ts --to 5Recipient --argons 100 --argonots 25.5

Notes:
  - Uses sudo to add ARGN and ARGNOT balances on the local Argon dev chain.
  - Uses ARGON_ARCHIVE_URL if set, otherwise resolves from ARGON_NETWORK_CONFIG_OVERRIDE or ARGON_NETWORK_NAME.
  - --amount is a 6-decimal Argon runtime amount for the token selected by the package script.
  - --argons and --argonots are 6-decimal Argon runtime amounts.
  - Example: --argons 1 seeds 1_000_000 microgons.
`);
}
