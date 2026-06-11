import { bigIntMax, bigIntMin, createDeferred, IDeferred, MiningFrames, MoveToken } from '@argonprotocol/apps-core';
import { ApiDecoration, EvmContracts, MICROGONS_PER_ARGON, u8aToHex } from '@argonprotocol/mainchain';
import { u8aConcat } from '@polkadot/util';
import type { Db } from './Db.ts';
import { getGatewayActivityWaitEstimateMs } from './EthereumClient.ts';
import { requestEthereumGatewayCatchUpThroughOperator, type ServerApiClient } from './ServerApiClient.ts';
import type { UpstreamOperatorClient } from './UpstreamOperatorClient.ts';
import type { WalletKeys } from './WalletKeys.ts';
import type { WalletHdKeysTable } from './db/WalletHdKeysTable.ts';
import { TransactionInfo } from './TransactionInfo.ts';
import { TransactionTracker } from './TransactionTracker.ts';
import { ExtrinsicType, TransactionStatus } from './db/TransactionsTable.ts';
import { getMainchainClient } from '../stores/mainchain.ts';

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
  destinationSigningKey: string;
  finalizeRequest: EvmContracts.MintingGatewayTransferOutOfArgonRequest;
  authorizationHash: string;
  mintingAuthorityTip: bigint;
  microgonCollateral: bigint;
  micronotCollateral: bigint;
  securityAmountMicrogons: bigint;
};

export type IMintingAuthorityAuthorizeMetadata = {
  actionType: 'authorizeTransfer';
  authorizations: Array<{
    authorityIndex: number;
    transferId: string;
    mintingAuthorityTip: bigint;
    microgonCollateral: bigint;
    micronotCollateral: bigint;
  }>;
};

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
      upstreamOperatorClient?: Pick<UpstreamOperatorClient, 'operatorHost' | 'requestEthereumGatewayCatchUp'>;
    }>,
  ) {
    this.data = {
      isReady: false,
      authorities: [],
      pendingMintingAuthorizations: [],
      pendingMintingAuthorizeTxInfosByTransferId: new Map(),
    };
  }

  public async load(reload = false): Promise<void> {
    if (this.#waitForLoad && !reload) return this.#waitForLoad.promise;

    this.#waitForLoad = createDeferred();
    try {
      await this.miningFrames.blockWatch.start();
      await this.refresh(await this.miningFrames.blockWatch.getFinalizedApi());
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
    const pendingMintingAuthorizations = await getPendingMintingAuthorizations(
      finalizedClient,
      authorities,
      getPendingLocalAuthorizations(this.transactionTracker.data.txInfos),
    );
    if (updateSeq !== this.#updateSeq) {
      return this.data.pendingMintingAuthorizations;
    }

    this.data.authorities = authorities;
    this.data.pendingMintingAuthorizations = pendingMintingAuthorizations;
    void this.syncPendingActivationRelay(authorities).catch(error =>
      console.error(`Error requesting pending minting-authority activation relay`, error),
    );
    return pendingMintingAuthorizations;
  }

  public async restoreSignerIndexes(
    finalizedClient: ApiDecoration<'promise'>,
    updateSeq = ++this.#updateSeq,
  ): Promise<IEthereumMintingAuthority[]> {
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
          let latestMatchingHeader;
          for (const header of headers) {
            const events = await this.miningFrames.blockWatch.getEvents(header);
            for (const { event } of events) {
              if (event.section !== 'crosschainTransfer') continue;
              latestMatchingHeader = header;
              break;
            }
          }

          if (latestMatchingHeader) {
            await this.refresh(await this.miningFrames.blockWatch.getApi(latestMatchingHeader), ++this.#updateSeq);
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

  public async authorize(transferId?: string): Promise<TransactionInfo<IMintingAuthorityAuthorizeMetadata>> {
    if (transferId) {
      const pendingTxInfo = this.data.pendingMintingAuthorizeTxInfosByTransferId.get(transferId);
      if (pendingTxInfo && !pendingTxInfo.isPostProcessed) {
        return pendingTxInfo;
      }
      this.data.pendingMintingAuthorizeTxInfosByTransferId.delete(transferId);
    }

    await this.load();
    let nextAuthorization = transferId
      ? this.data.pendingMintingAuthorizations.find(x => x.transferId === transferId)
      : this.data.pendingMintingAuthorizations[0];
    if (!nextAuthorization) {
      const finalizedClient = await this.miningFrames.blockWatch.getFinalizedApi();
      await this.refresh(finalizedClient);
      nextAuthorization = transferId
        ? this.data.pendingMintingAuthorizations.find(x => x.transferId === transferId)
        : this.data.pendingMintingAuthorizations[0];
      if (!nextAuthorization && transferId) {
        nextAuthorization = (
          await getPendingMintingAuthorizations(
            finalizedClient,
            this.data.authorities,
            getPendingLocalAuthorizations(this.transactionTracker.data.txInfos),
            transferId,
          )
        )[0];
      }
    }
    if (!nextAuthorization) {
      if (transferId) {
        throw new Error(`Transfer ${transferId} is not currently available to authorize.`);
      }
      throw new Error('No pending minting authorizations are currently available.');
    }

    const client = await this.miningFrames.blockWatch.clients.get(false);
    const txSigner = await this.walletKeys.getVaultingKeypair();
    const authorizations = transferId ? [nextAuthorization] : [...this.data.pendingMintingAuthorizations];
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
      tx: txs.length === 1 ? txs[0] : client.tx.utility.batch(txs),
      txSigner,
      extrinsicType: ExtrinsicType.CrosschainTransferAuthorize,
      metadata: {
        actionType: 'authorizeTransfer',
        authorizations: authorizations.map(
          ({
            authorityIndex,
            transferId: nextTransferId,
            mintingAuthorityTip,
            microgonCollateral,
            micronotCollateral,
          }) => ({
            authorityIndex,
            transferId: nextTransferId,
            mintingAuthorityTip,
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
    const db = await this.dbPromise;
    const client = await getMainchainClient(false);
    const { authorityIndex } = txInfo.tx.metadataJson;

    try {
      await txInfo.txResult.waitForFinalizedBlock;
    } catch (error) {
      await db.walletHdKeysTable.delete({
        keyRole: 'mintingAuthority',
        scopeKey: this.walletKeys.vaultingAddress.toLowerCase(),
        hdIndex: authorityIndex,
      });
      postProcessor.reject(error as Error);
      throw error;
    }

    try {
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
      this.data.pendingMintingAuthorizeTxInfosByTransferId.set(transferId, txInfo);
    }
    const postProcessor = txInfo.createPostProcessor();

    try {
      const client = await getMainchainClient(false);
      await this.refresh(await this.miningFrames.blockWatch.getFinalizedApi());
      await txInfo.txResult.waitForFinalizedBlock;
      const blockHash = txInfo.tx.blockHash ?? (await txInfo.txResult.waitForInFirstBlock);
      await this.refresh(await client.at(blockHash));
      postProcessor.resolve();
    } catch (error) {
      postProcessor.reject(error as Error);
      throw error;
    } finally {
      for (const { transferId } of authorizations) {
        if (this.data.pendingMintingAuthorizeTxInfosByTransferId.get(transferId)?.tx.id === txInfo.tx.id) {
          this.data.pendingMintingAuthorizeTxInfosByTransferId.delete(transferId);
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
    if (!serverApiClient && !upstreamOperatorClient?.operatorHost) {
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
      const relayError = await requestEthereumGatewayCatchUpThroughOperator({
        throughGatewayActivityNonce: nextGatewayActivityNonce,
        serverApiClient,
        upstreamOperatorClient: upstreamOperatorClient?.operatorHost ? upstreamOperatorClient : undefined,
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
      ? await finalizedClient.query.crosschainTransfer.mintingAuthoritiesBySigner.multi(derivedSigners)
      : [];

    for (const [offset, authorityOption] of authorityOptions.entries()) {
      if (authorityOption.isNone) continue;

      const authority = authorityOption.unwrap();
      if (authority.accountId.toString() !== walletKeys.vaultingAddress || !authority.destinationChain.isEthereum) {
        continue;
      }

      const authorityIndex = startIndex + offset;
      await walletHdKeysTable.upsert({
        keyRole: 'mintingAuthority',
        scopeKey,
        hdIndex: authorityIndex,
        hdPath: walletKeys.getMintingAuthorityEthereumHdPath(authorityIndex),
        address: derivedSigners[offset],
        publicKeyHex: null,
      });
    }
  }

  return await getOwnedEthereumMintingAuthorities(finalizedClient, walletKeys, walletHdKeysTable);
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

      authorizations.push({
        transferId,
        authorityIndex: authority.authorityIndex,
        moveToken: transfer.asset.isArgon ? MoveToken.ARGN : MoveToken.ARGNOT,
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
