import { bigIntMax, createDeferred, MiningFrames } from '@argonprotocol/apps-core';
import { u8aToHex } from '@argonprotocol/mainchain';
import type { IDeferred } from '@argonprotocol/apps-core';
import type { ApiDecoration, ArgonClient, SubmittableExtrinsic } from '@argonprotocol/mainchain';
import { u8aConcat } from '@polkadot/util';
import type { Db } from './Db.ts';
import type { WalletKeys } from './WalletKeys.ts';
import type { WalletHdKeysTable } from './db/WalletHdKeysTable.ts';
import { getFinalizedClient } from '../stores/mainchain.ts';
import {
  EthereumClient,
  getEthereumExecutionRpcUrl,
  getEthereumFinalityMillis,
  type IEthereumGatewayRelayPreview,
} from './EthereumClient.ts';
const COUNCIL_SIGNER_REGISTRATION_MESSAGE_KEY = 'argon/council-signer/v2';

export type IGlobalCouncilApproval = {
  approvalHash: string;
};

export class GlobalCouncil {
  public data: {
    isReady: boolean;
    councilSigner?: string;
    pendingApprovals: IGlobalCouncilApproval[];
  };

  #subscriptions: Array<() => void> = [];
  #isSubscribing = false;
  #waitForLoad?: IDeferred;
  #updateSeq = 0;
  #pendingRelayPromise?: Promise<void>;
  #lastRelayCheckAt = 0;
  #lastSharedRelayQueueKey?: string;
  #lastSharedRelayQueueSeenAt = 0;

  constructor(
    private readonly dbPromise: Promise<Db>,
    private readonly walletKeys: WalletKeys,
    private readonly miningFrames: MiningFrames,
  ) {
    this.data = {
      isReady: false,
      councilSigner: undefined,
      pendingApprovals: [],
    };
  }

  public async load(reload = false): Promise<void> {
    if (this.#waitForLoad && !reload) return this.#waitForLoad.promise;

    this.#waitForLoad = createDeferred();
    try {
      await this.miningFrames.blockWatch.start();
      await this.refresh(await this.miningFrames.blockWatch.getFinalizedApi());
      this.data.isReady = true;
      this.#waitForLoad.resolve();
    } catch (error) {
      this.#waitForLoad.reject(error as Error);
    }
    return this.#waitForLoad.promise;
  }

  public async refresh(
    finalizedClient: ApiDecoration<'promise'>,
    updateSeq = ++this.#updateSeq,
  ): Promise<IGlobalCouncilApproval[]> {
    const db = await this.dbPromise;
    const { councilSigner, pendingApprovals, hasSignedApprovalsAwaitingRelay, sharedRelayQueueKey } =
      await getPendingCouncilApprovals(finalizedClient, this.walletKeys, db.walletHdKeysTable);
    if (updateSeq !== this.#updateSeq) {
      return this.data.pendingApprovals;
    }

    this.data.councilSigner = councilSigner;
    this.data.pendingApprovals = pendingApprovals;
    void this.syncApprovedGatewayRelay({
      councilSigner,
      hasSignedApprovalsAwaitingRelay,
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

    if (
      (activeSigner.isSome && activeSigner.unwrap().toHex().toLowerCase() === signer) ||
      (pendingSigner.isSome && pendingSigner.unwrap().toHex().toLowerCase() === signer)
    ) {
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

  public async relayApprovedGatewayUpdates(options: { allowUncompensatedRelay?: boolean } = {}) {
    const finalizedClient = await getFinalizedClient();

    const executionRpcUrl = getEthereumExecutionRpcUrl();
    if (!executionRpcUrl) {
      throw new Error('Ethereum execution RPC is not configured for this app instance.');
    }

    const delegateAddress = await this.walletKeys.getVaultDelegateKeypair().then(x => x.address);
    return await new EthereumClient(this.walletKeys, executionRpcUrl).applyReadyGatewayUpdates(
      finalizedClient,
      delegateAddress,
      {
        address: this.walletKeys.ethereumAddress,
        hdPath: this.walletKeys.ethereumHdPath,
      },
      options,
    );
  }

  public async getReadyGatewayRelayPreview(): Promise<IEthereumGatewayRelayPreview> {
    const finalizedClient = await getFinalizedClient();
    await this.refresh(finalizedClient, ++this.#updateSeq);

    const executionRpcUrl = getEthereumExecutionRpcUrl();
    if (!executionRpcUrl) {
      throw new Error('Ethereum execution RPC is not configured for this app instance.');
    }

    const delegateAddress = await this.walletKeys.getVaultDelegateKeypair().then(x => x.address);
    return await new EthereumClient(this.walletKeys, executionRpcUrl).getReadyGatewayRelayPreview(
      finalizedClient,
      delegateAddress,
      {
        address: this.walletKeys.ethereumAddress,
        hdPath: this.walletKeys.ethereumHdPath,
      },
    );
  }

  private async syncApprovedGatewayRelay(args: {
    councilSigner?: string;
    hasSignedApprovalsAwaitingRelay: boolean;
    sharedRelayQueueKey?: string;
  }): Promise<void> {
    const { councilSigner, hasSignedApprovalsAwaitingRelay, sharedRelayQueueKey } = args;
    if (!councilSigner || this.#pendingRelayPromise) {
      return;
    }
    if (!hasSignedApprovalsAwaitingRelay && !sharedRelayQueueKey) {
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
      if (hasSignedApprovalsAwaitingRelay) {
        this.#lastSharedRelayQueueKey = undefined;
        this.#lastSharedRelayQueueSeenAt = 0;
        await this.relayApprovedGatewayUpdates({ allowUncompensatedRelay: true });
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
}

async function getPendingCouncilApprovals(
  finalizeClient: ApiDecoration<'promise'>,
  walletKeys: WalletKeys,
  walletHdKeysTable: WalletHdKeysTable,
): Promise<{
  councilSigner?: string;
  pendingApprovals: IGlobalCouncilApproval[];
  hasSignedApprovalsAwaitingRelay: boolean;
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

  const [councilSignerOption, councilApprovalCursorOption, gatewayStateOption, nextQueueNonce] = await Promise.all([
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
  ]);

  const councilSigner = councilSignerOption.isSome ? councilSignerOption.unwrap().toHex() : undefined;
  const pendingApprovals: IGlobalCouncilApproval[] = [];
  const canSignCouncilApprovals = councilSigner?.toLowerCase() === councilSignerAddress.toLowerCase();
  let hasSignedApprovalsAwaitingRelay = false;
  let sharedRelayQueueKey: string | undefined;

  if (canSignCouncilApprovals && !councilApprovalCursorOption.isNone) {
    const lastSyncedNonce = gatewayStateOption.isSome ? gatewayStateOption.unwrap().argonApprovalsNonce.toBigInt() : 0n;
    const lastSignedNonce = councilApprovalCursorOption.unwrap().toBigInt();
    const nextPendingQueueNonce = nextQueueNonce.toBigInt();
    hasSignedApprovalsAwaitingRelay = lastSignedNonce > lastSyncedNonce;
    for (
      let queueNonce = bigIntMax(lastSyncedNonce, lastSignedNonce) + 1n;
      queueNonce <= nextPendingQueueNonce;
      queueNonce += 1n
    ) {
      const entryOption = await finalizeClient.query.crosschainTransfer.councilApprovalQueueByDestinationChainAndNonce(
        'Ethereum',
        queueNonce,
      );
      if (entryOption.isNone) {
        break;
      }

      const entry = entryOption.unwrap();
      pendingApprovals.push({ approvalHash: entry.approvalHash.toHex() });
    }

    if (!hasSignedApprovalsAwaitingRelay && pendingApprovals.length === 0 && nextPendingQueueNonce > lastSyncedNonce) {
      sharedRelayQueueKey = `${lastSyncedNonce}:${nextPendingQueueNonce}`;
    }
  }

  return { councilSigner, pendingApprovals, hasSignedApprovalsAwaitingRelay, sharedRelayQueueKey };
}
