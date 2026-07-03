import { Currency, MainchainClients, MiningFrames } from '@argonprotocol/apps-core';
import { Keyring, MICROGONS_PER_ARGON, TxSubmitter } from '@argonprotocol/mainchain';
import type { ApiDecoration, ArgonClient, SubmittableExtrinsic } from '@argonprotocol/mainchain';
import { bip39 } from '@argonprotocol/bitcoin';
import { wordlist as englishWordlist } from '@scure/bip39/wordlists/english';
import { DelegateSubmitLane } from '../../bot/src/DelegateSubmitLane.ts';
import { EthereumGatewayProverService } from '../../bot/src/EthereumGatewayProverService.ts';
import BitcoinLocks from '../../src-vue/lib/BitcoinLocks.ts';
import { Config } from '../../src-vue/lib/Config.ts';
import { loadEthereumChainConfig } from '../../src-vue/lib/EthereumClient.ts';
import { GlobalCouncil } from '../../src-vue/lib/GlobalCouncil.ts';
import { MemoryWalletKeys } from '../../src-vue/lib/MemoryWalletKeys.ts';
import { MintingAuthorities } from '../../src-vue/lib/MintingAuthorities.ts';
import { DEFAULT_MASTER_XPUB_PATH, MyVault } from '../../src-vue/lib/MyVault.ts';
import { TransactionTracker } from '../../src-vue/lib/TransactionTracker.ts';
import { Vaults } from '../../src-vue/lib/Vaults.ts';
import { createTestDb } from '../../src-vue/__test__/helpers/db.ts';
import { getEthereumGatewayPauseReason, setMainchainClients } from '../../src-vue/stores/mainchain.ts';
import { Db } from '../../src-vue/lib/Db.ts';

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

export class VaultActor {
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

  public static async load(args: { clients: MainchainClients; mnemonic: string }): Promise<VaultActor> {
    if (!bip39.validateMnemonic(args.mnemonic, englishWordlist)) {
      throw new Error('VaultActor requires a valid mnemonic.');
    }

    setMainchainClients(args.clients);

    const db = await createTestDb();
    const dbPromise = Promise.resolve(db);
    const walletKeys = new MemoryWalletKeys({
      substrateSuri: args.mnemonic,
      masterMnemonic: args.mnemonic,
    });
    const miningFrames = new MiningFrames(args.clients);
    const currency = new Currency(args.clients);
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
            relaySubmitLane.client = await args.clients.get(false);
            return await ethereumGatewayProverService.getRelayStatus();
          },
          requestEthereumGatewayCatchUp: async request => {
            relaySubmitLane.client = await args.clients.get(false);
            return await ethereumGatewayProverService.runToCheckpoint(request);
          },
        },
      }),
    );
    const vaults = new Vaults('dev-docker', currency, miningFrames);
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

    return new VaultActor({
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
    if (this.myVault.createdVault) {
      return;
    }

    await this.myVault.load(true);
    if (this.myVault.createdVault) {
      return;
    }

    throw new Error(`VaultActor could not recover or create a vault for ${this.walletKeys.vaultingAddress}.`);
  }

  public async setCommittedArgonots(args: { amount: bigint }): Promise<void> {
    await this.ensureVaultReady();
    const txInfo = await this.myVault.setCommittedArgonots(args.amount);
    await txInfo.waitForPostProcessing;
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
}
