import {
  type ArgonClient,
  type ArgonQueryClient,
  createDeferred,
  MiningFrames,
  IDeferred,
} from '@argonprotocol/apps-core';
import { u8aToHex } from '@argonprotocol/mainchain';
import type { SubmittableExtrinsic } from '@argonprotocol/mainchain';
import type { CrosschainTransferCouncilApprovalQueueByDestinationChainAndNonceResultSpec151 } from '@argonprotocol/runtime-client';
import { u8aConcat } from '@polkadot/util';
import type { Db } from './Db.ts';
import type { WalletKeys } from './WalletKeys.ts';
import type { WalletHdKeysTable } from './db/WalletHdKeysTable.ts';
import { getFinalizedClient } from '../stores/mainchain.ts';
import {
  EthereumClient,
  getEthereumExecutionRpcUrl,
  getEthereumFinalityMillis,
  hasGatewayApprovalQuorum,
  type GatewayRelayOptions,
  type IEthereumGatewayRelayPreview,
} from './EthereumClient.ts';
import { isAccountInGlobalIssuanceCouncil } from './CrosschainTransferView.ts';
const COUNCIL_SIGNER_REGISTRATION_MESSAGE_KEY = 'argon/council-signer/v2';
const COUNCIL_APPROVAL_QUEUE_BATCH_SIZE = 32n;

export type IGlobalCouncilChange = {
  vaultCount: number;
  newVaultCount: number;
  leavingVaultCount: number;
  epochMicrogonsPerArgonot: bigint;
};

export type IGlobalCouncilApproval = {
  approvalHash: string;
  queueNonce: bigint;
} & (
  | {
      targetKind: 'mintingAuthorityActivation';
      targetSigningKey: string;
      authorityOwnerAccount?: string;
    }
  | {
      targetKind: 'mintingAuthorityDeactivation';
      targetSigningKey: string;
      authorityOwnerAccount?: string;
    }
  | {
      targetKind: 'globalIssuanceCouncilRotation';
      targetCouncilHash: string;
      councilChange?: IGlobalCouncilChange;
    }
);

export type IGlobalCouncilQueueItem = IGlobalCouncilApproval & {
  approvalProgress: {
    approvedWeight: bigint;
    totalWeight: bigint;
    signatureCount: number;
    memberCount: number;
  };
  status: 'needsSignature' | 'awaitingCouncilQuorum' | 'readyForRelay';
};

export class GlobalCouncil {
  public data: {
    isReady: boolean;
    councilSigner?: string;
    isActiveCouncilMember: boolean;
    pendingApprovals: IGlobalCouncilApproval[];
    approvalQueue: IGlobalCouncilQueueItem[];
    gatewayActivityCount: bigint;
    activeEpochMicrogonsPerArgonot?: bigint;
    transferOutMicrogonsPerArgonot?: bigint;
    ethereumApprovalNonce?: bigint;
    ethereumApprovalBlockNumbers: Map<bigint, bigint>;
  };

  #subscriptions: Array<() => void> = [];
  #isSubscribing = false;
  #waitForLoad?: IDeferred;
  #updateSeq = 0;
  #pendingRelayPromise?: Promise<void>;
  #lastRelayCheckAt = 0;
  #lastSharedRelayQueueKey?: string;
  #lastSharedRelayQueueSeenAt = 0;
  #approvalBlockHydrationPromise?: Promise<void>;

  constructor(
    private readonly dbPromise: Promise<Db>,
    private readonly walletKeys: WalletKeys,
    private readonly miningFrames: MiningFrames,
    private readonly getConfiguredExecutionRpcUrl?: () => string | undefined,
  ) {
    this.data = {
      isReady: false,
      councilSigner: undefined,
      isActiveCouncilMember: false,
      pendingApprovals: [],
      approvalQueue: [],
      gatewayActivityCount: 0n,
      activeEpochMicrogonsPerArgonot: undefined,
      transferOutMicrogonsPerArgonot: undefined,
      ethereumApprovalNonce: undefined,
      ethereumApprovalBlockNumbers: new Map(),
    };
  }

  public async load(reload = false): Promise<void> {
    if (this.#waitForLoad?.isRunning) return this.#waitForLoad.promise;
    if (!reload && this.#waitForLoad?.isResolved) return this.#waitForLoad.promise;

    if (reload || this.#waitForLoad?.isRejected) {
      this.#waitForLoad = createDeferred();
    } else {
      this.#waitForLoad ??= createDeferred();
    }
    try {
      await this.miningFrames.blockWatch.start();
      await this.refresh(await this.miningFrames.blockWatch.getFinalizedApi());
      this.data.isReady = true;
      this.#waitForLoad.resolve();
    } catch (error) {
      console.error('[GlobalCouncil] Error loading council approvals', error);
      this.#waitForLoad.reject(error as Error);
    }
    return this.#waitForLoad.promise;
  }

  public async refresh(
    finalizedClient: ArgonQueryClient,
    updateSeq = ++this.#updateSeq,
  ): Promise<IGlobalCouncilApproval[]> {
    const db = await this.dbPromise;
    const {
      councilSigner,
      isActiveCouncilMember,
      pendingApprovals,
      approvalQueue,
      gatewayActivityCount,
      activeEpochMicrogonsPerArgonot,
      transferOutMicrogonsPerArgonot,
      hasReadyGatewayUpdates,
      sharedRelayQueueKey,
    } = await getPendingCouncilApprovals(finalizedClient, this.walletKeys, db.walletHdKeysTable);
    if (updateSeq !== this.#updateSeq) {
      return this.data.pendingApprovals;
    }

    this.data.councilSigner = councilSigner;
    this.data.isActiveCouncilMember = isActiveCouncilMember;
    this.data.pendingApprovals = pendingApprovals;
    this.data.approvalQueue = approvalQueue;
    this.data.gatewayActivityCount = gatewayActivityCount;
    this.data.activeEpochMicrogonsPerArgonot = activeEpochMicrogonsPerArgonot;
    this.data.transferOutMicrogonsPerArgonot = transferOutMicrogonsPerArgonot;
    const liveQueueNonces = new Set(approvalQueue.map(({ queueNonce }) => queueNonce));
    this.data.ethereumApprovalBlockNumbers = new Map(
      [...this.data.ethereumApprovalBlockNumbers].filter(([queueNonce]) => liveQueueNonces.has(queueNonce)),
    );
    void this.refreshEthereumApprovalNonce(updateSeq).catch(error =>
      console.error(`Error refreshing Ethereum gateway approval state`, error),
    );
    void this.syncApprovedGatewayRelay({
      councilSigner,
      hasReadyGatewayUpdates,
      sharedRelayQueueKey,
    }).catch(error => console.error(`Error relaying approved gateway updates`, error));
    return pendingApprovals;
  }

  public async subscribe() {
    if (this.#isSubscribing || this.#subscriptions.length) return;
    this.#isSubscribing = true;

    try {
      // make sure we only sign finalized requests
      const sub = this.miningFrames.blockWatch.events.on('finalized', async headers => {
        try {
          let latestMatchingHeader;
          for (const header of headers) {
            const events = await this.miningFrames.blockWatch.getEvents(header);
            for (const { event } of events) {
              if (event.section !== 'crosschainTransfer') continue;
              latestMatchingHeader = header;
              break;
            }
          }

          if (!latestMatchingHeader) return;
          await this.refresh(await this.miningFrames.blockWatch.getApi(latestMatchingHeader), ++this.#updateSeq);
        } catch (error) {
          console.error(`Error refreshing council approvals from block events`, error);
        }
      });
      this.#subscriptions.push(sub);
    } finally {
      this.#isSubscribing = false;
    }
  }

  public unsubscribe() {
    for (const sub of this.#subscriptions) {
      sub();
    }
    this.#subscriptions.length = 0;
  }

  public async buildRegisterCouncilSignerTx(client: ArgonClient): Promise<SubmittableExtrinsic | undefined> {
    const accountId = this.walletKeys.vaultingAddress;
    const [signer] = await this.walletKeys.getEthereumAddresses([this.walletKeys.councilSignerEthereumHdPath]);
    const [activeSigner, pendingSigner] = await Promise.all([
      client.query.crosschainTransfer.councilSignerByDestinationChainAndAccountId('Ethereum', accountId),
      client.query.crosschainTransfer.pendingCouncilSignerByDestinationChainAndAccountId('Ethereum', accountId),
    ]);

    if (activeSigner?.toLowerCase() === signer || pendingSigner?.toLowerCase() === signer) {
      return;
    }

    const payload = u8aToHex(
      u8aConcat(
        client.registry.createType('Bytes', COUNCIL_SIGNER_REGISTRATION_MESSAGE_KEY).toU8a(),
        client.registry.createType('PalletCrosschainTransferSourceChain', 'Ethereum').toU8a(),
        client.registry.createType('AccountId32', accountId).toU8a(),
      ),
    );

    return client.tx.crosschainTransfer.registerCouncilSigner(
      'Ethereum',
      signer,
      await this.walletKeys.signEthereumPersonalMessage(payload, this.walletKeys.councilSignerEthereumHdPath, 'argon'),
    );
  }

  public async buildApprovePendingGatewayUpdateTxs(
    client: ArgonClient,
    pendingApprovals: IGlobalCouncilApproval[] = this.data.pendingApprovals,
  ): Promise<SubmittableExtrinsic[]> {
    const txs: SubmittableExtrinsic[] = [];
    const maxQueueApprovalsPerCall = client.consts.crosschainTransfer.maxQueueApprovalsPerCall.toNumber();

    for (let i = 0; i < pendingApprovals.length; i += maxQueueApprovalsPerCall) {
      const approvals = pendingApprovals.slice(i, i + maxQueueApprovalsPerCall);
      const signatures = await Promise.all(
        approvals.map(({ approvalHash }) =>
          this.walletKeys.signEthereumPersonalMessage(
            approvalHash,
            this.walletKeys.councilSignerEthereumHdPath,
            'argon',
          ),
        ),
      );

      txs.push(
        client.tx.crosschainTransfer.approveQueueEntries('Ethereum', client.createType('Vec<[u8;65]>', signatures)),
      );
    }

    return txs;
  }

  public async relayApprovedGatewayUpdates(options: GatewayRelayOptions = {}) {
    const finalizedClient = await getFinalizedClient();

    const executionRpcUrl = getEthereumExecutionRpcUrl(this.getConfiguredExecutionRpcUrl?.());
    if (!executionRpcUrl) {
      throw new Error('Ethereum execution RPC is not configured for this app instance.');
    }

    const delegateAddress = await this.walletKeys.getVaultDelegateKeypair().then(x => x.address);
    const ethereumClient = new EthereumClient(this.walletKeys, executionRpcUrl);
    const receipt = await ethereumClient.applyReadyGatewayUpdates(
      finalizedClient,
      delegateAddress,
      {
        address: this.walletKeys.coreEthereumAddress,
        hdPath: this.walletKeys.ethereumHdPath,
      },
      options,
    );
    if (receipt) {
      await this.refreshEthereumApprovalNonce(this.#updateSeq, ethereumClient);
    }
    return receipt;
  }

  public async getReadyGatewayRelayPreview(options: GatewayRelayOptions = {}): Promise<IEthereumGatewayRelayPreview> {
    const finalizedClient = await getFinalizedClient();
    await this.refresh(finalizedClient, ++this.#updateSeq);

    const executionRpcUrl = getEthereumExecutionRpcUrl(this.getConfiguredExecutionRpcUrl?.());
    if (!executionRpcUrl) {
      throw new Error('Ethereum execution RPC is not configured for this app instance.');
    }

    const delegateAddress = await this.walletKeys.getVaultDelegateKeypair().then(x => x.address);
    return await new EthereumClient(this.walletKeys, executionRpcUrl).getReadyGatewayRelayPreview(
      finalizedClient,
      delegateAddress,
      {
        address: this.walletKeys.coreEthereumAddress,
        hdPath: this.walletKeys.ethereumHdPath,
      },
      options,
    );
  }

  public async hydrateEthereumApprovalBlockNumbers(
    queueNonces: bigint[],
    latestExecutionAnchorBlockNumber: bigint,
  ): Promise<void> {
    await this.#approvalBlockHydrationPromise;

    const missingQueueNonces = queueNonces.filter(
      queueNonce => !this.data.ethereumApprovalBlockNumbers.has(queueNonce),
    );
    if (!missingQueueNonces.length) return;

    const executionRpcUrl = getEthereumExecutionRpcUrl(this.getConfiguredExecutionRpcUrl?.());
    if (!executionRpcUrl) return;

    const ethereumClient = new EthereumClient(this.walletKeys, executionRpcUrl);
    const hydrationPromise = ethereumClient
      .getGatewayApprovalBlockNumbers(missingQueueNonces, latestExecutionAnchorBlockNumber)
      .then(blockNumbers => {
        this.data.ethereumApprovalBlockNumbers = new Map([...this.data.ethereumApprovalBlockNumbers, ...blockNumbers]);
      });
    this.#approvalBlockHydrationPromise = hydrationPromise;

    try {
      await hydrationPromise;
    } finally {
      this.#approvalBlockHydrationPromise = undefined;
    }
  }

  private async syncApprovedGatewayRelay(args: {
    councilSigner?: string;
    hasReadyGatewayUpdates: boolean;
    sharedRelayQueueKey?: string;
  }): Promise<void> {
    const { councilSigner, hasReadyGatewayUpdates, sharedRelayQueueKey } = args;
    if (!councilSigner || this.#pendingRelayPromise) {
      return;
    }
    if (!hasReadyGatewayUpdates && !sharedRelayQueueKey) {
      this.#lastSharedRelayQueueKey = undefined;
      this.#lastSharedRelayQueueSeenAt = 0;
      return;
    }

    const now = Date.now();
    const relayCheckMs = getEthereumFinalityMillis();
    if (now - this.#lastRelayCheckAt < relayCheckMs) {
      return;
    }
    this.#lastRelayCheckAt = now;

    const relayPromise = (async () => {
      if (hasReadyGatewayUpdates) {
        const receipt = await this.relayApprovedGatewayUpdates({
          allowUncompensatedRelay: true,
          onlyThroughOwnedUpdate: true,
        });
        if (receipt) {
          this.#lastSharedRelayQueueKey = undefined;
          this.#lastSharedRelayQueueSeenAt = 0;
          return;
        }
      }

      if (!sharedRelayQueueKey) {
        this.#lastSharedRelayQueueKey = undefined;
        this.#lastSharedRelayQueueSeenAt = 0;
        return;
      }

      if (this.#lastSharedRelayQueueKey !== sharedRelayQueueKey) {
        this.#lastSharedRelayQueueKey = sharedRelayQueueKey;
        this.#lastSharedRelayQueueSeenAt = now;
        return;
      }

      const relayableGatewayUpdateStaleMs = getEthereumFinalityMillis() * 3;
      if (now - this.#lastSharedRelayQueueSeenAt < relayableGatewayUpdateStaleMs) {
        return;
      }

      const preview = await this.getReadyGatewayRelayPreview();
      if (!preview.canRelay) {
        return;
      }

      await this.relayApprovedGatewayUpdates();
    })();
    this.#pendingRelayPromise = relayPromise;

    try {
      await relayPromise;
    } finally {
      this.#pendingRelayPromise = undefined;
    }
  }

  private async refreshEthereumApprovalNonce(updateSeq: number, ethereumClient?: EthereumClient): Promise<void> {
    if (!ethereumClient) {
      const executionRpcUrl = getEthereumExecutionRpcUrl(this.getConfiguredExecutionRpcUrl?.());
      if (!executionRpcUrl) return;
      ethereumClient = new EthereumClient(this.walletKeys, executionRpcUrl);
    }

    const ethereumApprovalNonce = await ethereumClient.getGatewayApprovalNonce();
    if (updateSeq === this.#updateSeq) {
      this.data.ethereumApprovalNonce = ethereumApprovalNonce;
    }
  }
}

async function getPendingCouncilApprovals(
  finalizeClient: ArgonQueryClient,
  walletKeys: WalletKeys,
  walletHdKeysTable: WalletHdKeysTable,
): Promise<{
  councilSigner?: string;
  isActiveCouncilMember: boolean;
  pendingApprovals: IGlobalCouncilApproval[];
  approvalQueue: IGlobalCouncilQueueItem[];
  gatewayActivityCount: bigint;
  activeEpochMicrogonsPerArgonot?: bigint;
  transferOutMicrogonsPerArgonot?: bigint;
  hasReadyGatewayUpdates: boolean;
  sharedRelayQueueKey?: string;
}> {
  const [councilSignerAddress] = await walletKeys.getEthereumAddresses([walletKeys.councilSignerEthereumHdPath]);
  await walletHdKeysTable.upsert({
    keyRole: 'councilSigner',
    scopeKey: walletKeys.vaultingAddress.toLowerCase(),
    hdIndex: 0,
    hdPath: walletKeys.councilSignerEthereumHdPath,
    address: councilSignerAddress,
    publicKeyHex: null,
  });

  const [
    councilSignerOption,
    councilApprovalCursorOption,
    gatewayStateOption,
    nextQueueNonce,
    activeCouncilHashOption,
    transferOutQuoteOption,
  ] = await Promise.all([
    finalizeClient.query.crosschainTransfer.councilSignerByDestinationChainAndAccountId(
      'Ethereum',
      walletKeys.vaultingAddress,
    ),
    finalizeClient.query.crosschainTransfer.councilApprovalCursorByDestinationChainAndAccountId(
      'Ethereum',
      walletKeys.vaultingAddress,
    ),
    finalizeClient.query.crosschainTransfer.gatewayStateBySourceChain('Ethereum'),
    finalizeClient.query.crosschainTransfer.nextCouncilApprovalQueueNonceByDestinationChain('Ethereum'),
    finalizeClient.query.crosschainTransfer.activeGlobalIssuanceCouncilByDestinationChain?.('Ethereum'),
    finalizeClient.query.crosschainTransfer.transferOutQuoteMicrogonsPerArgonotByDestinationChain?.('Ethereum'),
  ]);

  const councilSigner = councilSignerOption ?? undefined;
  const pendingApprovals: IGlobalCouncilApproval[] = [];
  const approvalQueue: IGlobalCouncilQueueItem[] = [];
  const approvalQueueCandidates: Array<{
    approval: IGlobalCouncilApproval;
    entry: NonNullable<CrosschainTransferCouncilApprovalQueueByDestinationChainAndNonceResultSpec151>;
    hasLocalSignature: boolean;
  }> = [];
  const canSignCouncilApprovals = councilSigner?.toLowerCase() === councilSignerAddress.toLowerCase();
  let sharedRelayQueueKey: string | undefined;
  const gatewayActivityCount = gatewayStateOption?.gatewayActivityNonce ?? 0n;

  if (canSignCouncilApprovals && councilApprovalCursorOption !== null) {
    const lastSyncedNonce = gatewayStateOption?.argonApprovalsNonce ?? 0n;
    const lastSignedNonce = councilApprovalCursorOption;
    const nextPendingQueueNonce = nextQueueNonce ?? 0n;
    let reachedQueueEnd = false;
    for (
      let batchStartNonce = lastSyncedNonce + 1n;
      batchStartNonce <= nextPendingQueueNonce && !reachedQueueEnd;
      batchStartNonce += COUNCIL_APPROVAL_QUEUE_BATCH_SIZE
    ) {
      const batchEndNonce = batchStartNonce + COUNCIL_APPROVAL_QUEUE_BATCH_SIZE - 1n;
      const batchNonces: bigint[] = [];
      for (
        let queueNonce = batchStartNonce;
        queueNonce <= nextPendingQueueNonce && queueNonce <= batchEndNonce;
        queueNonce += 1n
      ) {
        batchNonces.push(queueNonce);
      }
      const entryOptions =
        await finalizeClient.query.crosschainTransfer.councilApprovalQueueByDestinationChainAndNonce.multi(
          batchNonces.map(queueNonce => ['Ethereum', queueNonce]),
        );
      for (const [index, entry] of (entryOptions ?? []).entries()) {
        if (!entry) {
          reachedQueueEnd = true;
          break;
        }

        const queueNonce = batchNonces[index];
        const approvalHash = entry.approvalHash;
        let approval: IGlobalCouncilApproval;
        if (entry.target.type === 'MintingAuthorityActivation') {
          approval = {
            approvalHash,
            queueNonce,
            targetKind: 'mintingAuthorityActivation',
            targetSigningKey: entry.target.value,
          };
        } else if (entry.target.type === 'MintingAuthorityDeactivation') {
          approval = {
            approvalHash,
            queueNonce,
            targetKind: 'mintingAuthorityDeactivation',
            targetSigningKey: entry.target.value,
          };
        } else if (entry.target.type === 'GlobalIssuanceCouncilRotation') {
          approval = {
            approvalHash,
            queueNonce,
            targetKind: 'globalIssuanceCouncilRotation',
            targetCouncilHash: entry.target.value,
          };
        } else {
          continue;
        }

        approvalQueueCandidates.push({ approval, entry, hasLocalSignature: queueNonce <= lastSignedNonce });
      }
    }

    const approvingCouncilHashes = [...new Set(approvalQueueCandidates.map(({ entry }) => entry.approvingCouncilHash))];
    const approvingCouncilOptions = approvingCouncilHashes.length
      ? await finalizeClient.query.crosschainTransfer.globalIssuanceCouncilByHash.multi(approvingCouncilHashes)
      : [];
    const approvingCouncilsByHash = new Map(
      approvingCouncilHashes.map((hash, index) => [hash, approvingCouncilOptions?.[index]]),
    );

    for (const { approval, entry, hasLocalSignature } of approvalQueueCandidates) {
      const approvingCouncilHash = entry.approvingCouncilHash;
      const approvingCouncil = approvingCouncilsByHash.get(approvingCouncilHash);
      if (!approvingCouncil) {
        throw new Error(`GlobalIssuanceCouncil ${approvingCouncilHash} not found.`);
      }

      const approvalProgress = {
        approvedWeight: entry.approvedTotalWeight,
        totalWeight: approvingCouncil.totalWeight,
        signatureCount: Object.keys(entry.signatures).length,
        memberCount: Object.keys(approvingCouncil.members).length,
      };
      const isReadyForRelay = hasGatewayApprovalQuorum(approvalProgress);
      const status = isReadyForRelay ? 'readyForRelay' : hasLocalSignature ? 'awaitingCouncilQuorum' : 'needsSignature';

      approvalQueue.push({ ...approval, approvalProgress, status });
      if (status === 'needsSignature') pendingApprovals.push(approval);
    }

    if (approvalQueue.some(({ status }) => status === 'readyForRelay')) {
      sharedRelayQueueKey = `${lastSyncedNonce}:${nextPendingQueueNonce}`;
    }
  }

  const hasReadyGatewayUpdates = approvalQueue.some(({ status }) => status === 'readyForRelay');

  const authorityApprovals = approvalQueue.filter(approval => approval.targetKind !== 'globalIssuanceCouncilRotation');
  const authorityOptions = authorityApprovals.length
    ? await finalizeClient.query.crosschainTransfer.mintingAuthoritiesBySigner.multi(
        authorityApprovals.map(approval => approval.targetSigningKey),
      )
    : [];
  for (const [index, approval] of authorityApprovals.entries()) {
    const authority = authorityOptions?.[index];
    if (authority) approval.authorityOwnerAccount = authority.accountId;
  }

  const councilApprovals = approvalQueue.filter(approval => approval.targetKind === 'globalIssuanceCouncilRotation');
  const councilHashes = [
    ...(activeCouncilHashOption ? [activeCouncilHashOption] : []),
    ...councilApprovals.map(approval => approval.targetCouncilHash),
  ];
  const councilOptions = councilHashes.length
    ? await finalizeClient.query.crosschainTransfer.globalIssuanceCouncilByHash.multi(councilHashes)
    : [];
  const activeCouncil = activeCouncilHashOption ? (councilOptions?.[0] ?? undefined) : undefined;
  const isActiveCouncilMember = isAccountInGlobalIssuanceCouncil(activeCouncil, walletKeys.vaultingAddress);
  const activeMemberAccounts = new Set(
    activeCouncil ? Object.values(activeCouncil.members).map(member => member.accountId) : [],
  );
  const targetOffset = activeCouncilHashOption ? 1 : 0;
  for (const [index, approval] of councilApprovals.entries()) {
    const council = councilOptions?.[index + targetOffset];
    if (!council) continue;

    const targetMemberAccounts = new Set(Object.values(council.members).map(member => member.accountId));
    approval.councilChange = {
      vaultCount: targetMemberAccounts.size,
      newVaultCount: [...targetMemberAccounts].filter(accountId => !activeMemberAccounts.has(accountId)).length,
      leavingVaultCount: [...activeMemberAccounts].filter(accountId => !targetMemberAccounts.has(accountId)).length,
      epochMicrogonsPerArgonot: council.epochMicrogonsPerArgonot,
    };
  }
  for (const pendingApproval of pendingApprovals) {
    const queueItem = approvalQueue.find(item => item.queueNonce === pendingApproval.queueNonce);
    if (!queueItem || queueItem.targetKind !== pendingApproval.targetKind) continue;
    if (
      pendingApproval.targetKind === 'globalIssuanceCouncilRotation' &&
      queueItem.targetKind === 'globalIssuanceCouncilRotation'
    ) {
      pendingApproval.councilChange = queueItem.councilChange;
    } else if (
      pendingApproval.targetKind !== 'globalIssuanceCouncilRotation' &&
      queueItem.targetKind !== 'globalIssuanceCouncilRotation'
    ) {
      pendingApproval.authorityOwnerAccount = queueItem.authorityOwnerAccount;
    }
  }

  return {
    councilSigner,
    isActiveCouncilMember,
    pendingApprovals,
    approvalQueue,
    gatewayActivityCount,
    activeEpochMicrogonsPerArgonot: activeCouncil?.epochMicrogonsPerArgonot,
    transferOutMicrogonsPerArgonot: transferOutQuoteOption ?? activeCouncil?.epochMicrogonsPerArgonot,
    hasReadyGatewayUpdates,
    sharedRelayQueueKey,
  };
}
