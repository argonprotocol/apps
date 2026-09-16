import { describe, expect, it, vi } from 'vitest';
import BigNumber from 'bignumber.js';

import { BitcoinLock } from '../src/BitcoinLock.ts';
import type { BlockWatch, RuntimeSystemEventRecord } from '../src/BlockWatch.ts';
import type { ArgonQueryClient } from '../src/MainchainClients.ts';

describe('BitcoinLock current runtime state', () => {
  it('keeps the pending basis and applies Mainchain fixed-point rounding after funding', async () => {
    const runtimeLock = {
      vaultId: 3,
      securitizationBasis: {
        satoshis: 1_000_001n,
        microgonsAtTargetPerBtc: 2_000_000n,
      },
      securitizationCoverageMicrogons: 1_000_001n,
      securitizationTick: 100,
      fundedSatoshis: 0n,
      fundingUtxos: [],
      fissionedSatoshis: 0n,
      ownerAccount: 'owner-account',
      securitizationRatio: new BigNumber(1),
      securityFees: 50n,
      couponPaidFees: 5n,
      vaultPubkey: `0x02${'11'.repeat(32)}`,
      vaultClaimPubkey: `0x02${'22'.repeat(32)}`,
      ownerPubkey: `0x03${'33'.repeat(32)}`,
      vaultXpubSources: ['0x01020304', 1, 2],
      vaultClaimHeight: 200,
      openClaimHeight: 210,
      createdAtHeight: 90,
      securitizationHoldExpirationBitcoinHeight: 150,
      utxoScriptPubkey: { type: 'P2WSH', value: { wscriptHash: `0x${'44'.repeat(32)}` } },
      isFlexible: false,
      fundHoldExtensions: {},
      createdAtArgonBlock: 80,
    };
    const locksById = vi.fn(async () => runtimeLock);
    const client = { query: { bitcoinLocks: { locksById } } } as unknown as ArgonQueryClient;

    await expect(BitcoinLock.get(client, 7)).resolves.toMatchObject({
      securitizedSatoshis: 1_000_001n,
      securitizationCoverageMicrogons: 1_000_001n,
    });

    runtimeLock.fundedSatoshis = 500_000n;
    runtimeLock.fundingUtxos = [[{ txid: '00'.repeat(32), outputIndex: 1 }, 500_000n]] as never;
    await expect(BitcoinLock.get(client, 7)).resolves.toMatchObject({
      securitizedSatoshis: 500_000n,
      securitizationCoverageMicrogons: 499_999n,
    });
  });

  it('walks the finalized cosign chain to find an earlier release', async () => {
    const releaseHeightsByBlock = {
      140: { cosignHeight: 130, previousCosignHeight: 120, releaseNumber: 3 },
      120: { cosignHeight: 120, previousCosignHeight: 110, releaseNumber: 2 },
      110: { cosignHeight: 110, previousCosignHeight: null, releaseNumber: 1 },
    } as const;
    const signatures = [new Uint8Array([1]), new Uint8Array([2])];
    const releaseOneEvent = {
      phase: { type: 'ApplyExtrinsic', value: 1 },
      topics: [],
      event: {
        section: 'bitcoinLocks',
        method: 'BitcoinUtxoCosigned',
        data: { lockId: 7, vaultId: 3, releaseNumber: 1, signatures },
      },
    } as unknown as RuntimeSystemEventRecord;
    const blockWatch = {
      getFinalizedApi: async () => ({
        query: {
          bitcoinLocks: { lockReleaseCosignHeightById: async () => releaseHeightsByBlock[140] },
        },
      }),
      getHeaderByBlockNumber: async (blockNumber: number) => ({ blockNumber, blockHash: `0x${blockNumber}` }),
      getApi: async ({ blockNumber }: { blockNumber: number }) => ({
        query: {
          bitcoinLocks: {
            lockReleaseCosignHeightById: async () =>
              releaseHeightsByBlock[blockNumber as keyof typeof releaseHeightsByBlock],
          },
        },
      }),
      getEvents: async ({ blockNumber }: { blockNumber: number }) => (blockNumber === 110 ? [releaseOneEvent] : []),
    } as unknown as BlockWatch;

    await expect(BitcoinLock.findVaultCosignatures(blockWatch, 7, 1)).resolves.toEqual({
      blockHeight: 110,
      signatures,
    });
  });
});
