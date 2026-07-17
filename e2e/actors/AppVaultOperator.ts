import {
  createOperationalAccessProof,
  Currency,
  hasCompletedTreasuryCertificationRequirements,
  JsonExt,
  MainchainClients,
  MiningFrames,
  TreasuryBonds,
} from '@argonprotocol/apps-core';
import {
  createBitcoinAddress,
  generateBlocks,
  sendBitcoinToAddress,
} from '@argonprotocol/apps-core/__test__/helpers/bitcoinCli.ts';
import { waitFor } from '@argonprotocol/apps-core/__test__/helpers/waitFor.ts';
import { BitcoinLock, Keyring, MICROGONS_PER_ARGON, TxSubmitter } from '@argonprotocol/mainchain';
import type { ApiDecoration, ArgonClient, SubmittableExtrinsic } from '@argonprotocol/mainchain';
import { sudoFundWallet } from '@argonprotocol/apps-core/__test__/helpers/sudoFundWallet.ts';
import { sudo } from '@argonprotocol/testing';
import type { IInviteResponse, IListInvitesResponse } from '@argonprotocol/apps-router';
import { DelegateSubmitLane } from '../../bot/src/DelegateSubmitLane.ts';
import { EthereumGatewayProverService } from '../../bot/src/EthereumGatewayProverService.ts';
import BitcoinLocks from '../../src-vue/lib/BitcoinLocks.ts';
import { Config } from '../../src-vue/lib/Config.ts';
import { loadEthereumChainConfig } from '../../src-vue/lib/EthereumClient.ts';
import { GlobalCouncil } from '../../src-vue/lib/GlobalCouncil.ts';
import { MintingAuthorities } from '../../src-vue/lib/MintingAuthorities.ts';
import { DEFAULT_MASTER_XPUB_PATH, MyVault } from '../../src-vue/lib/MyVault.ts';
import {
  buildOperatorAccountRegistrationTx,
  getOperationalChainProgressFromAccount,
  getOperationalRewardConfig,
  loadOperationalAccount,
} from '../../src-vue/lib/OperationalAccount.ts';
import { TransactionTracker } from '../../src-vue/lib/TransactionTracker.ts';
import { Vaults } from '../../src-vue/lib/Vaults.ts';
import { createTestDb } from '../../src-vue/__test__/helpers/db.ts';
import { getEthereumGatewayPauseReason, setMainchainClients } from '../../src-vue/stores/mainchain.ts';
import { Db } from '../../src-vue/lib/Db.ts';
import type { MemoryWalletKeys } from '../../src-vue/lib/MemoryWalletKeys.ts';
import { ServerAuthClient } from '../../src-vue/lib/ServerAuthClient.ts';

type IEthereumMintingAuthorityWalletSetup = {
  councilSigner: string;
  delegateAddress: string;
  mintingAuthoritySigner: string;
  vaultingAddress: string;
};

export type IEthereumMintingAuthorityStatus = IEthereumMintingAuthorityWalletSetup & {
  authorityActive: boolean;
  authorityPendingActivation: boolean;
  gatewayPauseReason: string;
  hasActivationRepaymentPricing: boolean;
  hasActiveCouncil: boolean;
  hasEthereumChainConfig: boolean;
  pendingApprovals: number;
};

export class AppVaultOperator {
  public readonly walletKeys: MemoryWalletKeys;
  public readonly config: Config;
  public readonly myVault: MyVault;
  public readonly globalCouncil: GlobalCouncil;
  public readonly mintingAuthorities: MintingAuthorities;

  private constructor(args: {
    db: Db;
    walletKeys: MemoryWalletKeys;
    miningFrames: MiningFrames;
    config: Config;
    myVault: MyVault;
    globalCouncil: GlobalCouncil;
    mintingAuthorities: MintingAuthorities;
    bitcoinLocks: BitcoinLocks;
  }) {
    this.#db = args.db;
    this.walletKeys = args.walletKeys;
    this.#miningFrames = args.miningFrames;
    this.config = args.config;
    this.myVault = args.myVault;
    this.globalCouncil = args.globalCouncil;
    this.mintingAuthorities = args.mintingAuthorities;
    this.#bitcoinLocks = args.bitcoinLocks;
  }

  #db: Db;
  #miningFrames: MiningFrames;
  #bitcoinLocks: BitcoinLocks;

  public static async load(args: {
    clients: MainchainClients;
    walletKeys: MemoryWalletKeys;
  }): Promise<AppVaultOperator> {
    const { clients, walletKeys } = args;

    setMainchainClients(clients);

    const db = await createTestDb();
    const dbPromise = Promise.resolve(db);
    const miningFrames = new MiningFrames(clients);
    const currency = new Currency(clients);
    const transactionTracker = new TransactionTracker(dbPromise, miningFrames.blockWatch);
    const bitcoinLocks = new BitcoinLocks(dbPromise, walletKeys, miningFrames.blockWatch, currency, transactionTracker);
    const globalCouncil = new GlobalCouncil(dbPromise, walletKeys, miningFrames);
    const relaySubmitLane = new DelegateSubmitLane(new Keyring({ type: 'sr25519' }).createFromUri('//Charlie'));
    const ethereumGatewayProverService = new EthereumGatewayProverService(relaySubmitLane, {
      shouldApplySharedRelayStagger: false,
    });
    const mintingAuthorities = new MintingAuthorities(
      dbPromise,
      walletKeys,
      miningFrames,
      transactionTracker,
      async () => ({
        serverApiClient: {
          getEthereumRelayStatus: async () => {
            relaySubmitLane.client = await clients.get(false);
            return await ethereumGatewayProverService.getRelayStatus();
          },
          requestEthereumGatewayCatchUp: async request => {
            relaySubmitLane.client = await clients.get(false);
            return await ethereumGatewayProverService.runToCheckpoint(request);
          },
        },
      }),
    );
    let vaultStats: string | null = null;
    const vaults = new Vaults('dev-docker', currency, miningFrames, {
      read: async () => vaultStats,
      write: async data => {
        vaultStats = data;
      },
    });
    const myVault = new MyVault(
      dbPromise,
      vaults,
      walletKeys,
      transactionTracker,
      bitcoinLocks,
      miningFrames,
      globalCouncil,
      mintingAuthorities,
    );
    const config = new Config(dbPromise, walletKeys);

    Object.assign(vaults, {
      load: () => Promise.resolve(),
      updateRevenue: async () => ({}),
    });

    await currency.fetchMainchainRates();
    await config.load();

    const chainConfig = await loadEthereumChainConfig();
    if (chainConfig) {
      await walletKeys.configureEthereumSignerPolicy({
        chainId: chainConfig.chainId,
        gatewayAddress: chainConfig.gatewayAddress,
        tokenAddresses: [chainConfig.argonTokenAddress, chainConfig.argonotTokenAddress],
      });
    }

    await myVault.load();

    return new AppVaultOperator({
      db,
      walletKeys,
      miningFrames,
      config,
      myVault,
      globalCouncil,
      mintingAuthorities,
      bitcoinLocks,
    });
  }

  public async ensureCouncilSignerRegistered(args: { client: ArgonClient }): Promise<boolean> {
    const tx = await this.globalCouncil.buildRegisterCouncilSignerTx(args.client);
    if (!tx) {
      return false;
    }

    await this.submitVaultingTx({
      client: args.client,
      tx,
    });
    return true;
  }

  public async ensureVaultReady(): Promise<void> {
    await this.myVault.load();
    if (this.myVault.createdVault) {
      return;
    }

    await this.myVault.recoverAccountVault({
      onProgress: () => undefined,
    });
    if (this.myVault.createdVault) {
      return;
    }

    const txInfo = await this.myVault.createNew({
      rules: this.config.vaultingRules,
      masterXpubPath: DEFAULT_MASTER_XPUB_PATH,
      config: this.config,
    });
    await txInfo.waitForPostProcessing;

    await this.myVault.load(true);
    if (this.myVault.createdVault) {
      return;
    }

    throw new Error(`AppVaultOperator could not recover or create a vault for ${this.walletKeys.treasuryAddress}.`);
  }

  public async bootstrapUpstreamOperator(args: { client: ArgonClient; vaultName: string }): Promise<void> {
    const { client } = args;
    const vaultName = args.vaultName.trim();
    if (!vaultName) {
      throw new Error('A vault name is required to bootstrap the upstream operator.');
    }

    const rewardConfig = await getOperationalRewardConfig(client);
    const requiredVaultingBalance =
      this.config.vaultingRules.baseMicrogonCommitment +
      rewardConfig.treasuryMinimumBonds +
      20n * BigInt(MICROGONS_PER_ARGON);

    await sudoFundWallet({
      client,
      address: this.walletKeys.treasuryAddress,
      microgons: requiredVaultingBalance,
      micronots: 0n,
    });

    await this.ensureVaultReady();

    const vault = this.myVault.createdVault;
    if (!vault) {
      throw new Error(`AppVaultOperator could not load a vault for ${this.walletKeys.treasuryAddress}.`);
    }

    const existingOperationalAccount = await loadOperationalAccount(this.walletKeys, client);
    const existingProgress = getOperationalChainProgressFromAccount(existingOperationalAccount, rewardConfig);

    if (vault.delegateAccountId && existingProgress.isOperational && existingProgress.availableAccessCodes > 0) {
      return;
    }

    if (!vault.delegateAccountId) {
      const txInfo = await this.myVault.setupVaultInviteProfile(vaultName);
      await txInfo?.txResult.waitForInFirstBlock;
    }

    if (!existingOperationalAccount.isSome) {
      const satoshis = await this.#bitcoinLocks.satoshisForArgonLiquidity(rewardConfig.treasuryMinimumBitcoin);
      const { txInfo } = await this.#bitcoinLocks.initializeLock({
        vault,
        satoshis,
      });
      if (!txInfo) {
        throw new Error('Upstream treasury bitcoin bootstrap did not create a lock transaction.');
      }

      const blockHash = txInfo.tx.blockHash ?? (await txInfo.txResult.waitForInFirstBlock);
      const apiAt = await client.at(blockHash);
      const { lock: treasuryLock } = await BitcoinLock.getBitcoinLockFromTxResult(apiAt, txInfo.txResult);

      const fundingAddress = BitcoinLocks.formatP2wshAddress(
        treasuryLock.p2wshScriptHashHex,
        this.#bitcoinLocks.bitcoinNetwork,
      );
      const minerAddress = createBitcoinAddress();
      sendBitcoinToAddress(fundingAddress, treasuryLock.satoshis);
      generateBlocks(8, minerAddress);

      await waitFor(45e3, 'upstream treasury bitcoin funded', async () => {
        const currentLock = await BitcoinLock.get(client, treasuryLock.utxoId);
        if (!currentLock?.isFunded) return;
        return currentLock;
      });

      if (rewardConfig.treasuryMinimumUniswapTransfer > 0n) {
        const transferTotalsKey = client.query.crosschainTransfer.transferTotalsByAccount.key(
          this.walletKeys.treasuryAddress,
        );
        const transferTotalsValue = client
          .createType('PalletCrosschainTransferAccountTransferTotals', {
            microgonsIn: rewardConfig.treasuryMinimumUniswapTransfer,
            microgonsOut: 0n,
            argonTransfersInCount: 1,
            argonTransfersOutCount: 0,
            micronotsIn: 0n,
            micronotsOut: 0n,
            argonotTransfersInCount: 0,
            argonotTransfersOutCount: 0,
          })
          .toHex();

        const setStorageResult = await new TxSubmitter(
          client,
          client.tx.sudo.sudo(client.tx.system.setStorage([[transferTotalsKey, transferTotalsValue]])),
          sudo(),
        ).submit({
          useLatestNonce: true,
        });
        await setStorageResult.waitForInFirstBlock;
      }

      const bondTx = await TreasuryBonds.buildBuyBondTx({
        client,
        vaultId: vault.vaultId,
        bondPurchaseMicrogons: rewardConfig.treasuryMinimumBonds,
      });
      const txSigner = await this.walletKeys.getTreasuryKeypair();
      const txResult = await new TxSubmitter(client, bondTx, txSigner).submit({
        useLatestNonce: true,
      });
      await txResult.waitForInFirstBlock;
    }

    const registrationTx = await buildOperatorAccountRegistrationTx({
      walletKeys: this.walletKeys,
      accessProof: null,
      client,
    });
    if (registrationTx) {
      const txSigner = await this.walletKeys.getTreasuryKeypair();
      const txResult = await new TxSubmitter(client, registrationTx, txSigner).submit({
        useLatestNonce: true,
      });
      await txResult.waitForInFirstBlock;
    }

    let accountBitcoinAmount = rewardConfig.treasuryMinimumBitcoin;
    if (rewardConfig.bitcoinLockSizeForUpgradeCode > accountBitcoinAmount) {
      accountBitcoinAmount = rewardConfig.bitcoinLockSizeForUpgradeCode;
    }

    const forceProgressResult = await new TxSubmitter(
      client,
      client.tx.sudo.sudo(
        client.tx.operationalAccounts.forceSetProgress(
          this.walletKeys.operationalAddress,
          {
            uniswapArgonTransfersInAmount: rewardConfig.operationalMinimumUniswapTransfer,
            accountBitcoinAmount,
            accountVaultBondAmount: rewardConfig.treasuryMinimumBonds,
            vaultCreated: true,
            vaultBitcoinAmount: rewardConfig.bitcoinLockSizeForUpgradeCode,
            miningSeatCount: rewardConfig.miningSeatsPerUpgradeCode,
          },
          true,
        ),
      ),
      sudo(),
    ).submit({
      useLatestNonce: true,
    });
    await forceProgressResult.waitForInFirstBlock;

    const txSigner = await this.walletKeys.getTreasuryKeypair();
    const activateResult = await new TxSubmitter(client, client.tx.operationalAccounts.activate(), txSigner).submit({
      useLatestNonce: true,
    });
    await activateResult.waitForInFirstBlock;

    const operationalAccount = await loadOperationalAccount(this.walletKeys, client);
    const progress = getOperationalChainProgressFromAccount(operationalAccount, rewardConfig);

    if (!progress.isOperational) {
      throw new Error('Upstream operational account did not become operational during bootstrap.');
    }
    if (progress.availableAccessCodes < 1) {
      throw new Error('Upstream operational account did not receive an access code during bootstrap.');
    }

    await this.myVault.load(true);
  }

  public async setCommittedArgonots(args: { amount: bigint }): Promise<void> {
    await this.ensureVaultReady();
    const txInfo = await this.myVault.setCommittedArgonots(args.amount);
    await txInfo.waitForPostProcessing;
  }

  public startOperationsUpgradePoller(args: { client: ArgonClient; routerHost: string; pollMs?: number }): {
    shutdown(): Promise<void>;
  } {
    const { client, routerHost } = args;
    const pollMs = args.pollMs ?? 5_000;
    const serverAuthClient = new ServerAuthClient(() => this.walletKeys);
    let isStopped = false;

    const runPromise = (async () => {
      while (!isStopped) {
        try {
          const invites = await this.requestRouterJson<IListInvitesResponse>({
            serverAuthClient,
            routerHost,
            path: '/invites',
          });

          for (const invite of invites.invites) {
            if (!invite.operationsUpgradeRequestedAt || invite.accessProof || !invite.operationalAccountId) {
              continue;
            }

            if (
              !invite.certificationProgress ||
              !hasCompletedTreasuryCertificationRequirements(invite.certificationProgress)
            ) {
              continue;
            }

            const operationalKeypair = await this.walletKeys.getOperationalKeypair();
            const accessProof = createOperationalAccessProof(operationalKeypair, invite.operationalAccountId);

            await this.requestRouterJson<IInviteResponse>({
              serverAuthClient,
              routerHost,
              path: `/invites/${encodeURIComponent(invite.inviteCode)}/mark-operations-upgraded`,
              init: {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                },
                body: JsonExt.stringify({
                  signature: accessProof.signature,
                }),
              },
            });

            break;
          }
        } catch (error) {
          console.warn('[dev-upstream] Unable to process requested operations upgrades.', error);
        }

        if (!isStopped) {
          await new Promise(resolve => setTimeout(resolve, pollMs));
        }
      }
    })();

    return {
      shutdown: async () => {
        isStopped = true;
        await runPromise.catch(() => undefined);
      },
    };
  }

  public async registerMintingAuthority(args: {
    microgonCollateral: bigint;
    micronotCollateral: bigint;
    authorityIndex?: number;
    signer?: string;
    councilSigner?: string;
  }) {
    return await this.mintingAuthorities.register(args);
  }

  public async waitForMintingAuthorityRegistration(args: {
    client: ArgonClient;
    signingKey: string;
    timeoutMs?: number;
  }) {
    const { client, signingKey, timeoutMs = 120_000 } = args;
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const authority = await client.query.crosschainTransfer.mintingAuthoritiesBySigner(signingKey);
      if (authority.isSome) {
        return authority.unwrap();
      }
      await new Promise(resolve => setTimeout(resolve, 1_000));
    }

    throw new Error(`Minting authority registration for ${signingKey} never appeared on chain.`);
  }

  public async approvePendingGatewayUpdates(args: { client: ArgonClient }): Promise<boolean> {
    const txs = await this.globalCouncil.buildApprovePendingGatewayUpdateTxs(args.client);
    if (!txs.length) {
      return false;
    }

    await this.submitVaultingTx({
      client: args.client,
      tx: txs.length === 1 ? txs[0] : args.client.tx.utility.batchAll(txs),
    });
    return true;
  }

  public async relayApprovedGatewayUpdates() {
    return await this.globalCouncil.relayApprovedGatewayUpdates();
  }

  public async authorizeNextPendingTransfer(client: ArgonClient): Promise<boolean> {
    const finalizedClient = await client.at(await client.rpc.chain.getFinalizedHead());
    const pendingMintingAuthorizations = await this.mintingAuthorities.refresh(finalizedClient);
    const nextPending = pendingMintingAuthorizations[0];
    if (!nextPending) {
      return false;
    }

    const txInfo = await this.mintingAuthorities.authorize(nextPending.transferId);
    await txInfo.waitForPostProcessing;
    return true;
  }

  public async getRequiredMintingAuthorityMicronotCollateral(args: {
    finalizedClient: ApiDecoration<'promise'>;
    microgonCollateral: bigint;
  }): Promise<bigint> {
    const activeCouncilHash =
      await args.finalizedClient.query.crosschainTransfer.activeGlobalIssuanceCouncilByDestinationChain('Ethereum');
    if (activeCouncilHash.isNone) {
      throw new Error('No active Ethereum council is available to price the minting authority collateral.');
    }

    const activeCouncil = await args.finalizedClient.query.crosschainTransfer.globalIssuanceCouncilByHash(
      activeCouncilHash.unwrap().toHex(),
    );
    if (activeCouncil.isNone) {
      throw new Error('The active Ethereum council snapshot could not be loaded for minting authority collateral.');
    }

    const epochMicrogonsPerArgonot = activeCouncil.unwrap().epochMicrogonsPerArgonot.toBigInt();
    if (epochMicrogonsPerArgonot <= 0n) {
      throw new Error('The active Ethereum council has an invalid microgonsPerArgonot price floor.');
    }

    return (
      (args.microgonCollateral * BigInt(MICROGONS_PER_ARGON) + epochMicrogonsPerArgonot - 1n) / epochMicrogonsPerArgonot
    );
  }

  public async getEthereumMintingAuthorityStatus(args: {
    client: ArgonClient;
    priorStatus?: IEthereumMintingAuthorityStatus;
  }): Promise<IEthereumMintingAuthorityStatus> {
    const finalizedClient = await args.client.at(await args.client.rpc.chain.getFinalizedHead());
    const setup = args.priorStatus ?? (await this.readEthereumMintingAuthorityWalletSetup());
    const [chainConfig, activationRepaymentPricing, activeCouncilHash, authorityOption, pendingApprovals] =
      await Promise.all([
        finalizedClient.query.crosschainTransfer.chainConfigBySourceChain('Ethereum'),
        finalizedClient.query.crosschainTransfer.mintingAuthorityActivationRepaymentPricingByDestinationChain(
          'Ethereum',
        ),
        finalizedClient.query.crosschainTransfer.activeGlobalIssuanceCouncilByDestinationChain('Ethereum'),
        finalizedClient.query.crosschainTransfer.mintingAuthoritiesBySigner(setup.mintingAuthoritySigner),
        this.globalCouncil.refresh(finalizedClient),
      ]);

    const authority = authorityOption.isSome ? authorityOption.unwrap() : undefined;
    const gatewayPauseReason = (await getEthereumGatewayPauseReason(finalizedClient)) ?? '';

    return {
      ...setup,
      authorityActive: authority?.state.isActive ?? false,
      authorityPendingActivation: authority?.state.isPendingActivation ?? false,
      gatewayPauseReason,
      hasActivationRepaymentPricing: activationRepaymentPricing.isSome,
      hasActiveCouncil: activeCouncilHash.isSome,
      hasEthereumChainConfig: chainConfig.isSome && chainConfig.unwrap().isEvm,
      pendingApprovals: pendingApprovals.length,
    };
  }

  public async dispose(): Promise<void> {
    this.myVault.unsubscribe();
    this.globalCouncil.unsubscribe();
    this.mintingAuthorities.unsubscribe();
    await this.#bitcoinLocks.shutdown().catch(() => undefined);
    await this.#miningFrames.stop().catch(() => undefined);
    await this.#db.close();
  }

  private async submitVaultingTx(args: { client: ArgonClient; tx: SubmittableExtrinsic }): Promise<void> {
    const txSigner = await this.walletKeys.getVaultingKeypair();
    const txResult = await new TxSubmitter(args.client, args.tx, txSigner).submit({
      useLatestNonce: true,
    });
    await txResult.waitForFinalizedBlock;
  }

  private async readEthereumMintingAuthorityWalletSetup(): Promise<IEthereumMintingAuthorityWalletSetup> {
    const delegateKeypair = await this.walletKeys.getVaultDelegateKeypair();
    const mintingAuthorityHdPath = this.walletKeys.getMintingAuthorityEthereumHdPath(0);
    const [mintingAuthoritySigner, councilSigner] = await this.walletKeys.getEthereumAddresses([
      mintingAuthorityHdPath,
      this.walletKeys.councilSignerEthereumHdPath,
    ]);

    return {
      councilSigner,
      delegateAddress: delegateKeypair.address,
      mintingAuthoritySigner,
      vaultingAddress: this.walletKeys.vaultingAddress,
    };
  }

  private async requestRouterJson<T>(args: {
    serverAuthClient: ServerAuthClient;
    routerHost: string;
    path: string;
    init?: RequestInit;
  }): Promise<T> {
    let hasRetried = false;

    while (true) {
      const sessionId = await args.serverAuthClient.getAdminOperatorSessionId(args.routerHost);
      const url = new URL(`${args.routerHost}${args.path}`);
      url.searchParams.set('sessionId', sessionId);

      const response = await fetch(url, args.init);
      const rawBody = await response.text();
      if ((response.status === 401 || response.status === 403) && !hasRetried) {
        hasRetried = true;
        args.serverAuthClient.invalidateAdminOperatorSessionId(args.routerHost);
        continue;
      }
      if (!response.ok) {
        throw new Error(rawBody || `Router request failed (${response.status})`);
      }

      return JsonExt.parse<T>(rawBody);
    }
  }
}
