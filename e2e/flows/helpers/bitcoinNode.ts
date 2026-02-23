import assert from 'node:assert/strict';
import { generateBlocks, runBtcCli } from './btcCli.ts';
import { parseDecimalToUnits, pollEvery } from './utils.ts';

const SATOSHIS_PER_BTC = 100_000_000n;
const DEFAULT_RECEIPT_TIMEOUT_MS = 120_000;
const DEFAULT_RECEIPT_POLL_MS = 3_000;

interface IBitcoinWalletTransactionDetail {
  address?: unknown;
  amount?: unknown;
  category?: unknown;
}

interface IBitcoinWalletTransaction {
  confirmations?: unknown;
  details?: unknown;
}

interface IWaitForTransactionOutputSatoshisInput {
  flowName: string;
  txid: string;
  address: string;
  minimumSatoshis: bigint;
  minerAddress: string;
  timeoutMs?: number;
  pollMs?: number;
}

interface IWaitForAddressSatoshisInput {
  flowName: string;
  address: string;
  minimumSatoshis: bigint;
  minerAddress: string;
  minConfirmations?: number;
  timeoutMs?: number;
  pollMs?: number;
}

export function createBitcoinAddress(): string {
  return runBtcCli(['getnewaddress']);
}

export function mineBitcoinSingleBlock(minerAddress: string): void {
  generateBlocks(1, minerAddress);
}

export function sendBitcoinToAddress(address: string, amountSatoshis: bigint): string {
  if (amountSatoshis <= 0n) {
    throw new Error(`attempted to send invalid Bitcoin amount ${amountSatoshis.toString()}`);
  }

  const txid = runBtcCli(['sendtoaddress', address, satoshisToBtc(amountSatoshis)]).trim();
  if (!txid) {
    throw new Error(`failed to send Bitcoin to ${address}: missing txid`);
  }
  return txid;
}

export async function waitForBitcoinTransactionOutputSatoshis(
  input: IWaitForTransactionOutputSatoshisInput,
): Promise<bigint> {
  const {
    flowName,
    txid,
    address,
    minimumSatoshis,
    minerAddress,
    timeoutMs = DEFAULT_RECEIPT_TIMEOUT_MS,
    pollMs = DEFAULT_RECEIPT_POLL_MS,
  } = input;

  if (minimumSatoshis <= 0n) {
    throw new Error(`${flowName}: minimumSatoshis must be positive`);
  }

  let lastObserved = 0n;
  let lastConfirmations = 0;
  await pollEvery(
    pollMs,
    async () => {
      mineBitcoinSingleBlock(minerAddress);
      const transaction = readBitcoinWalletTransaction(flowName, txid);
      lastConfirmations = parseBitcoinConfirmations(transaction.confirmations);
      lastObserved = readAddressAmountFromTransaction(flowName, txid, address, transaction.details);
      return lastConfirmations >= 1 && lastObserved >= minimumSatoshis;
    },
    {
      timeoutMs,
      timeoutMessage: `${flowName}: tx ${txid} did not confirm ${minimumSatoshis.toString()}+ satoshis to ${address} within timeout`,
    },
  );

  assert.ok(
    lastObserved >= minimumSatoshis,
    `${flowName}: tx ${txid} sent ${lastObserved.toString()} satoshis to ${address}; expected ${minimumSatoshis.toString()}`,
  );
  return lastObserved;
}

export function getBitcoinReceivedByAddressSatoshis(flowName: string, address: string, minConfirmations = 1): bigint {
  const receivedRaw = runBtcCli(['getreceivedbyaddress', address, String(minConfirmations)]);
  return parseDecimalToUnits(receivedRaw, SATOSHIS_PER_BTC, `${flowName}.receivedSatoshis`);
}

export async function waitForBitcoinAddressSatoshis(input: IWaitForAddressSatoshisInput): Promise<bigint> {
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

  let lastObserved = 0n;
  await pollEvery(
    pollMs,
    async () => {
      mineBitcoinSingleBlock(minerAddress);
      const received = getBitcoinReceivedByAddressSatoshis(flowName, address, minConfirmations);
      lastObserved = received;
      return received >= minimumSatoshis;
    },
    {
      timeoutMs,
      timeoutMessage: `${flowName}: did not receive ${minimumSatoshis.toString()}+ satoshis at ${address} within timeout`,
    },
  );

  assert.ok(lastObserved >= minimumSatoshis, `${flowName}: missing expected bitcoin receipt at ${address}`);
  return lastObserved;
}

function readBitcoinWalletTransaction(flowName: string, txid: string): IBitcoinWalletTransaction {
  const raw = runBtcCli(['gettransaction', txid]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${flowName}: btc-cli gettransaction ${txid} returned invalid JSON`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${flowName}: btc-cli gettransaction ${txid} returned a non-object payload`);
  }

  return parsed as IBitcoinWalletTransaction;
}

function parseBitcoinConfirmations(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw;
  }
  if (typeof raw === 'string') {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return 0;
}

function readAddressAmountFromTransaction(
  flowName: string,
  txid: string,
  address: string,
  rawDetails: unknown,
): bigint {
  if (!Array.isArray(rawDetails)) {
    return 0n;
  }

  let sentSatoshis = 0n;
  for (const detail of rawDetails) {
    if (!detail || typeof detail !== 'object' || Array.isArray(detail)) {
      continue;
    }
    const txDetail = detail as IBitcoinWalletTransactionDetail;
    const detailAddress = typeof txDetail.address === 'string' ? txDetail.address.trim() : '';
    if (detailAddress !== address) {
      continue;
    }

    const category = typeof txDetail.category === 'string' ? txDetail.category : '';
    if (category !== 'send' && category !== 'receive') {
      continue;
    }

    const satoshis = parseSignedBitcoinAmountToSatoshis(txDetail.amount, `${flowName}.tx.${txid}.amount`);
    if (satoshis == null) {
      continue;
    }
    sentSatoshis += satoshis;
  }

  return sentSatoshis;
}

function parseSignedBitcoinAmountToSatoshis(amount: unknown, label: string): bigint | null {
  if (typeof amount === 'number') {
    if (!Number.isFinite(amount)) {
      return null;
    }
    const normalized = Math.abs(amount).toFixed(8);
    return parseDecimalToUnits(normalized, SATOSHIS_PER_BTC, label);
  }

  if (typeof amount === 'string') {
    const trimmed = amount.trim();
    if (!trimmed) {
      return null;
    }
    const unsigned = trimmed.startsWith('-') || trimmed.startsWith('+') ? trimmed.slice(1) : trimmed;
    if (!unsigned) {
      return null;
    }
    return parseDecimalToUnits(unsigned, SATOSHIS_PER_BTC, label);
  }

  return null;
}

function satoshisToBtc(amountSatoshis: bigint): string {
  if (amountSatoshis <= 0n) {
    throw new Error('Bitcoin amount must be positive');
  }
  const integerPart = amountSatoshis / SATOSHIS_PER_BTC;
  const fractionalPart = (amountSatoshis % SATOSHIS_PER_BTC).toString().padStart(8, '0');
  return `${integerPart}.${fractionalPart}`;
}
