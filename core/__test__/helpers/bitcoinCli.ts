import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { waitFor } from './waitFor.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARGON_DOCKER_DIR = path.resolve(__dirname, '../../../e2e/argon');
const SATOSHIS_PER_BTC = 100_000_000n;
const DEFAULT_RECEIPT_TIMEOUT_MS = 120_000;
const DEFAULT_RECEIPT_POLL_MS = 3_000;

export interface IWaitForBitcoinTransactionOutputInput {
  flowName: string;
  txid: string;
  address: string;
  minimumSatoshis: bigint;
  minerAddress?: string;
  minConfirmations?: number;
  timeoutMs?: number;
  pollMs?: number;
}

export interface IWaitForBitcoinAddressSatoshisInput {
  flowName: string;
  address: string;
  minimumSatoshis: bigint;
  minerAddress?: string;
  minConfirmations?: number;
  timeoutMs?: number;
  pollMs?: number;
}

export interface IWaitForBitcoinTransactionConfirmationsInput {
  flowName: string;
  txid: string;
  minimumConfirmations: number;
  minerAddress?: string;
  mineMode?: 'single' | 'missing';
  timeoutMs?: number;
  pollMs?: number;
}

function readNonEmptyEnv(name: string): string | undefined {
  return process.env[name]?.trim();
}

function getComposeProjectName(): string {
  const explicitProjectName = readNonEmptyEnv('COMPOSE_PROJECT_NAME');
  if (explicitProjectName) {
    return explicitProjectName;
  }

  const networkName = readNonEmptyEnv('ARGON_NETWORK_NAME') ?? 'dev-docker';
  const rawInstance = readNonEmptyEnv('ARGON_APP_INSTANCE') ?? 'e2e';
  const instanceName = rawInstance.split(':')[0] || 'e2e';
  return `${networkName}-${instanceName}`.toLowerCase().replace(/[^a-z0-9]/g, '-');
}

export function runBtcCli(args: string[]): string {
  const composeProjectName = getComposeProjectName();
  const result = spawnSync('docker', ['compose', '--profile', 'tooling', 'run', '--rm', 'btc-cli', ...args], {
    cwd: ARGON_DOCKER_DIR,
    env: {
      ...process.env,
      COMPOSE_PROJECT_NAME: composeProjectName,
    },
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.trim() || 'unknown error';
    throw new Error(`btc-cli failed (${args.join(' ')}): ${stderr}`);
  }

  return result.stdout.trim();
}

export function generateBlocks(count: number, minerAddress?: string): string[] {
  const address = minerAddress?.trim() || createBitcoinAddress();
  const raw = runBtcCli(['generatetoaddress', String(count), address]);

  try {
    const parsed = JSON.parse(raw) as string[];
    if (Array.isArray(parsed)) {
      return parsed;
    }
  } catch (_error) {
    // no-op; fall back to a line-based parse below
  }

  return raw
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
}

export function mineBitcoinSingleBlock(minerAddress: string): void {
  generateBlocks(1, minerAddress);
}

export function createBitcoinAddress(): string {
  return runBtcCli(['getnewaddress']);
}

export function sendBitcoinToAddress(address: string, amountSatoshis: bigint): string {
  if (amountSatoshis <= 0n) {
    throw new Error(`attempted to send invalid Bitcoin amount ${amountSatoshis.toString()}`);
  }

  const txid = runBtcCli([
    'sendtoaddress',
    address,
    formatUnitsToDecimal(amountSatoshis, SATOSHIS_PER_BTC, 'bitcoin'),
  ]).trim();
  if (!txid) {
    throw new Error(`failed to send Bitcoin to ${address}: missing txid`);
  }
  return txid;
}

export async function waitForBitcoinTransactionOutputSatoshis(
  input: IWaitForBitcoinTransactionOutputInput,
): Promise<bigint> {
  const {
    flowName,
    txid,
    address,
    minimumSatoshis,
    minerAddress,
    minConfirmations = 1,
    timeoutMs = DEFAULT_RECEIPT_TIMEOUT_MS,
    pollMs = DEFAULT_RECEIPT_POLL_MS,
  } = input;

  if (minimumSatoshis <= 0n) {
    throw new Error(`${flowName}: minimumSatoshis must be positive`);
  }

  const output = await waitFor(
    timeoutMs,
    `${flowName}: bitcoin output confirmation`,
    () => {
      const current = readBitcoinTransactionOutput(txid, address);
      if (
        minerAddress &&
        (!current || current.confirmations < minConfirmations || current.satoshis < minimumSatoshis)
      ) {
        mineBitcoinSingleBlock(minerAddress);
      }
      if (!current) return undefined;
      if (current.confirmations < minConfirmations) return undefined;
      if (current.satoshis < minimumSatoshis) return undefined;
      return current;
    },
    {
      pollMs,
      timeoutMessage: `${flowName}: tx ${txid} did not confirm ${minimumSatoshis.toString()}+ satoshis to ${address} within timeout`,
    },
  );

  return output.satoshis;
}

export function getBitcoinReceivedByAddressSatoshis(flowName: string, address: string, minConfirmations = 1): bigint {
  const receivedRaw = runBtcCli(['getreceivedbyaddress', address, String(minConfirmations)]);
  return parseDecimalToUnits(receivedRaw, SATOSHIS_PER_BTC, `${flowName}.receivedSatoshis`);
}

export async function waitForBitcoinAddressSatoshis(input: IWaitForBitcoinAddressSatoshisInput): Promise<bigint> {
  const {
    flowName,
    address,
    minimumSatoshis,
    minerAddress,
    minConfirmations = 1,
    timeoutMs = DEFAULT_RECEIPT_TIMEOUT_MS,
    pollMs = DEFAULT_RECEIPT_POLL_MS,
  } = input;

  if (minimumSatoshis <= 0n) {
    throw new Error(`${flowName}: minimumSatoshis must be positive`);
  }

  return await waitFor(
    timeoutMs,
    `${flowName}: bitcoin receipt`,
    () => {
      const received = getBitcoinReceivedByAddressSatoshis(flowName, address, minConfirmations);
      if (minerAddress && received < minimumSatoshis) {
        mineBitcoinSingleBlock(minerAddress);
      }
      if (received < minimumSatoshis) return undefined;
      return received;
    },
    {
      pollMs,
      timeoutMessage: `${flowName}: did not receive ${minimumSatoshis.toString()}+ satoshis at ${address} within timeout`,
    },
  );
}

export async function waitForBitcoinTransactionConfirmations(
  input: IWaitForBitcoinTransactionConfirmationsInput,
): Promise<number> {
  const {
    flowName,
    txid,
    minimumConfirmations,
    minerAddress,
    mineMode = 'single',
    timeoutMs = DEFAULT_RECEIPT_TIMEOUT_MS,
    pollMs = DEFAULT_RECEIPT_POLL_MS,
  } = input;

  if (minimumConfirmations <= 0) {
    throw new Error(`${flowName}: minimumConfirmations must be positive`);
  }

  return await waitFor(
    timeoutMs,
    `${flowName}: bitcoin confirmations`,
    () => {
      const confirmations = readBitcoinTransactionConfirmations(txid);
      if (confirmations != null && confirmations >= minimumConfirmations) {
        return confirmations;
      }

      if (minerAddress) {
        const blocksToMine =
          mineMode === 'missing' && confirmations != null ? Math.max(1, minimumConfirmations - confirmations) : 1;
        generateBlocks(blocksToMine, minerAddress);
      }

      return undefined;
    },
    {
      pollMs,
      timeoutMessage: `${flowName}: tx ${txid} did not reach ${minimumConfirmations} confirmations within timeout`,
    },
  );
}

export function readBitcoinTransactionOutput(
  txid: string,
  address: string,
): { vout: number; satoshis: bigint; confirmations: number } | undefined {
  const raw = readRawBitcoinTransaction(txid);
  const tx = JSON.parse(raw) as {
    confirmations?: number;
    vout?: Array<{
      n?: number;
      value?: string | number;
      scriptPubKey?: {
        address?: string;
        addresses?: string[];
      };
    }>;
  };

  for (const output of tx.vout ?? []) {
    const outputAddresses = [output.scriptPubKey?.address, ...(output.scriptPubKey?.addresses ?? [])].filter(
      Boolean,
    ) as string[];
    if (!outputAddresses.includes(address)) continue;
    if (output.n == null || output.value == null) continue;
    return {
      vout: output.n,
      satoshis: parseBitcoinAmount(output.value),
      confirmations: tx.confirmations ?? 0,
    };
  }
}

export function readBitcoinTransactionConfirmations(txid: string): number | undefined {
  const raw = readRawBitcoinTransaction(txid);
  const tx = JSON.parse(raw) as { confirmations?: number };
  return tx.confirmations;
}

export function readRawBitcoinTransaction(txid: string): string {
  let lastError: unknown;
  for (const candidate of getBitcoinTxidCandidates(txid)) {
    try {
      return runBtcCli(['getrawtransaction', candidate, 'true']);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Unable to read bitcoin transaction ${txid}`);
}

function getBitcoinTxidCandidates(txid: string): string[] {
  const normalized = txid.startsWith('0x') ? txid.slice(2).toLowerCase() : txid.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    return [txid];
  }
  const reversed = normalized.match(/../g)?.reverse().join('') ?? normalized;
  if (reversed === normalized) {
    return [normalized];
  }
  if (txid.startsWith('0x')) {
    return [reversed, normalized];
  }
  return [normalized, reversed];
}

function parseBitcoinAmount(value: string | number): bigint {
  return parseDecimalToUnits(String(value).trim(), SATOSHIS_PER_BTC, 'bitcoin.tx.amount');
}

function getScaleDecimals(unitScale: bigint, label: string): number {
  const raw = unitScale.toString();
  if (raw === '0') {
    throw new Error(`${label}: unit scale must be > 0`);
  }
  if (!/^10*$/.test(raw)) {
    throw new Error(`${label}: unit scale must be a power of ten`);
  }
  return raw.length - 1;
}

function parseDecimalToUnits(value: string | number, unitScale: bigint, label: string): bigint {
  const rawInput = typeof value === 'number' ? String(value) : value;
  const normalized = rawInput.replace(/,/g, '').trim();
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) {
    throw new Error(`${label}: expected a positive decimal`);
  }

  const [wholePart, fractionalPart = ''] = normalized.split('.');
  const decimals = getScaleDecimals(unitScale, label);
  if (fractionalPart.length > decimals) {
    throw new Error(`${label}: supports at most ${decimals} decimal place${decimals === 1 ? '' : 's'}`);
  }

  const paddedFraction = fractionalPart.padEnd(decimals, '0');
  const whole = BigInt(wholePart || '0') * unitScale;
  const fraction = decimals === 0 ? 0n : BigInt(paddedFraction || '0');
  return whole + fraction;
}

function formatUnitsToDecimal(units: bigint, unitScale: bigint, label: string): string {
  if (units < 0n) {
    throw new Error(`${label}: expected a non-negative integer`);
  }
  const decimals = getScaleDecimals(unitScale, label);
  if (decimals === 0) {
    return units.toString();
  }
  const wholePart = units / unitScale;
  const fractionalPart = (units % unitScale).toString().padStart(decimals, '0');
  return `${wholePart}.${fractionalPart}`;
}
