import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ArgonClient } from '@argonprotocol/apps-core';
import {
  EvmContracts,
  getEthereumBeaconSyncBootstrapTx,
  getEthereumBeaconSyncState,
  type KeyringPair,
} from '@argonprotocol/mainchain';
import { getAddress, type Hex, type PublicClient } from 'viem';
import {
  ensureDevEthereumBeaconBootstrapped,
  initializeDevEthereumTokenReserve,
  submitDevAdminTransaction,
  syncEthereumGatewayActiveCouncilToArgon,
} from '../devEthereumRuntimeSetup.ts';
import { waitForFinalizedBeaconExecutionAtOrAbove } from '../../bot/src/EthereumBeaconSyncService.ts';

vi.mock('@argonprotocol/mainchain', async importOriginal => ({
  ...(await importOriginal<typeof import('@argonprotocol/mainchain')>()),
  getEthereumBeaconSyncBootstrapTx: vi.fn(),
  getEthereumBeaconSyncState: vi.fn(),
}));

vi.mock('../../bot/src/EthereumBeaconSyncService.ts', async importOriginal => ({
  ...(await importOriginal<typeof import('../../bot/src/EthereumBeaconSyncService.ts')>()),
  waitForFinalizedBeaconExecutionAtOrAbove: vi.fn(),
}));

describe('ensureDevEthereumBeaconBootstrapped', () => {
  beforeEach(() => {
    vi.mocked(getEthereumBeaconSyncState).mockReset();
    vi.mocked(getEthereumBeaconSyncBootstrapTx).mockReset();
    vi.mocked(waitForFinalizedBeaconExecutionAtOrAbove).mockReset();
  });

  it('reports progress while the light-client bootstrap endpoint is not ready', async () => {
    vi.mocked(getEthereumBeaconSyncState).mockResolvedValue({ isBootstrapped: false } as never);
    vi.mocked(waitForFinalizedBeaconExecutionAtOrAbove).mockResolvedValue();
    vi.mocked(getEthereumBeaconSyncBootstrapTx).mockRejectedValue(
      new Error('GET /eth/v1/beacon/light_client/bootstrap/0x123 returned 404'),
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(
      ensureDevEthereumBeaconBootstrapped({} as ArgonClient, 'http://127.0.0.1:33001', {} as KeyringPair, {
        timeoutMs: 20,
        pollMs: 1,
      }),
    ).rejects.toThrow('light-client bootstrap endpoint did not become ready');

    expect(log).toHaveBeenCalledWith(expect.stringContaining('Waiting for beacon light-client bootstrap data'));
    log.mockRestore();
  });
});

describe('initializeDevEthereumTokenReserve', () => {
  it('does not remigrate after the root account distributes part of the initialized reserve', async () => {
    const argonTokenAddress = getAddress(`0x${'11'.repeat(20)}`);
    const argonotTokenAddress = getAddress(`0x${'22'.repeat(20)}`);
    const readContract = vi.fn(async ({ address, functionName }: { address: string; functionName: string }) => {
      if (functionName === 'migrationCompleted') return true;
      if (address === argonTokenAddress) return 7_000n * 10n ** 18n;
      return 10_000n * 10n ** 18n;
    });
    const ensureBacking = vi.fn();
    const sendMigration = vi.fn(async (): Promise<Hex> => `0x${'ab'.repeat(32)}`);

    await expect(
      initializeDevEthereumTokenReserve({
        publicClient: {
          readContract,
          waitForTransactionReceipt: vi.fn(),
        } as Pick<PublicClient, 'readContract' | 'waitForTransactionReceipt'>,
        gatewayAddress: getAddress(`0x${'33'.repeat(20)}`),
        argonTokenAddress,
        argonotTokenAddress,
        rootAccountAddress: getAddress(`0x${'44'.repeat(20)}`),
        ensureBacking,
        sendMigration,
      }),
    ).resolves.toBeUndefined();
    expect(ensureBacking).not.toHaveBeenCalled();
    expect(sendMigration).not.toHaveBeenCalled();
  });
});

describe('submitDevAdminTransaction', () => {
  it('accepts a relocated transaction once its intended state is applied', async () => {
    let applied = false;
    const submit = vi.fn(async () => {
      applied = true;
      throw new Error('Cannot publish transaction block state before extrinsic index is known');
    });

    await submitDevAdminTransaction({
      isApplied: async () => applied,
      submit,
    });

    expect(submit).toHaveBeenCalledOnce();
  });

  it('resubmits once when a relocated transaction was not applied', async () => {
    let applied = false;
    const submit = vi.fn(async () => {
      if (submit.mock.calls.length === 1) {
        throw new Error('Cannot publish transaction block state before extrinsic index is known');
      }
      applied = true;
    });

    await submitDevAdminTransaction({
      isApplied: async () => applied,
      submit,
    });

    expect(submit).toHaveBeenCalledTimes(2);
  });
});

describe('syncEthereumGatewayActiveCouncilToArgon', () => {
  it('resyncs when the gateway only matches an older microgons-per-argonot floor', async () => {
    const signerA = `0x${'11'.repeat(20)}`;
    const signerB = `0x${'22'.repeat(20)}`;
    const oldMicrogonsPerArgonot = 3n;
    const nextMicrogonsPerArgonot = 5n;
    const currentCouncil = {
      signers: [getAddress(signerA), getAddress(signerB)],
      weights: [7n, 4n],
      version: 0,
    };
    const staleGatewayHash = EvmContracts.hashMintingGatewayGlobalIssuanceCouncil({
      ...currentCouncil,
      epochMicrogonsPerArgonot: oldMicrogonsPerArgonot,
    });
    const staleGatewayCouncil = [11n, 2n, staleGatewayHash, oldMicrogonsPerArgonot] as const;
    const sendCurrentCouncil = vi.fn(async (): Promise<Hex> => `0x${'ab'.repeat(32)}`);
    const waitForTransactionReceipt = vi.fn(
      async () => ({ status: 'success' }) as Awaited<ReturnType<PublicClient['waitForTransactionReceipt']>>,
    );
    const publicClient = {
      readContract: vi.fn(async () => staleGatewayCouncil),
      waitForTransactionReceipt,
    } as Pick<PublicClient, 'readContract' | 'waitForTransactionReceipt'>;

    const result = await syncEthereumGatewayActiveCouncilToArgon({
      finalizedClient: {
        query: {
          crosschainTransfer: {
            activeGlobalIssuanceCouncilByDestinationChain: vi.fn(async () => `0x${'99'.repeat(32)}`),
            globalIssuanceCouncilByHash: vi.fn(async () => ({
              epochMicrogonsPerArgonot: nextMicrogonsPerArgonot,
              members: {
                [signerB]: { weight: 4n },
                [signerA]: { weight: 7n },
              },
            })),
          },
        },
      } as any,
      gatewayAddress: getAddress(`0x${'33'.repeat(20)}`),
      publicClient,
      sendCurrentCouncil,
    });

    expect(result).toEqual({
      status: 'synced',
      hash: `0x${'ab'.repeat(32)}`,
    });
    expect(sendCurrentCouncil).toHaveBeenCalledWith({
      ...currentCouncil,
      epochMicrogonsPerArgonot: nextMicrogonsPerArgonot,
      inflationPercentSinceLaunch: 0n,
    });
    expect(waitForTransactionReceipt).toHaveBeenCalledWith({ hash: `0x${'ab'.repeat(32)}` });
  });

  it('stays already-matching when the gateway hash includes the current floor', async () => {
    const signer = `0x${'44'.repeat(20)}`;
    const currentCouncil = {
      signers: [getAddress(signer)],
      weights: [1n],
      version: 0,
    };
    const microgonsPerArgonot = 8n;
    const currentHash = EvmContracts.hashMintingGatewayGlobalIssuanceCouncil({
      ...currentCouncil,
      epochMicrogonsPerArgonot: microgonsPerArgonot,
    });
    const currentGatewayCouncil = [1n, 1n, currentHash, microgonsPerArgonot] as const;
    const sendCurrentCouncil = vi.fn(async (): Promise<Hex> => `0x${'ab'.repeat(32)}`);
    const publicClient = {
      readContract: vi.fn(async () => currentGatewayCouncil),
      waitForTransactionReceipt: vi.fn(),
    } as Pick<PublicClient, 'readContract' | 'waitForTransactionReceipt'>;

    const result = await syncEthereumGatewayActiveCouncilToArgon({
      finalizedClient: {
        query: {
          crosschainTransfer: {
            activeGlobalIssuanceCouncilByDestinationChain: vi.fn(async () => `0x${'77'.repeat(32)}`),
            globalIssuanceCouncilByHash: vi.fn(async () => ({
              epochMicrogonsPerArgonot: microgonsPerArgonot,
              members: { [signer]: { weight: 1n } },
            })),
          },
        },
      } as any,
      gatewayAddress: getAddress(`0x${'55'.repeat(20)}`),
      publicClient,
      sendCurrentCouncil,
    });

    expect(result).toEqual({ status: 'already-matching' });
    expect(sendCurrentCouncil).not.toHaveBeenCalled();
  });
});
