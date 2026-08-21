import { bigIntMax, bigIntMin, createDeferred, IDeferred, MiningFrames, MoveToken } from '@argonprotocol/apps-core';
import { ApiDecoration, EvmContracts, MICROGONS_PER_ARGON, u8aToHex } from '@argonprotocol/mainchain';
import { u8aConcat } from '@polkadot/util';
import type { Db } from './Db.ts';
import { calculateMintingAuthorityTipShare, convertMintingAuthorityTipToMicrogons } from './CrosschainHistory.ts';
import { getGatewayActivityWaitEstimateMs } from './EthereumClient.ts';
import { requestEthereumGatewayCatchup } from './EthereumGatewayCatchup.ts';
import type { ServerApiClient } from './ServerApiClient.ts';
import type { UpstreamOperatorClient } from './UpstreamOperatorClient.ts';
import type { WalletKeys } from './WalletKeys.ts';
import type { WalletHdKeysTable } from './db/WalletHdKeysTable.ts';
import { TransactionInfo } from './TransactionInfo.ts';
import { TransactionTracker } from './TransactionTracker.ts';
import { ExtrinsicType, TransactionStatus } from './db/TransactionsTable.ts';
import { getFinalizedClient, getMainchainClient } from '../stores/mainchain.ts';

const MINTING_AUTHORITY_SIGNER_SCAN_BATCH_SIZE = 16;
const MINTING_AUTHORITY_SIGNER_SCAN_LIMIT = 128;
const MINTING_AUTHORITY_SIGNER_REGISTRATION_MESSAGE_KEY = 'argon/minting-authority-signer/v2';

export type IEthereumMintingAuthority = {
  signer: string;
  authorityIndex?: number;
  isPendingActivation: boolean;
  isDeactivating: boolean;
  isActive: boolean;
  gatewayRemainingMicrogonCollateral: bigint;
  pendingReservedMicrogonCollateral: bigint;
  gatewayRemainingMicronotCollateral: bigint;
  pendingReservedMicronotCollateral: bigint;
  activePendingTransferIds: string[];
};

export type IMintingAuthorityAuthorization = {
  transferId: string;
  authorityIndex: number;
  moveToken: MoveToken.ARGN | MoveToken.ARGNOT;
  sourceAccount: string;
  destinationSigningKey: string;
  finalizeRequest: EvmContracts.MintingGatewayTransferOutOfArgonRequest;
  authorizationHash: string;
  mintingAuthorityTip: bigint;
  mintingAuthorityTipShare: bigint;
  mintingAuthorityTipValueMicrogons: bigint;
  microgonCollateral: bigint;
  micronotCollateral: bigint;
  securityAmountMicrogons: bigint;
};

export type IMintingAuthorityBackedTransfer = {
  transferId: string;
  status: 'waitingForAuthorizations' | 'readyForEthereum';
  moveToken: MoveToken.ARGN | MoveToken.ARGNOT;
  sourceAccount: string;
  sourceTransferNonce: bigint;
  destinationAccount: string;
  amount: bigint;
  validUntilEthereumBlock: bigint;
  mintingAuthorityTip: bigint;
  mintingAuthorityTipShare: bigint;
  totalAttachedCollateral: bigint;
  ownedMicrogonCollateral: bigint;
  ownedMicronotCollateral: bigint;
  authoritySigners: string[];
};

export type ICrosschainSourceTransferTotals = {
  microgonsOut: bigint;
  micronotsOut: bigint;
  transferOutCount: number;
};

export type IMintingAuthorityAuthorizeMetadata = {
  actionType: 'authorizeTransfer';
  authorizations: Array<{
    authorityIndex: number;
    transferId: string;
    mintingAuthorityTip: bigint;
    mintingAuthorityTipShare: bigint;
    mintingAuthorityTipValueMicrogons: bigint;
    microgonCollateral: bigint;
    micronotCollateral: bigint;
  }>;
};

export function getActiveMintingAuthorityRemaining(
  authorities: IEthereumMintingAuthority[],
  microgonsPerArgonot: bigint,
): { microgons: bigint; micronots: bigint; valueMicrogons: bigint } {
  const remaining = authorities.reduce(
    (total, authority) => {
      if (!authority.isActive) return total;

      total.microgons += bigIntMax(
        0n,
        authority.gatewayRemainingMicrogonCollateral - authority.pendingReservedMicrogonCollateral,
      );
      total.micronots += bigIntMax(
        0n,
        authority.gatewayRemainingMicronotCollateral - authority.pendingReservedMicronotCollateral,
      );
      return total;
    },
    { microgons: 0n, micronots: 0n },
  );

  return {
    ...remaining,
    valueMicrogons: remaining.microgons + (remaining.micronots * microgonsPerArgonot) / BigInt(MICROGONS_PER_ARGON),
  };
}

export type IMintingAuthorityRegisterMetadata = {
  actionType: 'registerMintingAuthority';
  authorityIndex: number;
  destinationSigningKey: string;
  microgonCollateral: bigint;
  micronotCollateral: bigint;
};

type ILocalPendingAuthorization = IMintingAuthorityAuthorizeMetadata['authorizations'][number];

export class MintingAuthorities {
  public data: {
    isReady: boolean;
    authorities: IEthereumMintingAuthority[];
    pendingMintingAuthorizations: IMintingAuthorityAuthorization[];
    backedTransfers: IMintingAuthorityBackedTransfer[];
    backedTransfersError?: string;
    sourceTotalsByAccount: Map<string, ICrosschainSourceTransferTotals>;
    sourceUpstreamVaultAccountsByAccount: Map<string, string>;
    pendingMintingAuthorizeTxInfosByTransferId: Map<string, TransactionInfo<IMintingAuthorityAuthorizeMetadata>>;
  };
  #subscriptions: VoidFunction[] = [];
  #isSubscribing = false;
  #waitForLoad?: IDeferred;
  #updateSeq = 0;
  #pendingActivationRelayPromise?: Promise<void>;
  #lastPendingActivationRelayKey?: string;
  #lastPendingActivationRelayRequestAt = 0;

  constructor(
    private readonly dbPromise: Promise<Db>,
    public readonly walletKeys: WalletKeys,
    private readonly miningFrames: MiningFrames,
    private readonly transactionTracker: TransactionTracker,
    private readonly getGatewayRelayClients?: () => Promise<{
      serverApiClient?: Pick<ServerApiClient, 'getEthereumRelayStatus' | 'requestEthereumGatewayCatchUp'>;
      upstreamOperatorClient?: Pick<UpstreamOperatorClient, 'resolveOperatorHost' | 'requestEthereumGatewayCatchUp'>;
    }>,
  ) {
    this.data = {
      isReady: false,
      authorities: [],
      pendingMintingAuthorizations: [],
      backedTransfers: [],
      sourceTotalsByAccount: new Map(),
      sourceUpstreamVaultAccountsByAccount: new Map(),
      pendingMintingAuthorizeTxInfosByTransferId: new Map(),
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
      const finalizedClient = await this.miningFrames.blockWatch.getFinalizedApi();
      await this.refresh(finalizedClient);
      if (!this.data.authorities.length) {
        const restoredAuthorities = await this.restoreSignerIndexes(finalizedClient);
        if (restoredAuthorities.length) {
          await this.refresh(finalizedClient);
        }
      }
      for (const txInfo of this.transactionTracker.pendingBlockTxInfosAtLoad) {
        if (txInfo.tx.extrinsicType === ExtrinsicType.CrosschainTransferAuthorize) {
          void this.onAuthorize(txInfo as TransactionInfo<IMintingAuthorityAuthorizeMetadata>);
          continue;
        }
        if (txInfo.tx.extrinsicType === ExtrinsicType.CrosschainTransferRegisterMintingAuthority) {
          void this.onRegister(txInfo as TransactionInfo<IMintingAuthorityRegisterMetadata>);
        }
      }
      this.data.isReady = true;
      this.#waitForLoad.resolve();
    } catch (error) {
      console.error('[MintingAuthorities] Error loading minting authorities', error);
      this.#waitForLoad.reject(error as Error);
    }
    return this.#waitForLoad.promise;
  }

  public async refresh(
    finalizedClient: ApiDecoration<'promise'>,
    updateSeq = ++this.#updateSeq,
  ): Promise<IMintingAuthorityAuthorization[]> {
    const db = await this.dbPromise;
    const authorities = await getOwnedEthereumMintingAuthorities(
      finalizedClient,
      this.walletKeys,
      db.walletHdKeysTable,
    );
    let backedTransfersError: string | undefined;
    const [pendingMintingAuthorizations, backedTransfers] = await Promise.all([
      getPendingMintingAuthorizations(
        finalizedClient,
        authorities,
        getPendingLocalAuthorizations(this.transactionTracker.data.txInfos),
      ),
      getMintingAuthorityBackedTransfers(finalizedClient, authorities).catch(error => {
        console.warn('[MintingAuthorities] Unable to refresh transfers backed by owned authorities', error);
        backedTransfersError = error instanceof Error ? error.message : `${error}`;
        return this.data.backedTransfers;
      }),
    ]);
    if (updateSeq !== this.#updateSeq) {
      return this.data.pendingMintingAuthorizations;
    }

    const sourceAccounts = [
      ...new Set([
        ...pendingMintingAuthorizations.map(authorization => authorization.sourceAccount),
        ...backedTransfers.map(transfer => transfer.sourceAccount),
      ]),
    ];
    const [sourceTotals, sourceUpstreamVaultAccountsByAccount] = await Promise.all([
      sourceAccounts.length
        ? finalizedClient.query.crosschainTransfer.transferTotalsByAccount.multi(sourceAccounts)
        : [],
      this.loadSourceUpstreamVaultAccounts(finalizedClient, sourceAccounts),
    ]);

    this.data.authorities = authorities;
    this.data.pendingMintingAuthorizations = pendingMintingAuthorizations;
    this.data.backedTransfers = backedTransfers;
    this.data.backedTransfersError = backedTransfersError;
    this.data.sourceTotalsByAccount = new Map(
      sourceAccounts.map((accountId, index) => {
        const totals = sourceTotals[index];
        return [
          accountId,
          {
            microgonsOut: totals.microgonsOut.toBigInt(),
            micronotsOut: totals.micronotsOut.toBigInt(),
            transferOutCount: totals.argonTransfersOutCount.toNumber() + totals.argonotTransfersOutCount.toNumber(),
          },
        ];
      }),
    );
    this.data.sourceUpstreamVaultAccountsByAccount = sourceUpstreamVaultAccountsByAccount;
    void this.syncPendingActivationRelay(authorities).catch(error =>
      console.error(`Error requesting pending minting-authority activation relay`, error),
    );
    return pendingMintingAuthorizations;
  }

  private async loadSourceUpstreamVaultAccounts(
    finalizedClient: ApiDecoration<'promise'>,
    sourceAccounts: string[],
  ): Promise<Map<string, string>> {
    if (!sourceAccounts.length) return new Map();

    try {
      const sourceOperationalAccountIds =
        await finalizedClient.query.operationalAccounts.operationalAccountBySubAccount.multi(sourceAccounts);
      const operationalAccountIds = [
        ...new Set(
          sourceOperationalAccountIds.flatMap(accountId => (accountId.isSome ? [accountId.unwrap().toString()] : [])),
        ),
      ];
      if (!operationalAccountIds.length) return new Map();

      const operationalAccountOptions =
        await finalizedClient.query.operationalAccounts.operationalAccounts.multi(operationalAccountIds);
      const operationalAccountsById = new Map(
        operationalAccountOptions.flatMap((account, index) =>
          account.isSome ? [[operationalAccountIds[index], account.unwrap()] as const] : [],
        ),
      );
      const upstreamAccountIds = [
        ...new Set(
          [...operationalAccountsById.values()].flatMap(account =>
            account.upstreamAccount.isSome ? [account.upstreamAccount.unwrap().toString()] : [],
          ),
        ),
      ];
      if (!upstreamAccountIds.length) return new Map();

      const upstreamAccountOptions =
        await finalizedClient.query.operationalAccounts.operationalAccounts.multi(upstreamAccountIds);
      const upstreamVaultAccountsById = new Map(
        upstreamAccountOptions.flatMap((account, index) =>
          account.isSome ? [[upstreamAccountIds[index], account.unwrap().vaultAccount.toString()] as const] : [],
        ),
      );
      const sourceUpstreamVaultAccounts = new Map<string, string>();

      for (const [index, sourceAccount] of sourceAccounts.entries()) {
        const operationalAccountId = sourceOperationalAccountIds[index];
        if (!operationalAccountId?.isSome) continue;

        const operationalAccount = operationalAccountsById.get(operationalAccountId.unwrap().toString());
        const upstreamAccountId = operationalAccount?.upstreamAccount;
        if (!upstreamAccountId?.isSome) continue;

        const upstreamVaultAccount = upstreamVaultAccountsById.get(upstreamAccountId.unwrap().toString());
        if (upstreamVaultAccount) sourceUpstreamVaultAccounts.set(sourceAccount, upstreamVaultAccount);
      }

      return sourceUpstreamVaultAccounts;
    } catch (error) {
      console.warn('[MintingAuthorities] Unable to resolve transfer source sponsors', error);
      return new Map();
    }
  }

  public async restoreSignerIndexes(
    finalizedClient: ApiDecoration<'promise'>,
    updateSeq = ++this.#updateSeq,
  ): Promise<IEthereumMintingAuthority[]> {
    const councilSigner = await finalizedClient.query.crosschainTransfer.councilSignerByDestinationChainAndAccountId(
      'Ethereum',
      this.walletKeys.defaultArgonAddress,
    );
    if (councilSigner.isNone) {
      return this.data.authorities;
    }

    const db = await this.dbPromise;
    const authorities = await restoreOwnedEthereumMintingAuthorities(
      finalizedClient,
      this.walletKeys,
      db.walletHdKeysTable,
    );
    if (updateSeq !== this.#updateSeq) {
      return this.data.authorities;
    }

    this.data.authorities = authorities;
    this.data.pendingMintingAuthorizations = [];
    this.data.backedTransfers = [];
    this.data.backedTransfersError = undefined;
    this.data.sourceTotalsByAccount = new Map();
    this.data.sourceUpstreamVaultAccountsByAccount = new Map();
    void this.syncPendingActivationRelay(authorities).catch(error =>
      console.error(`Error requesting restored minting-authority activation relay`, error),
    );
    return authorities;
  }

  public async subscribe() {
    if (this.#isSubscribing || this.#subscriptions.length) return;
    this.#isSubscribing = true;

    try {
      const sub = this.miningFrames.blockWatch.events.on('finalized', headers => {
        void (async () => {
          const hasPendingActivation = this.data.authorities.some(authority => authority.isPendingActivation);
          let latestMatchingClient: ApiDecoration<'promise'> | undefined;
          const registeredSigners = new Set<string>();
          for (const header of headers) {
            const { api, events } = await this.miningFrames.blockWatch.getEventsWithSpec(header);
            for (const { event } of events) {
              if (event.section !== 'crosschainTransfer') continue;
              latestMatchingClient = api;
              if (
                api.events.crosschainTransfer.MintingAuthorityRegistered.is(event) &&
                event.data.destinationChain.isEthereum &&
                event.data.accountId.toString() === this.walletKeys.vaultingAddress
              ) {
                registeredSigners.add(event.data.destinationSigningKey.toHex().toLowerCase());
              }
            }
          }

          if (latestMatchingClient) {
            await this.refresh(latestMatchingClient, ++this.#updateSeq);
            const recognizedSigners = new Set(this.data.authorities.map(authority => authority.signer.toLowerCase()));
            if ([...registeredSigners].some(signer => !recognizedSigners.has(signer))) {
              await this.restoreSignerIndexes(latestMatchingClient);
            }
            return;
          }
          if (!hasPendingActivation) return;

          await this.syncPendingActivationRelay(this.data.authorities);
        })().catch(error => console.error(`Error refreshing minting authorities from block events`, error));
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

  public async getNextSigner(councilSigner?: string): Promise<{ authorityIndex: number; signer: string }> {
    await this.load();
    const db = await this.dbPromise;
    return await getNextMintingAuthoritySigner({
      councilSigner,
      existingSigners: this.data.authorities.map(x => x.signer),
      walletHdKeysTable: db.walletHdKeysTable,
      walletKeys: this.walletKeys,
    });
  }

  public async register(args: {
    microgonCollateral: bigint;
    micronotCollateral: bigint;
    authorityIndex?: number;
    signer?: string;
    councilSigner?: string;
  }): Promise<TransactionInfo<IMintingAuthorityRegisterMetadata>> {
    await this.load();

    let { authorityIndex, signer } = args;
    if (authorityIndex == null || !signer) {
      ({ authorityIndex, signer } = await this.getNextSigner(args.councilSigner));
    }

    const db = await this.dbPromise;
    const scopeKey = this.walletKeys.vaultingAddress.toLowerCase();
    try {
      await db.walletHdKeysTable.upsert({
        keyRole: 'mintingAuthority',
        scopeKey,
        hdIndex: authorityIndex,
        hdPath: this.walletKeys.getMintingAuthorityEthereumHdPath(authorityIndex),
        address: signer,
        publicKeyHex: null,
      });

      const client = await this.miningFrames.blockWatch.clients.get(false);
      const txSigner = await this.walletKeys.getVaultingKeypair();
      const payload = u8aToHex(
        u8aConcat(
          client.registry.createType('Bytes', MINTING_AUTHORITY_SIGNER_REGISTRATION_MESSAGE_KEY).toU8a(),
          client.registry.createType('PalletCrosschainTransferSourceChain', 'Ethereum').toU8a(),
          client.registry.createType('AccountId32', this.walletKeys.vaultingAddress).toU8a(),
        ),
      );

      const txInfo = await this.transactionTracker.submitAndWatch({
        tx: client.tx.crosschainTransfer.registerMintingAuthority(
          'Ethereum',
          signer,
          await this.walletKeys.signEthereumPersonalMessage(
            payload,
            this.walletKeys.getMintingAuthorityEthereumHdPath(authorityIndex),
            'argon',
          ),
          args.microgonCollateral,
          args.micronotCollateral,
        ),
        txSigner,
        extrinsicType: ExtrinsicType.CrosschainTransferRegisterMintingAuthority,
        metadata: {
          actionType: 'registerMintingAuthority',
          authorityIndex,
          destinationSigningKey: signer,
          microgonCollateral: args.microgonCollateral,
          micronotCollateral: args.micronotCollateral,
        } satisfies IMintingAuthorityRegisterMetadata,
        useLatestNonce: true,
      });

      void this.onRegister(txInfo);
      return txInfo;
    } catch (error) {
      await db.walletHdKeysTable.delete({
        keyRole: 'mintingAuthority',
        scopeKey,
        hdIndex: authorityIndex,
      });
      throw error;
    }
  }

  public async authorize(transferIds?: string[]): Promise<TransactionInfo<IMintingAuthorityAuthorizeMetadata>> {
    const selectedTransferIds = transferIds
      ? [...new Set(transferIds.map(transferId => transferId.toLowerCase()))]
      : undefined;
    if (selectedTransferIds && !selectedTransferIds.length) {
      throw new Error('Select at least one minting authorization.');
    }

    if (selectedTransferIds?.length === 1) {
      const transferId = selectedTransferIds[0];
      const pendingTxInfo = this.data.pendingMintingAuthorizeTxInfosByTransferId.get(transferId);
      if (pendingTxInfo && !pendingTxInfo.isPostProcessed) {
        return pendingTxInfo;
      }
      this.data.pendingMintingAuthorizeTxInfosByTransferId.delete(transferId);
    }

    await this.load();
    const getAvailableAuthorizations = () => {
      if (!selectedTransferIds) return [...this.data.pendingMintingAuthorizations];

      const authorizationByTransferId = new Map(
        this.data.pendingMintingAuthorizations.map(authorization => [
          authorization.transferId.toLowerCase(),
          authorization,
        ]),
      );
      return selectedTransferIds
        .map(transferId => authorizationByTransferId.get(transferId))
        .filter(authorization => authorization !== undefined);
    };

    let authorizations = getAvailableAuthorizations();
    if (!authorizations.length || (selectedTransferIds && authorizations.length !== selectedTransferIds.length)) {
      const finalizedClient = await this.miningFrames.blockWatch.getFinalizedApi();
      await this.refresh(finalizedClient);
      authorizations = getAvailableAuthorizations();
      if (!authorizations.length && selectedTransferIds?.length === 1) {
        authorizations = await getPendingMintingAuthorizations(
          finalizedClient,
          this.data.authorities,
          getPendingLocalAuthorizations(this.transactionTracker.data.txInfos),
          selectedTransferIds[0],
        );
      }
    }
    if (!authorizations.length) {
      if (selectedTransferIds) {
        throw new Error('The selected transfers are not currently available to authorize.');
      }
      throw new Error('No pending minting authorizations are currently available.');
    }
    if (selectedTransferIds && authorizations.length !== selectedTransferIds.length) {
      const availableTransferIds = new Set(authorizations.map(authorization => authorization.transferId.toLowerCase()));
      const unavailableTransferIds = selectedTransferIds.filter(transferId => !availableTransferIds.has(transferId));
      throw new Error(
        `The following transfers are not currently available to authorize: ${unavailableTransferIds.join(', ')}`,
      );
    }

    const client = await this.miningFrames.blockWatch.clients.get(false);
    const txSigner = await this.walletKeys.getVaultingKeypair();
    const txs = await Promise.all(
      authorizations.map(async authorization =>
        client.tx.crosschainTransfer.collateralizeTransfer(
          authorization.transferId,
          await this.walletKeys.signEthereumPersonalMessage(
            authorization.authorizationHash,
            this.walletKeys.getMintingAuthorityEthereumHdPath(authorization.authorityIndex),
            'argon',
          ),
          authorization.microgonCollateral,
          authorization.micronotCollateral,
        ),
      ),
    );
    const txInfo = await this.transactionTracker.submitAndWatch({
      tx: txs.length === 1 ? txs[0] : client.tx.utility.batchAll(txs),
      txSigner,
      extrinsicType: ExtrinsicType.CrosschainTransferAuthorize,
      metadata: {
        actionType: 'authorizeTransfer',
        authorizations: authorizations.map(
          ({
            authorityIndex,
            transferId: nextTransferId,
            mintingAuthorityTip,
            mintingAuthorityTipShare,
            mintingAuthorityTipValueMicrogons,
            microgonCollateral,
            micronotCollateral,
          }) => ({
            authorityIndex,
            transferId: nextTransferId,
            mintingAuthorityTip,
            mintingAuthorityTipShare,
            mintingAuthorityTipValueMicrogons,
            microgonCollateral,
            micronotCollateral,
          }),
        ),
      } satisfies IMintingAuthorityAuthorizeMetadata,
      useLatestNonce: true,
    });

    void this.onAuthorize(txInfo);
    return txInfo;
  }

  private async onRegister(txInfo: TransactionInfo<IMintingAuthorityRegisterMetadata>): Promise<void> {
    const postProcessor = txInfo.createPostProcessor();
    const { authorityIndex } = txInfo.tx.metadataJson;

    try {
      const db = await this.dbPromise;
      try {
        await txInfo.txResult.waitForFinalizedBlock;
      } catch (error) {
        await db.walletHdKeysTable.delete({
          keyRole: 'mintingAuthority',
          scopeKey: this.walletKeys.vaultingAddress.toLowerCase(),
          hdIndex: authorityIndex,
        });
        throw error;
      }

      const client = await getMainchainClient(false);
      const blockHash = txInfo.tx.blockHash ?? (await txInfo.txResult.waitForInFirstBlock);
      await this.refresh(await client.at(blockHash));
      postProcessor.resolve();
    } catch (error) {
      postProcessor.reject(error as Error);
      throw error;
    }
  }

  public async onAuthorize(txInfo: TransactionInfo<IMintingAuthorityAuthorizeMetadata>): Promise<void> {
    const { authorizations } = txInfo.tx.metadataJson;
    for (const { transferId } of authorizations) {
      this.data.pendingMintingAuthorizeTxInfosByTransferId.set(transferId.toLowerCase(), txInfo);
    }
    const postProcessor = txInfo.createPostProcessor();

    try {
      const client = await getMainchainClient(false);
      await this.refresh(await getFinalizedClient(client));
      await txInfo.txResult.waitForFinalizedBlock;
      const blockHash = txInfo.tx.blockHash ?? (await txInfo.txResult.waitForInFirstBlock);
      await this.refresh(await client.at(blockHash));
      postProcessor.resolve();
    } catch (error) {
      postProcessor.reject(error as Error);
      throw error;
    } finally {
      for (const { transferId } of authorizations) {
        const normalizedTransferId = transferId.toLowerCase();
        if (this.data.pendingMintingAuthorizeTxInfosByTransferId.get(normalizedTransferId)?.tx.id === txInfo.tx.id) {
          this.data.pendingMintingAuthorizeTxInfosByTransferId.delete(normalizedTransferId);
        }
      }
    }
  }

  private async syncPendingActivationRelay(authorities: IEthereumMintingAuthority[]): Promise<void> {
    const pendingActivationSigners = authorities
      .filter(authority => authority.isPendingActivation)
      .map(authority => authority.signer.toLowerCase())
      .sort();
    if (!pendingActivationSigners.length) {
      this.#lastPendingActivationRelayKey = undefined;
      this.#lastPendingActivationRelayRequestAt = 0;
      return;
    }
    if (this.#pendingActivationRelayPromise) {
      return;
    }

    const { serverApiClient, upstreamOperatorClient } = (await this.getGatewayRelayClients?.()) ?? {};
    const upstreamOperatorHost = await upstreamOperatorClient?.resolveOperatorHost();
    if (!serverApiClient && !upstreamOperatorHost) {
      return;
    }

    const client = await this.miningFrames.blockWatch.clients.get(false);
    const gatewayState = await client.query.crosschainTransfer.gatewayStateBySourceChain('Ethereum');
    const currentRuntimeGatewayActivityNonce = gatewayState.isSome
      ? gatewayState.unwrap().gatewayActivityNonce.toBigInt()
      : 0n;
    const nextGatewayActivityNonce = currentRuntimeGatewayActivityNonce + 1n;
    const relayKey = `${nextGatewayActivityNonce}:${pendingActivationSigners.join(',')}`;
    const now = Date.now();
    const relayRetryMs = getGatewayActivityWaitEstimateMs();
    if (
      relayKey === this.#lastPendingActivationRelayKey &&
      now - this.#lastPendingActivationRelayRequestAt < relayRetryMs
    ) {
      return;
    }
    this.#lastPendingActivationRelayKey = relayKey;
    this.#lastPendingActivationRelayRequestAt = now;

    const relayPromise = (async () => {
      const { relayError } = await requestEthereumGatewayCatchup({
        throughGatewayActivityNonce: nextGatewayActivityNonce,
        serverApiClient,
        upstreamOperatorClient: upstreamOperatorHost ? upstreamOperatorClient : undefined,
      });
      if (relayError) {
        console.warn(
          `[MintingAuthorities] Unable to request relay for pending activation through gateway activity ${nextGatewayActivityNonce}: ${relayError}`,
        );
      }
    })();
    this.#pendingActivationRelayPromise = relayPromise;

    try {
      await relayPromise;
    } finally {
      this.#pendingActivationRelayPromise = undefined;
    }
  }
}

export async function getOwnedEthereumMintingAuthorities(
  finalizedClient: ApiDecoration<'promise'>,
  walletKeys: WalletKeys,
  walletHdKeysTable: WalletHdKeysTable,
): Promise<IEthereumMintingAuthority[]> {
  const { vaultingAddress } = walletKeys;
  const authorityHdKeys = await walletHdKeysTable.fetchByScope({
    keyRole: 'mintingAuthority',
    scopeKey: vaultingAddress.toLowerCase(),
  });
  if (authorityHdKeys.length === 0) return [];

  const authorityHdKeysBySigner = new Map(authorityHdKeys.map(x => [x.address.toLowerCase(), x] as const));
  const authorities = await finalizedClient.query.crosschainTransfer.mintingAuthoritiesBySigner.multi(
    authorityHdKeys.map(x => x.address),
  );

  return authorities
    .filter(x => x.isSome)
    .map(x => x.unwrap())
    .filter(authority => authority.accountId.toString() === vaultingAddress && authority.destinationChain.isEthereum)
    .map(authority => {
      const signer = authority.destinationSigningKey.toHex();
      return {
        signer,
        authorityIndex: authorityHdKeysBySigner.get(signer.toLowerCase())?.hdIndex,
        isPendingActivation: authority.state.isPendingActivation,
        isDeactivating: authority.state.isDeactivating,
        isActive: authority.state.isActive,
        gatewayRemainingMicrogonCollateral: authority.gatewayRemainingMicrogonCollateral.toBigInt(),
        pendingReservedMicrogonCollateral: authority.pendingReservedMicrogonCollateral.toBigInt(),
        gatewayRemainingMicronotCollateral: authority.gatewayRemainingMicronotCollateral.toBigInt(),
        pendingReservedMicronotCollateral: authority.pendingReservedMicronotCollateral.toBigInt(),
        activePendingTransferIds: [...authority.activePendingTransferIds].map(transferId =>
          transferId.toHex().toLowerCase(),
        ),
      };
    })
    .sort((left, right) => {
      if (left.authorityIndex != null && right.authorityIndex != null) {
        return left.authorityIndex - right.authorityIndex;
      }
      if (left.authorityIndex != null) return -1;
      if (right.authorityIndex != null) return 1;
      return left.signer.localeCompare(right.signer);
    });
}

export async function restoreOwnedEthereumMintingAuthorities(
  finalizedClient: ApiDecoration<'promise'>,
  walletKeys: WalletKeys,
  walletHdKeysTable: WalletHdKeysTable,
): Promise<IEthereumMintingAuthority[]> {
  const scopeKey = walletKeys.vaultingAddress.toLowerCase();
  const ownedSigners = await findOwnedEthereumMintingAuthoritySigners(finalizedClient, walletKeys);

  for (const { authorityIndex, signer } of ownedSigners) {
    await walletHdKeysTable.upsert({
      keyRole: 'mintingAuthority',
      scopeKey,
      hdIndex: authorityIndex,
      hdPath: walletKeys.getMintingAuthorityEthereumHdPath(authorityIndex),
      address: signer,
      publicKeyHex: null,
    });
  }

  return await getOwnedEthereumMintingAuthorities(finalizedClient, walletKeys, walletHdKeysTable);
}

export async function findOwnedEthereumMintingAuthoritySigners(
  finalizedClient: ApiDecoration<'promise'>,
  walletKeys: WalletKeys,
): Promise<Array<{ authorityIndex: number; signer: string }>> {
  const ownedSigners: Array<{ authorityIndex: number; signer: string }> = [];
  for (
    let startIndex = 0;
    startIndex < MINTING_AUTHORITY_SIGNER_SCAN_LIMIT;
    startIndex += MINTING_AUTHORITY_SIGNER_SCAN_BATCH_SIZE
  ) {
    const batchSize = Math.min(
      MINTING_AUTHORITY_SIGNER_SCAN_BATCH_SIZE,
      MINTING_AUTHORITY_SIGNER_SCAN_LIMIT - startIndex,
    );
    const derivedSigners = await walletKeys.getEthereumAddresses(
      walletKeys.getMintingAuthorityEthereumHdPaths(batchSize, startIndex),
    );
    const authorityOptions = derivedSigners.length
      ? await finalizedClient.query.crosschainTransfer?.mintingAuthoritiesBySigner?.multi?.(derivedSigners)
      : [];
    if (!authorityOptions) return ownedSigners;

    for (const [offset, authorityOption] of authorityOptions.entries()) {
      if (authorityOption.isNone) continue;

      const authority = authorityOption.unwrap();
      if (authority.accountId.toString() !== walletKeys.vaultingAddress || !authority.destinationChain.isEthereum) {
        continue;
      }

      ownedSigners.push({ authorityIndex: startIndex + offset, signer: derivedSigners[offset] });
    }
  }

  return ownedSigners;
}

export async function getNextMintingAuthoritySigner(args: {
  councilSigner?: string;
  existingSigners: string[];
  walletHdKeysTable: WalletHdKeysTable;
  walletKeys: WalletKeys;
}): Promise<{ authorityIndex: number; signer: string }> {
  const { councilSigner, existingSigners, walletHdKeysTable, walletKeys } = args;
  const scopeKey = walletKeys.vaultingAddress.toLowerCase();
  const trackedSigners = await walletHdKeysTable.fetchByScope({
    keyRole: 'mintingAuthority',
    scopeKey,
  });
  const blockedSigners = new Set(
    [walletKeys.ethereumAddress, councilSigner, ...existingSigners, ...trackedSigners.map(x => x.address)]
      .filter(Boolean)
      .map(signer => signer!.toLowerCase()),
  );
  const nextIndex = await walletHdKeysTable.getNextHdKeyIndex({
    keyRole: 'mintingAuthority',
    scopeKey,
  });

  for (
    let startIndex = nextIndex;
    startIndex < nextIndex + MINTING_AUTHORITY_SIGNER_SCAN_LIMIT;
    startIndex += MINTING_AUTHORITY_SIGNER_SCAN_BATCH_SIZE
  ) {
    const signers = await walletKeys.getEthereumAddresses(
      walletKeys.getMintingAuthorityEthereumHdPaths(
        Math.min(
          MINTING_AUTHORITY_SIGNER_SCAN_BATCH_SIZE,
          nextIndex + MINTING_AUTHORITY_SIGNER_SCAN_LIMIT - startIndex,
        ),
        startIndex,
      ),
    );

    for (const [offset, signer] of signers.entries()) {
      if (!blockedSigners.has(signer.toLowerCase())) {
        return {
          authorityIndex: startIndex + offset,
          signer,
        };
      }
    }
  }

  throw new Error('Unable to derive an unused minting-authority signing key.');
}

export async function getPendingMintingAuthorizations(
  finalizedClient: ApiDecoration<'promise'>,
  authorities: IEthereumMintingAuthority[],
  pendingLocalAuthorizations: ILocalPendingAuthorization[] = [],
  preferredTransferId?: string,
): Promise<IMintingAuthorityAuthorization[]> {
  const activeAuthorities = createActiveAuthorities(authorities, pendingLocalAuthorizations);
  if (activeAuthorities.length === 0) return [];

  const chainConfigOption = await finalizedClient.query.crosschainTransfer.chainConfigBySourceChain('Ethereum');
  if (chainConfigOption.isNone || !chainConfigOption.unwrap().isEvm) {
    return [];
  }

  const evmChainConfig = chainConfigOption.unwrap().asEvm;
  const minTransferCollateralIncrement =
    finalizedClient.consts.crosschainTransfer.minTransferCollateralIncrement.toBigInt();
  const pendingTransfers = await loadPendingAuthorizationTransfers(finalizedClient);
  const transfersToPlan = preferredTransferId
    ? pendingTransfers.filter(x => x.transferId.toLowerCase() === preferredTransferId.toLowerCase())
    : pendingTransfers;
  const authorizations: IMintingAuthorityAuthorization[] = [];

  for (const { pendingRequest, transferId, transfer, epochMicrogonsPerArgonot } of transfersToPlan) {
    if (!activeAuthorities.some(x => x.availableMicrogons > 0n || x.availableMicronots > 0n)) {
      break;
    }

    for (const authority of activeAuthorities) {
      if (authority.activePendingTransferIds.has(transferId.toLowerCase())) continue;

      const hasExistingCollateral = [...transfer.mintingAuthorityCollateralBySigner.keys()].some(
        signer => signer.toHex().toLowerCase() === authority.signer.toLowerCase(),
      );
      if (hasExistingCollateral) continue;

      const plannedCollateral = planTransferCollateral({
        isArgonAsset: transfer.asset.isArgon,
        remainingCollateral: pendingRequest.remainingCollateral.toBigInt(),
        availableMicrogons: authority.availableMicrogons,
        availableMicronots: authority.availableMicronots,
        epochMicrogonsPerArgonot,
      });
      if (plannedCollateral.collateralShare === 0n) continue;

      const completesTransfer = plannedCollateral.collateralShare >= pendingRequest.remainingCollateral.toBigInt();
      if (plannedCollateral.collateralShare < minTransferCollateralIncrement && !completesTransfer) {
        continue;
      }

      const finalizeRequest: EvmContracts.MintingGatewayTransferOutOfArgonRequest = {
        argonAccountId: transfer.argonAccountId.toHex(),
        argonTransferNonce: transfer.argonTransferNonce.toBigInt(),
        chainId: evmChainConfig.chainId.toBigInt(),
        recipient: transfer.destinationAccount.toHex(),
        validUntilBlock: transfer.validUntilEthereumBlock.toBigInt(),
        token: transfer.asset.isArgon ? evmChainConfig.argonToken.toHex() : evmChainConfig.argonotToken.toHex(),
        amount: transfer.amount.toBigInt(),
        mintingAuthorityTip: transfer.mintingAuthorityTip.toBigInt(),
        microgonsPerArgonot: epochMicrogonsPerArgonot,
      };
      const moveToken = transfer.asset.isArgon ? MoveToken.ARGN : MoveToken.ARGNOT;
      const transferAmount = transfer.amount.toBigInt();
      const expectedTotalCollateral = bigIntMax(
        transferAmount,
        transferAmount - pendingRequest.remainingCollateral.toBigInt() + plannedCollateral.collateralShare,
      );
      const mintingAuthorityTipShare = calculateMintingAuthorityTipShare({
        moveToken,
        mintingAuthorityTip: finalizeRequest.mintingAuthorityTip,
        totalCollateral: expectedTotalCollateral,
        microgonsPerArgonot: epochMicrogonsPerArgonot,
        microgonCollateral: plannedCollateral.microgonCollateral,
        micronotCollateral: plannedCollateral.micronotCollateral,
      });

      authorizations.push({
        transferId,
        authorityIndex: authority.authorityIndex,
        moveToken,
        sourceAccount: transfer.argonAccountId.toString(),
        destinationSigningKey: authority.signer,
        finalizeRequest,
        authorizationHash: EvmContracts.hashMintingGatewayMintingAuthorization(
          {
            chainId: evmChainConfig.chainId.toBigInt(),
            gatewayAddress: evmChainConfig.gateway.toHex(),
          },
          {
            request: finalizeRequest,
            microgonCollateral: plannedCollateral.microgonCollateral,
            micronotCollateral: plannedCollateral.micronotCollateral,
          },
        ),
        mintingAuthorityTip: finalizeRequest.mintingAuthorityTip,
        mintingAuthorityTipShare,
        mintingAuthorityTipValueMicrogons: convertMintingAuthorityTipToMicrogons({
          moveToken,
          mintingAuthorityTip: mintingAuthorityTipShare,
          microgonsPerArgonot: epochMicrogonsPerArgonot,
        }),
        microgonCollateral: plannedCollateral.microgonCollateral,
        micronotCollateral: plannedCollateral.micronotCollateral,
        securityAmountMicrogons: plannedCollateral.collateralShare,
      });

      authority.availableMicrogons -= plannedCollateral.microgonCollateral;
      authority.availableMicronots -= plannedCollateral.micronotCollateral;
      authority.activePendingTransferIds.add(transferId.toLowerCase());
      break;
    }
  }

  return authorizations;
}

export async function getMintingAuthorityBackedTransfers(
  finalizedClient: ApiDecoration<'promise'>,
  authorities: IEthereumMintingAuthority[],
): Promise<IMintingAuthorityBackedTransfer[]> {
  const authoritySigners = new Set(authorities.map(authority => authority.signer.toLowerCase()));
  const transferIds = [...new Set(authorities.flatMap(authority => authority.activePendingTransferIds))];
  if (transferIds.length === 0) return [];

  const transferOptions = await finalizedClient.query.crosschainTransfer.transferOutById.multi(transferIds);
  const backedTransfers: IMintingAuthorityBackedTransfer[] = [];

  for (const [index, transferOption] of transferOptions.entries()) {
    if (transferOption.isNone) continue;

    const transfer = transferOption.unwrap();
    let ownedMicrogonCollateral = 0n;
    let ownedMicronotCollateral = 0n;
    const ownedAuthoritySigners: string[] = [];

    for (const [signer, collateral] of transfer.mintingAuthorityCollateralBySigner.entries()) {
      const signerAddress = signer.toHex();
      if (!authoritySigners.has(signerAddress.toLowerCase())) continue;

      ownedAuthoritySigners.push(signerAddress);
      ownedMicrogonCollateral += collateral.microgonCollateral.toBigInt();
      ownedMicronotCollateral += collateral.micronotCollateral.toBigInt();
    }

    if (ownedAuthoritySigners.length === 0) continue;

    const moveToken = transfer.asset.isArgon ? MoveToken.ARGN : MoveToken.ARGNOT;
    const amount = transfer.amount.toBigInt();
    const totalAttachedCollateral = transfer.totalAttachedCollateral.toBigInt();
    const mintingAuthorityTip = transfer.mintingAuthorityTip.toBigInt();

    backedTransfers.push({
      transferId: transferIds[index],
      status: transfer.state.isReady ? 'readyForEthereum' : 'waitingForAuthorizations',
      moveToken,
      sourceAccount: transfer.argonAccountId.toString(),
      sourceTransferNonce: transfer.argonTransferNonce.toBigInt(),
      destinationAccount: transfer.destinationAccount.toHex(),
      amount,
      validUntilEthereumBlock: transfer.validUntilEthereumBlock.toBigInt(),
      mintingAuthorityTip,
      mintingAuthorityTipShare: calculateMintingAuthorityTipShare({
        moveToken,
        mintingAuthorityTip,
        totalCollateral: bigIntMax(amount, totalAttachedCollateral),
        microgonsPerArgonot: transfer.microgonsPerArgonot.toBigInt(),
        microgonCollateral: ownedMicrogonCollateral,
        micronotCollateral: ownedMicronotCollateral,
      }),
      totalAttachedCollateral,
      ownedMicrogonCollateral,
      ownedMicronotCollateral,
      authoritySigners: ownedAuthoritySigners,
    });
  }

  return backedTransfers;
}

function createActiveAuthorities(
  authorities: IEthereumMintingAuthority[],
  pendingLocalAuthorizations: ILocalPendingAuthorization[],
) {
  const activeAuthorities = authorities
    .filter(authority => authority.isActive && authority.authorityIndex != null)
    .map(authority => ({
      authorityIndex: authority.authorityIndex!,
      signer: authority.signer,
      availableMicrogons: authority.gatewayRemainingMicrogonCollateral - authority.pendingReservedMicrogonCollateral,
      availableMicronots: authority.gatewayRemainingMicronotCollateral - authority.pendingReservedMicronotCollateral,
      activePendingTransferIds: new Set(authority.activePendingTransferIds),
    }));

  const authoritiesByIndex = new Map(activeAuthorities.map(authority => [authority.authorityIndex, authority]));
  for (const { authorityIndex, transferId, microgonCollateral, micronotCollateral } of pendingLocalAuthorizations) {
    const authority = authoritiesByIndex.get(authorityIndex);
    if (!authority) continue;

    authority.availableMicrogons = bigIntMax(0n, authority.availableMicrogons - microgonCollateral);
    authority.availableMicronots = bigIntMax(0n, authority.availableMicronots - micronotCollateral);
    authority.activePendingTransferIds.add(transferId.toLowerCase());
  }

  return activeAuthorities.filter(x => x.availableMicronots > 0n || x.availableMicrogons > 0n);
}

async function loadPendingAuthorizationTransfers(finalizedClient: ApiDecoration<'promise'>) {
  const pendingRequests =
    await finalizedClient.query.crosschainTransfer.pendingCollateralizationRequestsByChain('Ethereum');
  const transferIds = pendingRequests.map(request => request.transferId.toHex());
  const transferOptions = transferIds.length
    ? await finalizedClient.query.crosschainTransfer.transferOutById.multi(transferIds)
    : [];
  type PendingAuthorizationTransfer = {
    pendingRequest: (typeof pendingRequests)[number];
    transferId: string;
    transfer: ReturnType<(typeof transferOptions)[number]['unwrap']>;
    epochMicrogonsPerArgonot: bigint;
  };
  const transfersToPlan: PendingAuthorizationTransfer[] = [];

  for (const [index, pendingRequest] of pendingRequests.entries()) {
    const transferOption = transferOptions[index];
    if (transferOption.isNone) continue;

    const transfer = transferOption.unwrap();
    transfersToPlan.push({
      pendingRequest,
      transferId: transferIds[index],
      transfer,
      epochMicrogonsPerArgonot: transfer.microgonsPerArgonot.toBigInt(),
    });
  }

  return transfersToPlan;
}

function getPendingLocalAuthorizations(txInfos: TransactionInfo[]) {
  return txInfos
    .filter(
      txInfo =>
        txInfo.tx.extrinsicType === ExtrinsicType.CrosschainTransferAuthorize &&
        (txInfo.tx.status === TransactionStatus.Submitted || txInfo.tx.status === TransactionStatus.InBlock) &&
        !txInfo.txResult.submissionError,
    )
    .flatMap(({ tx }) => (tx.metadataJson as IMintingAuthorityAuthorizeMetadata).authorizations);
}

function planTransferCollateral(args: {
  isArgonAsset: boolean;
  remainingCollateral: bigint;
  availableMicrogons: bigint;
  availableMicronots: bigint;
  epochMicrogonsPerArgonot: bigint;
}) {
  const { isArgonAsset, remainingCollateral, availableMicrogons, availableMicronots, epochMicrogonsPerArgonot } = args;

  if (remainingCollateral <= 0n) {
    return {
      microgonCollateral: 0n,
      micronotCollateral: 0n,
      collateralShare: 0n,
    };
  }

  if (!isArgonAsset) {
    const micronotCollateral = bigIntMin(availableMicronots, remainingCollateral);
    return {
      microgonCollateral: 0n,
      micronotCollateral,
      collateralShare: micronotCollateral,
    };
  }

  if (availableMicrogons >= remainingCollateral) {
    return {
      microgonCollateral: remainingCollateral,
      micronotCollateral: 0n,
      collateralShare: remainingCollateral,
    };
  }

  if (availableMicronots <= 0n) {
    const microgonCollateral = bigIntMin(availableMicrogons, remainingCollateral);
    return {
      microgonCollateral,
      micronotCollateral: 0n,
      collateralShare: microgonCollateral,
    };
  }

  const microgonCollateral = bigIntMin(availableMicrogons, remainingCollateral);
  const remainingAfterMicrogons = remainingCollateral - microgonCollateral;
  const micronotCollateralNeeded = ceilDiv(
    remainingAfterMicrogons * BigInt(MICROGONS_PER_ARGON),
    epochMicrogonsPerArgonot,
  );
  const micronotCollateral = bigIntMin(availableMicronots, micronotCollateralNeeded);

  return {
    microgonCollateral,
    micronotCollateral,
    collateralShare: microgonCollateral + (micronotCollateral * epochMicrogonsPerArgonot) / BigInt(MICROGONS_PER_ARGON),
  };
}

function ceilDiv(value: bigint, divisor: bigint) {
  if (value <= 0n) {
    return 0n;
  }
  return (value + divisor - 1n) / divisor;
}
