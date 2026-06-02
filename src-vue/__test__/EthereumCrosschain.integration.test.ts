import Path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  Currency,
  MoveTo,
  MainchainClients,
  MiningFrames,
  minimumVaultDelegateBalance,
  MoveToken,
  NetworkConfig,
} from '@argonprotocol/apps-core';
import {
  startArgonTestNetwork,
  type StartedArgonTestNetwork,
} from '@argonprotocol/apps-core/__test__/startArgonTestNetwork.js';
import {
  getFinalizedClient,
  submitAndFinalize,
  sudoSubmitAndFinalize,
} from '@argonprotocol/apps-core/__test__/helpers/mainchain.ts';
import { sudoFundWallet } from '@argonprotocol/apps-core/__test__/helpers/sudoFundWallet.ts';
import {
  buildGatewayActivityProofPayload,
  EvmContracts,
  getLatestArgonFinalizedExecutionHeader,
  Keyring,
  toFixedNumber,
} from '@argonprotocol/mainchain';
import {
  sudo,
  teardown,
  TestEthereum,
  waitForExecutionReceipt,
  waitForFinalizedBeaconExecutionAtOrAbove,
} from '@argonprotocol/testing';
import { createPublicClient, createWalletClient, defineChain, http, toHex, type Address, type Hex } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { DelegateSubmitLane, EthereumBeaconSyncService, EthereumGatewayProverService } from '@argonprotocol/apps-bot';
import BitcoinLocks from '../lib/BitcoinLocks.ts';
import { Config } from '../lib/Config.ts';
import { EthereumClient, loadEthereumChainConfig } from '../lib/EthereumClient.ts';
import { EthereumInboundTransferTracker } from '../lib/EthereumInboundTransferTracker.ts';
import { EthereumOutboundTransferTracker } from '../lib/EthereumOutboundTransferTracker.ts';
import { createCrosschainTransferProgress, OUTBOUND_TRANSFER_STEP_TITLES } from '../lib/CrosschainTransferProgress.ts';
import { GlobalCouncil } from '../lib/GlobalCouncil.ts';
import { DEFAULT_MASTER_XPUB_PATH, MyVault } from '../lib/MyVault.ts';
import { MintingAuthorities } from '../lib/MintingAuthorities.ts';
import { TransactionTracker } from '../lib/TransactionTracker.ts';
import { Vaults } from '../lib/Vaults.ts';
import { CrosschainInboundTransferStatus } from '../lib/db/CrosschainInboundTransfersTable.ts';
import { CrosschainOutboundTransferStatus } from '../lib/db/CrosschainOutboundTransfersTable.ts';
import { WalletType } from '../lib/Wallet.ts';
import { setMainchainClients } from '../stores/mainchain.ts';
import { createTestDb } from './helpers/db.ts';
import { createMockWalletKeys } from './helpers/wallet.ts';
import {
  loadDevEthereumActivationRepaymentPricing,
  syncEthereumGatewayActiveCouncilToArgon,
} from '../../e2e/devEthereumRuntimeSetup.ts';

vi.mock('../lib/Env.ts', async () => {
  const actual = await vi.importActual<typeof import('../lib/Env.ts')>('../lib/Env.ts');
  return {
    ...actual,
    SERVER_ENV_VARS: {
      ...actual.SERVER_ENV_VARS,
      ETHEREUM_FINALITY_MILLIS: '16000',
    },
  };
});

const TEST_ACCOUNT = {
  address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as Address,
  balance: '100ETH',
  privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex,
} as const;
const TEST_WALLET_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const VAULT_RULES = {
  ...(Config.getDefault('vaultingRules') as any),
  personalBtcPct: 50,
  securitizationRatio: 1,
  capitalForTreasuryPct: 50,
  capitalForSecuritizationPct: 50,
  baseMicrogonCommitment: 10_000_000n,
  baseMicronotCommitment: 0n,
  btcFlatFee: 100_000n,
  btcPctFee: 2.5,
  profitSharingPct: 5,
};
const skipE2E = Boolean(JSON.parse(process.env.SKIP_E2E ?? '0'));
type EthereumEndpoints = Awaited<ReturnType<TestEthereum['launch']>>;
type EthereumMintingGatewayFixture = Awaited<ReturnType<TestEthereum['deployMintingGatewayFixture']>>;
type TestEthereumPublicClient = ReturnType<typeof createEthereumPublicClient>;
type TestEthereumWalletClient = ReturnType<typeof createEthereumWalletClient>;

describe.skipIf(skipE2E || !TestEthereum.isInstalled())('EthereumCrosschain integration', { timeout: 240e3 }, () => {
  let ethereum: TestEthereum;
  let network: StartedArgonTestNetwork;
  let mainchainClients: MainchainClients;
  const walletKeys = createMockWalletKeys(TEST_WALLET_MNEMONIC);
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let client: Awaited<ReturnType<MainchainClients['get']>>;
  let currency: Currency;
  let miningFrames: MiningFrames;
  let transactionTracker: TransactionTracker;
  let config: Config;
  let submitLane: DelegateSubmitLane;
  let beaconSyncService: EthereumBeaconSyncService;
  let gatewayProverService: EthereumGatewayProverService;
  let ethereumClient: EthereumClient;
  let tracker: EthereumInboundTransferTracker;
  let outboundTracker: EthereumOutboundTransferTracker;
  let bitcoinLocks: BitcoinLocks;
  let globalCouncil: GlobalCouncil;
  let mintingAuthorities: MintingAuthorities;
  let vaults: Vaults;
  let myVault: MyVault;
  let delegateKeypair: Awaited<ReturnType<typeof walletKeys.getVaultDelegateKeypair>>;
  let publicClient: TestEthereumPublicClient;
  let deployerClient: Pick<TestEthereumWalletClient, 'writeContract'>;
  let chain: ReturnType<typeof defineChain>;
  let endpoints: EthereumEndpoints;
  let gatewayAddress: Address;
  let argonTokenAddress: Address;
  let argonotTokenAddress: Address;
  const deployer: PrivateKeyAccount = privateKeyToAccount(TEST_ACCOUNT.privateKey);
  let didQueueMintingAuthorityActivation = false;
  let didActivateMintingAuthority = false;
  let didTransferArgonToEthereum = false;

  beforeAll(async () => {
    network = await startArgonTestNetwork(Path.basename(import.meta.filename), {
      profiles: ['bob'],
      chainStartTimeoutMs: 120_000,
      chainStartPollMs: 250,
    });
    mainchainClients = new MainchainClients(network.archiveUrl, () => false);
    setMainchainClients(mainchainClients);
    NetworkConfig.setNetwork('dev-docker');

    const [councilSignerAddress] = await walletKeys.getEthereumAddresses([walletKeys.councilSignerEthereumHdPath]);
    ethereum = new TestEthereum();
    endpoints = await ethereum.launch({
      preset: 'minimal',
      secondsPerSlot: 1,
      waitForFinalization: false,
      prefundedAccounts: {
        [TEST_ACCOUNT.address]: {
          balance: TEST_ACCOUNT.balance,
        },
        // The app wallet needs ETH for gateway tx gas, even when token balances come from Argon.
        [walletKeys.ethereumAddress]: {
          balance: TEST_ACCOUNT.balance,
        },
        [councilSignerAddress as Address]: {
          balance: TEST_ACCOUNT.balance,
        },
      },
    });
    const fixture: EthereumMintingGatewayFixture = await ethereum.deployMintingGatewayFixture({
      deployerPrivateKey: TEST_ACCOUNT.privateKey,
    });
    const chainId = Number.parseInt(endpoints.chainId, 16);
    chain = defineChain({
      id: chainId,
      name: 'argon-test-ethereum',
      nativeCurrency: {
        name: 'Ether',
        symbol: 'ETH',
        decimals: 18,
      },
      rpcUrls: {
        default: {
          http: [endpoints.executionRpcUrl],
        },
      },
    });
    publicClient = createEthereumPublicClient(chain, endpoints.executionRpcUrl);
    deployerClient = createEthereumWalletClient(deployer, chain, endpoints.executionRpcUrl);
    gatewayAddress = fixture.gatewayAddress;
    argonTokenAddress = fixture.argonTokenAddress;
    argonotTokenAddress = fixture.argonotTokenAddress;
    NetworkConfig.setRuntimeOverride('dev-docker', {
      ethereumNetwork: {
        executionRpcUrl: endpoints.executionRpcUrl,
        finalityBlocks: 16,
      },
    });

    const mainchainClient = await mainchainClients.get(false);
    await sudoSubmitAndFinalize(
      mainchainClient,
      mainchainClient.tx.crosschainTransfer.setChainConfig('Ethereum', {
        Evm: {
          chainId,
          gateway: fixture.gatewayAddress,
          argonToken: fixture.argonTokenAddress,
          argonotToken: fixture.argonotTokenAddress,
        },
      }),
    );
    await submitAndFinalize(
      mainchainClient,
      mainchainClient.tx.balances.transferKeepAlive(
        (await walletKeys.getVaultDelegateKeypair()).address,
        minimumVaultDelegateBalance * 2n,
      ),
      sudo(),
    );
    await EthereumBeaconSyncService.ensureBootstrapped(mainchainClient, endpoints.beaconApiUrl, sudo(), {
      minimumFinalizedSlot: 64n,
    });

    db = await createTestDb();
    client = await mainchainClients.get(false);

    await sudoFundWallet({
      address: walletKeys.vaultingAddress,
      microgons: 100_000_000n,
      micronots: 10_000_000n,
      archiveUrl: network.archiveUrl,
    });
    await sudoFundWallet({
      address: walletKeys.investmentAddress,
      microgons: client.consts.balances.existentialDeposit.toBigInt(),
      micronots: 0n,
      archiveUrl: network.archiveUrl,
    });

    const currentTick = await client.query.ticks.currentTick();
    await submitAndFinalize(
      client,
      client.tx.priceIndex.submit({
        btcUsdPrice: toFixedNumber(60_000, 18),
        argonUsdPrice: toFixedNumber(1, 18),
        argonotUsdPrice: toFixedNumber(1, 18),
        argonUsdTargetPrice: toFixedNumber(1, 18),
        argonTimeWeightedAverageLiquidity: toFixedNumber(1_000_000, 18),
        tick: currentTick.toBigInt(),
      }),
      new Keyring({ type: 'sr25519' }).addFromUri('//Eve//oracle'),
    );

    currency = new Currency(mainchainClients);
    await currency.fetchMainchainRates();

    miningFrames = new MiningFrames(mainchainClients);
    transactionTracker = new TransactionTracker(Promise.resolve(db), miningFrames.blockWatch);
    delegateKeypair = await walletKeys.getVaultDelegateKeypair();
    submitLane = new DelegateSubmitLane(delegateKeypair);
    submitLane.client = client;

    beaconSyncService = new EthereumBeaconSyncService(client, {
      beaconApiUrl: ethereum.beaconApiUrl,
      pollMs: 1_000,
      submitLane,
    });
    gatewayProverService = new EthereumGatewayProverService(submitLane, {
      backgroundSweepMs: 1_000,
    });
    ethereumClient = new EthereumClient(walletKeys, ethereum.executionRpcUrl!);
    tracker = new EthereumInboundTransferTracker(
      Promise.resolve(db),
      transactionTracker,
      walletKeys,
      ethereumClient,
      {
        getEthereumRelayStatus: () => gatewayProverService.getRelayStatus(),
        requestEthereumGatewayCatchUp: request => gatewayProverService.runToCheckpoint(request),
      },
      {
        operatorHost: undefined,
        requestEthereumGatewayCatchUp: async () => ({ outcome: 'Noop' }),
      },
    );
    bitcoinLocks = new BitcoinLocks(
      Promise.resolve(db),
      walletKeys,
      miningFrames.blockWatch,
      currency,
      transactionTracker,
    );
    globalCouncil = new GlobalCouncil(Promise.resolve(db), walletKeys, miningFrames);
    mintingAuthorities = new MintingAuthorities(Promise.resolve(db), walletKeys, miningFrames, transactionTracker);
    outboundTracker = new EthereumOutboundTransferTracker(
      Promise.resolve(db),
      transactionTracker,
      miningFrames.blockWatch,
      walletKeys,
      ethereumClient,
    );
    vaults = new Vaults('dev-docker', currency, miningFrames);
    myVault = new MyVault(
      Promise.resolve(db),
      vaults,
      walletKeys,
      transactionTracker,
      bitcoinLocks,
      miningFrames,
      globalCouncil,
      mintingAuthorities,
    );
    Object.assign(vaults, {
      load: async () => {},
      updateRevenue: async () => ({}),
    });

    config = new Config(Promise.resolve(db), walletKeys);
    await config.load();
    const chainConfig = await loadEthereumChainConfig();
    if (!chainConfig) {
      throw new Error('Ethereum transfer gateway is not configured on this network.');
    }
    await walletKeys.configureEthereumSignerPolicy({
      chainId: chainConfig.chainId,
      gatewayAddress: chainConfig.gatewayAddress,
      tokenAddresses: [chainConfig.argonTokenAddress, chainConfig.argonotTokenAddress],
    });
    await myVault.load();
  }, 420_000);

  afterAll(async () => {
    await gatewayProverService?.shutdown().catch(() => undefined);
    await beaconSyncService?.shutdown().catch(() => undefined);
    myVault?.unsubscribe();
    await bitcoinLocks?.shutdown().catch(() => undefined);
    await miningFrames?.stop().catch(() => undefined);
    NetworkConfig.clearRuntimeOverride('dev-docker');
    await mainchainClients?.disconnect();
    await teardown();
  });

  it.sequential(
    'creates the vault and queues minting authority activation',
    async () => {
      const vaultCreation = await myVault.createNew({
        masterXpubPath: DEFAULT_MASTER_XPUB_PATH,
        rules: VAULT_RULES,
        config,
      });
      await vaultCreation.txResult.waitForFinalizedBlock;
      await vaultCreation.waitForPostProcessing;

      const finalizedClient = await getFinalizedClient(client);
      const [councilSignerAddress, mintingAuthoritySigner] = await walletKeys.getEthereumAddresses([
        walletKeys.councilSignerEthereumHdPath,
        walletKeys.getMintingAuthorityEthereumHdPath(0),
      ]);
      const councilSigner = await finalizedClient.query.crosschainTransfer
        .councilSignerByDestinationChainAndAccountId('Ethereum', walletKeys.vaultingAddress)
        .then(x => (x.isSome ? x.unwrap().toHex().toLowerCase() : undefined));
      expect(councilSigner).toBe(councilSignerAddress.toLowerCase());
      expect(councilSignerAddress.toLowerCase()).not.toBe(walletKeys.ethereumAddress.toLowerCase());
      expect(mintingAuthoritySigner.toLowerCase()).not.toBe(walletKeys.ethereumAddress.toLowerCase());
      expect(mintingAuthoritySigner.toLowerCase()).not.toBe(councilSignerAddress.toLowerCase());

      await submitAndFinalize(
        client,
        client.tx.vaults.setCommittedArgonots(1_000_000n),
        await walletKeys.getVaultingKeypair(),
        { useLatestNonce: true },
      );
      await sudoSubmitAndFinalize(
        client,
        client.tx.crosschainTransfer.setMintingAuthorityActivationRepaymentPricing(
          'Ethereum',
          await loadDevEthereumActivationRepaymentPricing({
            finalizedClient,
            executionRpcUrl: endpoints.executionRpcUrl,
          }),
        ),
      );
      await sudoSubmitAndFinalize(
        client,
        client.tx.crosschainTransfer.forceSetGlobalIssuanceCouncil('Ethereum', 0, [walletKeys.vaultingAddress]),
      );

      const updatedFinalizedClient = await getFinalizedClient(client);
      const syncResult = await syncEthereumGatewayActiveCouncilToArgon({
        finalizedClient: updatedFinalizedClient,
        gatewayAddress,
        publicClient,
        sendCurrentCouncil: async (currentCouncil, nextMicrogonsPerArgonot) => {
          return await deployerClient.writeContract({
            account: deployer,
            chain,
            address: gatewayAddress,
            abi: EvmContracts.mintingGatewayArtifact.abi,
            functionName: 'forceUpdateActiveCouncil',
            args: [currentCouncil, nextMicrogonsPerArgonot],
          });
        },
      });
      expect(syncResult.status).toBe('synced');
      await sudoSubmitAndFinalize(client, client.tx.crosschainTransfer.setMinimumMintingAuthorityValue('Ethereum', 1));

      const registerTx = await mintingAuthorities.register({
        microgonCollateral: 0n,
        micronotCollateral: 1_000_000n,
        councilSigner: councilSignerAddress,
      });
      await registerTx.txResult.waitForFinalizedBlock;
      await registerTx.waitForPostProcessing;

      await globalCouncil.refresh(await getFinalizedClient(client));
      expect(mintingAuthorities.data.authorities).toHaveLength(1);
      expect(mintingAuthorities.data.authorities[0]?.isPendingActivation).toBe(true);
      expect(globalCouncil.data.pendingApprovals).toHaveLength(1);

      didQueueMintingAuthorityActivation = true;
    },
    420_000,
  );

  it.sequential(
    'approves the activation and proves the authority active',
    async () => {
      if (!didQueueMintingAuthorityActivation) {
        throw new Error('Run the whole EthereumCrosschain integration suite. Phase 1 must complete before phase 2.');
      }

      const collectTx = await myVault.collect({ moveTo: MoveTo.VaultingHold });
      await collectTx.txResult.waitForFinalizedBlock;
      await collectTx.waitForPostProcessing;
      expect(collectTx.tx.extrinsicType).toBe('CrosschainTransferApproveCouncil');

      const relayApprovalsReceipt = await globalCouncil.relayApprovedGatewayUpdates();
      expect(relayApprovalsReceipt).toBeDefined();

      const relayedApprovalsNonce = (await publicClient.readContract({
        address: gatewayAddress,
        abi: EvmContracts.mintingGatewayArtifact.abi,
        functionName: 'argonApprovalsNonce',
      })) as bigint;
      expect(relayedApprovalsNonce).toBe(1n);

      const latestExecutionBlockNumber = (await publicClient.getBlock()).number;
      expect(latestExecutionBlockNumber).toBeDefined();

      await waitForFinalizedBeaconExecutionAtOrAbove(ethereum, latestExecutionBlockNumber, {
        minimumFinalizedSlot: 64n,
      });
      await vi.waitFor(async () => {
        await beaconSyncService.runOnce();
        const anchor = await getLatestArgonFinalizedExecutionHeader(client);
        expect(anchor.blockNumber).toBeGreaterThanOrEqual(latestExecutionBlockNumber);
      }, 120_000);

      const activationProofPayload = await buildGatewayActivityProofPayload(client, {
        executionRpcUrl: ethereum.executionRpcUrl!,
        gatewayAddress,
        throughExecutionBlockNumber: latestExecutionBlockNumber,
      });
      expect(activationProofPayload).toBeDefined();
      expect(activationProofPayload!.gatewayActivityNonceRange).toEqual({ start: 1n, end: 1n });
      expect(activationProofPayload!.activities).toHaveLength(1);
      expect(activationProofPayload!.activities[0]?.kind).toBe('MintingAuthorityActivated');

      await vi.waitFor(async () => {
        await beaconSyncService.runOnce();
        const response = await gatewayProverService.runToCheckpoint({
          sourceChain: 'Ethereum',
          throughGatewayActivityNonce: 1n,
        });
        if (response.outcome === 'Rejected') {
          throw new Error(response.reason);
        }

        await mintingAuthorities.refresh(await getFinalizedClient(client));
        expect(mintingAuthorities.data.authorities[0]?.isActive).toBe(true);
      }, 120_000);

      didActivateMintingAuthority = true;
    },
    420_000,
  );

  it.sequential(
    'transfers Argon to Ethereum, authorizes it, and proves finalization back',
    async () => {
      if (!didActivateMintingAuthority) {
        throw new Error('Run the whole EthereumCrosschain integration suite. Phase 2 must complete before phase 3.');
      }

      await submitAndFinalize(
        client,
        client.tx.crosschainTransfer.transferOut('Ethereum', 'Argon', walletKeys.ethereumAddress, 10_000n),
        await walletKeys.getVaultingKeypair(),
        { useLatestNonce: true },
      );

      await mintingAuthorities.refresh(await getFinalizedClient(client));
      const pendingMintingAuthorization = mintingAuthorities.data.pendingMintingAuthorizations[0];
      expect(pendingMintingAuthorization).toBeDefined();

      const startingEthereumBalance = BigInt(
        (await publicClient.readContract({
          address: argonTokenAddress,
          abi: EvmContracts.argonTokenArtifact.abi,
          functionName: 'balanceOf',
          args: [walletKeys.ethereumAddress as Address],
        })) as bigint,
      );

      const authorizeTx = await mintingAuthorities.authorize();
      await authorizeTx.txResult.waitForFinalizedBlock;
      await authorizeTx.waitForPostProcessing;
      const authorizedArgonBlockId = authorizeTx.tx.blockHash ?? (await authorizeTx.txResult.waitForInFirstBlock);
      const mintingAuthorizedArgonBlockHash =
        typeof authorizedArgonBlockId === 'string' ? authorizedArgonBlockId : toHex(authorizedArgonBlockId);
      const mintingAuthorizedArgonBlockNumber = await client.rpc.chain
        .getHeader(mintingAuthorizedArgonBlockHash)
        .then(x => x.number.toNumber());

      const transferId = pendingMintingAuthorization.transferId;
      expect(pendingMintingAuthorization.moveToken).toBe(MoveToken.ARGN);

      const authorizationSignature = await walletKeys.signEthereumPersonalMessage(
        pendingMintingAuthorization.authorizationHash,
        walletKeys.getMintingAuthorityEthereumHdPath(pendingMintingAuthorization.authorityIndex),
      );
      const outboundTransferId = 'outbound-minting-authorized-transfer';
      await db.crosschainOutboundTransfersTable.upsert({
        id: outboundTransferId,
        transferId,
        destinationChain: 'Ethereum',
        token: pendingMintingAuthorization.moveToken,
        amount: pendingMintingAuthorization.finalizeRequest.amount,
        argonSourceAddress: pendingMintingAuthorization.finalizeRequest.argonAccountId,
        destinationAddress: pendingMintingAuthorization.finalizeRequest.recipient,
        mintingAuthorizedMicrogons: pendingMintingAuthorization.microgonCollateral,
        mintingAuthorizedMicronots: pendingMintingAuthorization.micronotCollateral,
        mintingAuthorizedArgonBlockNumber,
        mintingAuthorizedArgonBlockHash,
        finalizeRequestJson: pendingMintingAuthorization.finalizeRequest,
        finalizeProofJson: {
          authorizations: [
            {
              microgonCollateral: pendingMintingAuthorization.microgonCollateral,
              micronotCollateral: pendingMintingAuthorization.micronotCollateral,
              signature: authorizationSignature,
            },
          ],
        },
        progressJson: createCrosschainTransferProgress(OUTBOUND_TRANSFER_STEP_TITLES),
        status: CrosschainOutboundTransferStatus.MintingAuthorized,
      });
      await outboundTracker.load();

      await vi.waitFor(async () => {
        const activeTransfer = outboundTracker.getTransfer(outboundTransferId);
        if (activeTransfer?.transferState.error) {
          throw new Error(activeTransfer.transferState.error);
        }

        const persisted = await db.crosschainOutboundTransfersTable.getByTransferId(transferId);
        expect(persisted).toMatchObject({
          transferId,
          destinationChain: 'Ethereum',
          mintingAuthorizedMicrogons: pendingMintingAuthorization.microgonCollateral,
          mintingAuthorizedMicronots: pendingMintingAuthorization.micronotCollateral,
          mintingAuthorizedArgonBlockNumber,
          mintingAuthorizedArgonBlockHash,
          status: CrosschainOutboundTransferStatus.TransferFinalizedOnTargetChain,
        });
        expect(activeTransfer?.transferState.progress.overallProgressPct).toBe(100);
        expect(activeTransfer?.transferState.isSubmitting).toBe(false);
      }, 120_000);

      const finalizedOutbound = await db.crosschainOutboundTransfersTable.getByTransferId(transferId);
      expect(finalizedOutbound?.targetBlockNumber).toBeDefined();
      expect(finalizedOutbound?.targetBlockNumber).not.toBeNull();
      expect(finalizedOutbound?.gatewayActivityNonce).toBeDefined();
      expect(finalizedOutbound?.gatewayActivityNonce).not.toBeNull();

      const finalizeReceipt = await waitForMinedExecutionReceipt(ethereum, finalizedOutbound!.targetTxHash!);
      const finalizedTransferId = EvmContracts.hashMintingGatewayTransferOutOfArgonRequest(
        pendingMintingAuthorization.finalizeRequest,
      );
      const [isFinalizedTransferOut, argonBalance, argonotBalance] = await Promise.all([
        publicClient.readContract({
          address: gatewayAddress,
          abi: EvmContracts.mintingGatewayAbi,
          functionName: 'finalizedTransferOutOfArgonIds',
          args: [finalizedTransferId],
        }),
        publicClient.readContract({
          address: argonTokenAddress,
          abi: EvmContracts.argonTokenArtifact.abi,
          functionName: 'balanceOf',
          args: [walletKeys.ethereumAddress as Address],
        }),
        publicClient.readContract({
          address: argonotTokenAddress,
          abi: EvmContracts.argonotTokenArtifact.abi,
          functionName: 'balanceOf',
          args: [walletKeys.ethereumAddress as Address],
        }),
      ]);
      const finalArgonBalance = BigInt(argonBalance as bigint);
      const finalArgonotBalance = BigInt(argonotBalance as bigint);
      const expectedFinalArgonBalance =
        startingEthereumBalance + 10_000n * EvmContracts.MINTING_GATEWAY_RUNTIME_TO_ERC20_SCALE;
      if (finalArgonBalance !== expectedFinalArgonBalance) {
        throw new Error(
          JSON.stringify({
            request: pendingMintingAuthorization.finalizeRequest,
            targetTxHash: finalizedOutbound!.targetTxHash,
            receiptStatus: finalizeReceipt.status,
            isFinalizedTransferOut,
            startingEthereumBalance: startingEthereumBalance.toString(),
            finalArgonBalance: finalArgonBalance.toString(),
            finalArgonotBalance: finalArgonotBalance.toString(),
            expectedFinalArgonBalance: expectedFinalArgonBalance.toString(),
            logs: finalizeReceipt.logs.map(log => ({
              address: log.address,
              topic0: log.topics[0],
            })),
          }),
        );
      }
      expect(finalArgonBalance).toBe(expectedFinalArgonBalance);

      await waitForFinalizedBeaconExecutionAtOrAbove(ethereum, BigInt(finalizedOutbound!.targetBlockNumber!), {
        minimumFinalizedSlot: 64n,
      });
      await vi.waitFor(async () => {
        await beaconSyncService.runOnce();
        const anchor = await getLatestArgonFinalizedExecutionHeader(client);
        expect(anchor.blockNumber).toBeGreaterThanOrEqual(BigInt(finalizedOutbound!.targetBlockNumber!));
      }, 120_000);

      await vi.waitFor(async () => {
        await beaconSyncService.runOnce();
        const response = await gatewayProverService.runToCheckpoint({
          sourceChain: 'Ethereum',
          throughGatewayActivityNonce: finalizedOutbound!.gatewayActivityNonce!,
        });
        if (response.outcome === 'Rejected') {
          throw new Error(response.reason);
        }

        const transferOption = await getFinalizedClient(client).then(nextClient =>
          nextClient.query.crosschainTransfer.transferOutById(transferId),
        );
        expect(transferOption.isNone).toBe(true);
      }, 120_000);

      await mintingAuthorities.refresh(await getFinalizedClient(client));
      const authority = mintingAuthorities.data.authorities[0];
      expect(authority).toBeDefined();
      expect(mintingAuthorities.data.pendingMintingAuthorizations).toHaveLength(0);
      expect(authority.pendingReservedMicrogonCollateral).toBe(0n);
      expect(authority.pendingReservedMicronotCollateral).toBe(0n);
      expect(authority.gatewayRemainingMicronotCollateral).toBe(990_000n);
      expect(authority.gatewayRemainingMicronotCollateral - authority.pendingReservedMicronotCollateral).toBe(990_000n);

      expect(outboundTracker.getTransfer(outboundTransferId)?.persistedRecord?.transferId).toBe(transferId);
      didTransferArgonToEthereum = true;
    },
    420_000,
  );

  it.sequential(
    'transfers from Ethereum back to Argon and finalizes it',
    async () => {
      if (!didTransferArgonToEthereum) {
        throw new Error('Run the whole EthereumCrosschain integration suite. Phase 3 must complete before phase 4.');
      }

      const amountBaseUnits = 250n * EvmContracts.MINTING_GATEWAY_RUNTIME_TO_ERC20_SCALE;
      const startingBalance = await submitLane.client.query.system
        .account(walletKeys.investmentAddress)
        .then(x => x.data.free.toBigInt());
      const transfer = await tracker.startMove({
        moveToken: MoveToken.ARGN,
        amountBaseUnits,
        targetWalletType: WalletType.investment,
      });
      expect(transfer).toBeDefined();

      await vi.waitFor(async () => {
        const activeTransfer = tracker.getTransfer(transfer!.id);
        if (activeTransfer?.transferState.error) {
          throw new Error(activeTransfer.transferState.error);
        }

        const persisted = await db.crosschainInboundTransfersTable.get(transfer!.id);
        if (persisted?.gatewayActivityNonce) {
          await beaconSyncService.runOnce();
          const response = await gatewayProverService.runToCheckpoint({
            sourceChain: 'Ethereum',
            throughGatewayActivityNonce: persisted.gatewayActivityNonce,
          });
          if (response.outcome === 'Rejected') {
            throw new Error(response.reason);
          }
        }

        expect(persisted).toMatchObject({
          id: transfer!.id,
          token: MoveToken.ARGN,
          argonDestinationAddress: walletKeys.investmentAddress,
          status: CrosschainInboundTransferStatus.ArgonFinalized,
        });
        expect(persisted?.sourceTxHash).toBeTruthy();
        expect(persisted?.sourceBlockNumber).toBeGreaterThan(0);
        expect(persisted?.gatewayActivityNonce).toBe(3n);
      }, 120_000);

      await vi.waitFor(async () => {
        const balance = await submitLane.client.query.system
          .account(walletKeys.investmentAddress)
          .then(x => x.data.free.toBigInt());
        expect(balance).toBe(startingBalance + 250n);
      }, 30_000);

      const transferState = tracker.getTransferStateForToken(MoveToken.ARGN);
      expect(transferState.isSubmitting).toBe(false);
      expect(transferState.hasPersistedTransfer).toBe(false);
      expect(transferState.targetWalletType).toBe(WalletType.investment);
      expect(transferState.progress.overallProgressPct).toBe(100);
      expect(transferState.error).toBe('');
    },
    420_000,
  );
});

async function waitForMinedExecutionReceipt(ethereum: TestEthereum, hash: Hex) {
  while (true) {
    const receipt = await waitForExecutionReceipt(ethereum, hash);
    if (receipt.blockNumber !== null) {
      return receipt;
    }

    await new Promise(resolve => setTimeout(resolve, 500));
  }
}

function createEthereumPublicClient(chain: ReturnType<typeof defineChain>, executionRpcUrl: string) {
  return createPublicClient({
    chain,
    transport: http(executionRpcUrl),
  });
}

function createEthereumWalletClient(
  account: PrivateKeyAccount,
  chain: ReturnType<typeof defineChain>,
  executionRpcUrl: string,
) {
  return createWalletClient({
    account,
    chain,
    transport: http(executionRpcUrl),
  });
}
