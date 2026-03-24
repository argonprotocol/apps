import { describe, expect, it, vi } from 'vitest';
import type { ArgonClient } from '@argonprotocol/mainchain';
import BitcoinLocks from '../lib/BitcoinLocks.ts';
import { BitcoinLockStatus, type IBitcoinLockRecord } from '../lib/db/BitcoinLocksTable.ts';
import { BitcoinUtxoStatus, type IBitcoinUtxoRecord } from '../lib/db/BitcoinUtxosTable.ts';
import { TransactionStatus } from '../lib/db/TransactionsTable.ts';

type IBitcoinLocksTestTarget = {
  syncLockReleaseArgonCosign(lock: IBitcoinLockRecord, archiveClient: ArgonClient): Promise<void>;
};

describe('BitcoinLocks Argon cosign gating', () => {
  it('stores the cosign only after a later sync sees it in finalized Argon state', async () => {
    const lock = createLock();
    const fundingRecord = createFundingRecord();
    const releaseCosignOnChain = {
      blockHeight: 77,
      signature: new Uint8Array([7, 8, 9]),
    };
    const setReleaseCosign = vi.fn<(...args: any[]) => Promise<void>>().mockResolvedValue(undefined);
    const ensureLockReleaseProcessing = vi.fn<(...args: any[]) => Promise<void>>().mockResolvedValue(undefined);
    const getReleaseCosignOnChain = vi
      .fn<(...args: any[]) => Promise<typeof releaseCosignOnChain | undefined>>()
      .mockResolvedValueOnce(undefined)
      .mockImplementation(async () => releaseCosignOnChain);
    const cosignMyLock = vi.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({
      txInfo: {
        tx: {
          status: TransactionStatus.Submitted,
        },
        txResult: {
          blockNumber: undefined,
          submissionError: undefined,
          extrinsicError: undefined,
        },
      },
      vaultSignature: new Uint8Array([1, 2, 3]),
    });

    const store = Object.assign(Object.create(BitcoinLocks.prototype), {
      utxoTracking: {
        setReleaseCosign,
      },
      getAcceptedFundingRecord: vi.fn().mockReturnValue(fundingRecord),
      getReleaseCosignOnChain,
      ensureLockReleaseProcessing,
      myVault: {
        vaultId: 1,
        cosignMyLock,
      },
    }) as BitcoinLocks;
    const testStore = store as unknown as IBitcoinLocksTestTarget;

    await testStore.syncLockReleaseArgonCosign(lock, {} as ArgonClient);
    expect(getReleaseCosignOnChain).toHaveBeenCalledTimes(1);
    expect(cosignMyLock).toHaveBeenCalledTimes(1);
    expect(setReleaseCosign).not.toHaveBeenCalled();

    await testStore.syncLockReleaseArgonCosign(lock, {} as ArgonClient);
    expect(getReleaseCosignOnChain).toHaveBeenCalledTimes(2);
    expect(cosignMyLock).toHaveBeenCalledTimes(1);
    expect(setReleaseCosign).toHaveBeenCalledWith(fundingRecord, {
      releaseCosignVaultSignature: releaseCosignOnChain.signature,
      releaseCosignHeight: releaseCosignOnChain.blockHeight,
    });
    expect(ensureLockReleaseProcessing).toHaveBeenCalledTimes(1);
  });

  it('stores the cosign from the local tx as soon as it reaches its first block', async () => {
    const lock = createLock();
    const fundingRecord = createFundingRecord();
    const vaultSignature = new Uint8Array([1, 2, 3]);
    const setReleaseCosign = vi.fn<(...args: any[]) => Promise<void>>().mockResolvedValue(undefined);
    const ensureLockReleaseProcessing = vi.fn<(...args: any[]) => Promise<void>>().mockResolvedValue(undefined);
    const getReleaseCosignOnChain = vi.fn<(...args: any[]) => Promise<undefined>>().mockResolvedValue(undefined);
    const cosignMyLock = vi.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({
      txInfo: {
        tx: {
          status: TransactionStatus.InBlock,
        },
        txResult: {
          blockNumber: 77,
          submissionError: undefined,
          extrinsicError: undefined,
        },
      },
      vaultSignature,
    });

    const store = Object.assign(Object.create(BitcoinLocks.prototype), {
      utxoTracking: {
        setReleaseCosign,
      },
      getAcceptedFundingRecord: vi.fn().mockReturnValue(fundingRecord),
      getReleaseCosignOnChain,
      ensureLockReleaseProcessing,
      myVault: {
        vaultId: 1,
        cosignMyLock,
      },
    }) as BitcoinLocks;
    const testStore = store as unknown as IBitcoinLocksTestTarget;

    await testStore.syncLockReleaseArgonCosign(lock, {} as ArgonClient);

    expect(getReleaseCosignOnChain).toHaveBeenCalledTimes(1);
    expect(cosignMyLock).toHaveBeenCalledTimes(1);
    expect(setReleaseCosign).toHaveBeenCalledWith(fundingRecord, {
      releaseCosignVaultSignature: vaultSignature,
      releaseCosignHeight: 77,
    });
    expect(ensureLockReleaseProcessing).toHaveBeenCalledTimes(1);
  });
});

function createLock(): IBitcoinLockRecord {
  return {
    uuid: 'lock-1',
    utxoId: 11,
    status: BitcoinLockStatus.Releasing,
    satoshis: 10_000n,
    liquidityPromised: 0n,
    lockedMarketRate: 0n,
    ratchets: [],
    cosignVersion: 'v1',
    lockDetails: {
      p2wshScriptHashHex: `0020${'00'.repeat(32)}`,
      ownerAccount: '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY',
      createdAtHeight: 100,
      vaultClaimHeight: 200,
    } as IBitcoinLockRecord['lockDetails'],
    fundingUtxoRecordId: 1,
    fundingUtxoRecord: undefined,
    network: 'testnet',
    hdPath: "m/84'/0'/0'",
    vaultId: 1,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  };
}

function createFundingRecord(): IBitcoinUtxoRecord {
  return {
    id: 1,
    lockUtxoId: 11,
    txid: 'a'.repeat(64),
    vout: 0,
    satoshis: 10_000n,
    network: 'testnet',
    status: BitcoinUtxoStatus.ReleaseIsProcessingOnArgon,
    firstSeenAt: new Date('2026-01-01T00:00:00Z'),
    firstSeenBitcoinHeight: 0,
    releaseToDestinationAddress: '0014abcd',
    releaseBitcoinNetworkFee: 10n,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  };
}
