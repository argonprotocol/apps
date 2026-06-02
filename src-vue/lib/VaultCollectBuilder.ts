import { bigIntMin, type ArgonQueryClient, type MoveTo } from '@argonprotocol/apps-core';
import { type ArgonClient, type SubmittableExtrinsic } from '@argonprotocol/mainchain';
import type { MyVault } from './MyVault.ts';
import { TxAttemptState } from './TransactionTracker.ts';

export type ICollectOrphanCosignMetadata = {
  lockUtxoId: number;
  ownerAccount: string;
  txid: string;
  vout: number;
  vaultSignatureHex: string;
};

export type IVaultCollectMetadata = {
  vaultId: number;
  actionType: 'approveCouncil' | 'collectRevenue' | 'cosignBitcoin';
  councilApprovalCount?: number;
  expectedCollectRevenue: bigint;
  cosignedUtxoIds: number[];
  cosignedOrphanUtxos?: ICollectOrphanCosignMetadata[];
  moveTo: MoveTo;
};

export type IVaultCollectSubmission = {
  tx: SubmittableExtrinsic;
  metadata: IVaultCollectMetadata;
  submittedCosignUtxoIds: number[];
};

export type IVaultCollectNotice = {
  isProcessing: boolean;
  collectRevenue: bigint;
  expiringCollectAmount: bigint;
  nextCollectDueDate: number;
  signatureCount: number;
  nextCosignDueDate: number;
  councilApprovalCount: number;
  authorizedTransferCount: number;
  authorizedTransferRewardAmount: bigint;
  signaturePenalty: bigint;
  earningsAmountMicrogons: bigint;
  amountAtRiskMicrogons: bigint;
  transactionCount: number;
};

export class VaultCollectBuilder {
  constructor(private readonly myVault: MyVault) {}

  public getNotice(): IVaultCollectNotice | null {
    const { myVault } = this;
    const ownPendingLockUtxoIds = new Set<number>();
    for (const utxoId of myVault.data.pendingCosignUtxosById.keys()) {
      if (!myVault.bitcoinLocks.getLockByUtxoId(utxoId)) continue;
      ownPendingLockUtxoIds.add(utxoId);
    }

    const manualPendingCosignEntries = getManualPendingCosignEntries(myVault, ownPendingLockUtxoIds);

    const signaturePenalty = bigIntMin(
      manualPendingCosignEntries.reduce((sum, [, entry]) => sum + entry.targetValue, 0n),
      myVault.createdVault?.securitization ?? 0n,
    );

    const collectRevenue = myVault.data.pendingCollectRevenue;
    const signatureCount = manualPendingCosignEntries.length;
    const councilApprovalCount = myVault.globalCouncil.data.pendingApprovals.length;
    const pendingMintingAuthorizations = myVault.mintingAuthorities.data.pendingMintingAuthorizations;
    const authorizedTransferCount = pendingMintingAuthorizations.length;
    const authorizedTransferRewardAmount = pendingMintingAuthorizations.reduce(
      (sum, { mintingAuthorityTip }) => sum + mintingAuthorityTip,
      0n,
    );
    const earningsAmountMicrogons = collectRevenue + authorizedTransferRewardAmount;
    const amountAtRiskMicrogons = myVault.data.expiringCollectAmount + signaturePenalty;

    if (collectRevenue <= 0n && signatureCount === 0 && councilApprovalCount === 0 && authorizedTransferCount === 0) {
      return null;
    }

    const hasCollectWork = collectRevenue > 0n || signatureCount > 0;

    return {
      isProcessing: Boolean(
        myVault.data.pendingCollectTxInfo ||
          myVault.mintingAuthorities.data.pendingMintingAuthorizeTxInfosByTransferId.size,
      ),
      collectRevenue,
      expiringCollectAmount: myVault.data.expiringCollectAmount,
      nextCollectDueDate: myVault.data.nextCollectDueDate,
      signatureCount,
      nextCosignDueDate: myVault.data.nextCosignDueDate,
      councilApprovalCount,
      authorizedTransferCount,
      authorizedTransferRewardAmount,
      signaturePenalty,
      earningsAmountMicrogons,
      amountAtRiskMicrogons,
      transactionCount: Number(hasCollectWork || councilApprovalCount > 0) + authorizedTransferCount,
    };
  }

  public async buildPendingSubmission(args: {
    client: ArgonClient;
    finalizedClient: ArgonQueryClient;
    moveTo: MoveTo;
  }): Promise<IVaultCollectSubmission | undefined> {
    const { myVault } = this;
    if (!myVault.createdVault) {
      throw new Error('No vault created to collect revenue');
    }

    const { client, finalizedClient, moveTo } = args;
    const vaultId = myVault.createdVault.vaultId;
    const { bitcoinTxs, cosignedUtxoIds, cosignedOrphanUtxos } = await buildCollectBitcoinTxs({
      myVault,
      client,
      finalizedClient,
      vaultId,
    });

    const frameRevenues = await client.query.vaults.revenuePerFrameByVault(vaultId);
    const expectedCollectRevenue = frameRevenues.reduce(
      (total, frameRevenue) => total + frameRevenue.uncollectedRevenue.toBigInt(),
      0n,
    );
    const pendingCouncilApprovals = await myVault.globalCouncil.refresh(finalizedClient);
    const hasCollectWork = expectedCollectRevenue > 0n || bitcoinTxs.length > 0;
    const metadata = {
      vaultId,
      actionType: 'cosignBitcoin',
      expectedCollectRevenue,
      cosignedUtxoIds,
      cosignedOrphanUtxos,
      moveTo,
    } satisfies IVaultCollectMetadata;

    if (hasCollectWork) {
      const txs = [
        ...(await myVault.globalCouncil.buildApprovePendingGatewayUpdateTxs(client, pendingCouncilApprovals)),
        ...bitcoinTxs,
      ];
      if (expectedCollectRevenue > 0n) {
        txs.push(client.tx.vaults.collect(vaultId));
      }
      return {
        tx: txs.length === 1 ? txs[0] : client.tx.utility.batchAll(txs),
        metadata: {
          ...metadata,
          actionType: expectedCollectRevenue > 0n ? 'collectRevenue' : 'cosignBitcoin',
          councilApprovalCount: pendingCouncilApprovals.length,
        },
        submittedCosignUtxoIds: cosignedUtxoIds,
      };
    }

    if (pendingCouncilApprovals.length > 0) {
      const txs = await myVault.globalCouncil.buildApprovePendingGatewayUpdateTxs(client, pendingCouncilApprovals);
      return {
        tx: txs.length === 1 ? txs[0] : client.tx.utility.batchAll(txs),
        metadata: {
          ...metadata,
          actionType: 'approveCouncil',
          councilApprovalCount: pendingCouncilApprovals.length,
        },
        submittedCosignUtxoIds: [],
      };
    }

    return undefined;
  }
}

function getManualPendingCosignEntries(myVault: MyVault, ownPendingLockUtxoIds: Set<number>) {
  return Array.from(myVault.data.pendingCosignUtxosById.entries()).filter(([utxoId]) => {
    if (ownPendingLockUtxoIds.has(utxoId)) return false;
    return !myVault.data.myPendingBitcoinCosignTxInfosByUtxoId.has(utxoId);
  });
}

async function buildCollectBitcoinTxs(args: {
  myVault: MyVault;
  client: ArgonClient;
  finalizedClient: ArgonQueryClient;
  vaultId: number;
}) {
  const { myVault, client, finalizedClient, vaultId } = args;
  const pendingCosignUtxos = await client.query.vaults.pendingCosignByVaultId(vaultId);
  const bitcoinTxs: SubmittableExtrinsic[] = [];
  const cosignedUtxoIds: number[] = [];

  for (const pendingUtxoId of pendingCosignUtxos) {
    const utxoId = pendingUtxoId.toNumber();
    const latestTxAttempt = await myVault.findLatestReleaseCosignTxAttempt(utxoId);
    if (
      latestTxAttempt &&
      (latestTxAttempt.txAttemptState === TxAttemptState.Follow ||
        latestTxAttempt.txAttemptState === TxAttemptState.Finalized)
    ) {
      continue;
    }

    const pendingReleaseRaw = await finalizedClient.query.bitcoinLocks.lockReleaseRequestsByUtxoId(utxoId);
    if (pendingReleaseRaw.isNone) continue;

    const pendingRelease = pendingReleaseRaw.unwrap();
    const result = await myVault.buildCosignTx({
      utxoId,
      releaseRequest: {
        bitcoinNetworkFee: pendingRelease.bitcoinNetworkFee.toBigInt(),
        toScriptPubkey: pendingRelease.toScriptPubkey.toHex(),
      },
    });
    if (!result) continue;

    bitcoinTxs.push(result.tx);
    cosignedUtxoIds.push(utxoId);
  }

  const orphanCosigns = await myVault.buildPendingOrphanCosignTxs({
    finalizedClient,
    submitClient: client,
    vaultId,
  });

  bitcoinTxs.push(...orphanCosigns.map(x => x.tx));
  return {
    bitcoinTxs,
    cosignedUtxoIds,
    cosignedOrphanUtxos: orphanCosigns.map(x => x.metadata),
  };
}
