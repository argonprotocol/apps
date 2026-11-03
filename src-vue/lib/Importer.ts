import { Config } from './Config';
import Restarter from './Restarter';
import { Db } from './Db';
import { invokeWithTimeout } from './tauriApi';
import { type ITryServerData, SSH } from './SSH';
import {
  ConfigSchema,
  type IConfig,
  type IConfigServerDetails,
  MiningSetupStatus,
  OnboardingSetupStatus,
  VaultingSetupStatus,
} from '../interfaces/IConfig';
import { IS_LOCAL_BUILD, NETWORK_NAME } from './Env.ts';
import { hasArgonWalletValue } from './WalletForArgon.ts';
import { WalletKeys } from './WalletKeys.ts';
import { WalletSecrets } from './WalletSecrets.ts';
import { EncryptionSecret } from './EncryptionSecret.ts';
import { walletFileSchema } from '../interfaces/IWalletFile.ts';
import { z } from 'zod';
import { isAccountInGlobalIssuanceCouncil } from './CrosschainTransferView.ts';
import { findOwnedEthereumMintingAuthoritySigners } from './MintingAuthorities.ts';
import { readArgonWalletBalanceValues } from './WalletsForArgon.ts';
import { getWalletsForArgon } from '../stores/wallets.ts';
import { getBlockWatch, getFinalizedClient, getMainchainClient } from '../stores/mainchain.ts';
import { AccountActivityKind, getVaultByOperator, Mining } from '@argonprotocol/apps-core';
import {
  getOnboardingSetupStatus,
  getOperationalChainProgressFromAccount,
  getOperationalProfileName,
} from './OperationalAccount.ts';
import { findAddressActivity } from './IndexerClient.ts';

type IRecoveredAccountState = Pick<
  IConfig,
  | 'walletAccountsHadPreviousLife'
  | 'hasExtensionTreasury'
  | 'hasExtensionOperations'
  | 'hasActivatedCrosschain'
  | 'miningSetupStatus'
  | 'vaultingSetupStatus'
  | 'onboardingSetupStatus'
  | 'hasMiningBids'
  | 'hasMiningSeats'
> & { isUpgradedToOperations: boolean };

export default class Importer {
  private readonly config: Config;
  private readonly walletKeys: WalletKeys;
  private readonly dbPromise: Promise<Db>;

  public failureToReadData: boolean;

  constructor(config: Config, walletKeys: WalletKeys, dbPromise: Promise<Db>) {
    this.config = config;
    this.walletKeys = walletKeys;
    this.dbPromise = dbPromise;

    this.failureToReadData = false;
  }

  public async importFromMnemonic(mnemonic: string, { removeMnemonicFiles = false } = {}): Promise<boolean> {
    if (await this.walletKeys.matchesMnemonic(mnemonic)) return false;

    const importWalletKeys = WalletKeys.fromMnemonic(mnemonic);
    const { isUpgradedToOperations, ...recoveredState } = await this.inspectAccountState(importWalletKeys);

    if (NETWORK_NAME === 'mainnet' && !IS_LOCAL_BUILD && !recoveredState.walletAccountsHadPreviousLife) {
      throw new Error('No existing wallet value was found for that mnemonic on this network.');
    }

    const mnemonicsToRemove: string[] = [];
    if (removeMnemonicFiles) {
      mnemonicsToRemove.push(mnemonic);
      if (this.walletKeys.canSign) mnemonicsToRemove.push(await this.walletKeys.exposeMasterMnemonic());
    }

    await this.shutdownBackgroundSync();
    await invokeWithTimeout('backup_current_instance_database_for_import', {}, 30e3);
    const importedConfig: Partial<IConfig> = {
      showWelcomeOverlay: false,
      ...recoveredState,
      walletPreviousLifeRecovered: !recoveredState.walletAccountsHadPreviousLife,
      certificationDetails: {
        hasSavedMnemonic: true,
        dismissedWelcomeToOperationsOverlay: isUpgradedToOperations,
        dismissedOperationsActivatedOverlay: isUpgradedToOperations,
      },
    };
    const prepared = await WalletSecrets.prepareWallet(
      mnemonic,
      WalletKeys.deriveIdentity(mnemonic),
      mnemonicsToRemove,
    );
    try {
      await invokeWithTimeout(
        'write_wallet_file',
        {
          filename: 'wallet.tmp.json',
          contents: JSON.stringify({ ...prepared, config: importedConfig }),
          createNew: true,
        },
        30e3,
      );
      await Importer.finishPendingImport({ dbPromise: this.dbPromise, config: this.config });
    } finally {
      // Even an ambiguous staging error must not leave the old session running over a pending import.
      new Restarter(this.dbPromise, this.config).restart();
    }
    return true;
  }

  public static async finishPendingImport(storage?: { dbPromise: Promise<Db>; config: Config }): Promise<boolean> {
    const raw = await invokeWithTimeout<string | null>('read_wallet_file', { filename: 'wallet.tmp.json' }, 30e3);
    if (raw === null) {
      // The atomic writer may have stopped before publishing intent; no key or database write has begun.
      await invokeWithTimeout('delete_wallet_file', { filename: 'wallet.tmp.json.tmp' }, 30e3);
      return false;
    }
    const pending = pendingImportSchema.parse(JSON.parse(raw));

    if (pending.keychainValue !== undefined) {
      await new EncryptionSecret().write(pending.keychainValue);
      delete pending.keychainValue;
      await invokeWithTimeout(
        'write_wallet_file',
        {
          filename: 'wallet.tmp.json',
          contents: JSON.stringify(pending),
          createNew: false,
        },
        30e3,
      );
    }
    if (!storage) {
      // A UI reload does not rerun native startup; repair an interrupted schema before Db.load reads table state.
      await invokeWithTimeout('run_db_migrations', {}, 30e3);
      const dbPromise = Db.load();
      storage = { dbPromise, config: new Config(dbPromise) };
    }
    const { dbPromise, config } = storage;
    await new Restarter(dbPromise, config).deleteAndCreateLocalDatabase();
    const db = await dbPromise;
    await db.reconnect();
    await config.restoreToConnection(db.sql, pending.config);
    await invokeWithTimeout(
      'write_wallet_file',
      {
        filename: 'wallet.json',
        contents: JSON.stringify(pending.wallet),
        createNew: false,
      },
      30e3,
    );
    if (pending.encryptedMnemonicCleanup.length) {
      // Prove the committed key opens the incoming wallet before removing confirmed backup copies.
      const [, ...mnemonicsToRemove] = await new EncryptionSecret().decrypt([
        pending.wallet.encryptedMnemonic,
        ...pending.encryptedMnemonicCleanup,
      ]);
      for (const mnemonic of new Set(mnemonicsToRemove)) await WalletSecrets.cleanupMnemonicFiles(mnemonic);
    }
    await invokeWithTimeout('delete_wallet_file', { filename: 'wallet.tmp.json' }, 30e3);
    return true;
  }

  public async recoverCurrentAccountState(): Promise<void> {
    await this.config.isLoadedPromise;
    const recovered = await this.inspectAccountState(this.walletKeys);

    if (recovered.walletAccountsHadPreviousLife) this.config.walletAccountsHadPreviousLife = true;
    if (recovered.hasExtensionTreasury) this.config.hasExtensionTreasury = true;
    if (recovered.hasExtensionOperations) this.config.hasExtensionOperations = true;
    if (recovered.hasActivatedCrosschain) this.config.hasActivatedCrosschain = true;
    if (recovered.hasMiningBids) this.config.hasMiningBids = true;
    if (recovered.hasMiningSeats) this.config.hasMiningSeats = true;

    if (
      recovered.miningSetupStatus === MiningSetupStatus.Finished ||
      this.config.miningSetupStatus === MiningSetupStatus.None
    ) {
      this.config.miningSetupStatus = recovered.miningSetupStatus;
    }
    if (
      recovered.vaultingSetupStatus === VaultingSetupStatus.Finished ||
      this.config.vaultingSetupStatus === VaultingSetupStatus.None
    ) {
      this.config.vaultingSetupStatus = recovered.vaultingSetupStatus;
    }
    if (
      recovered.onboardingSetupStatus === OnboardingSetupStatus.Finished ||
      this.config.onboardingSetupStatus === OnboardingSetupStatus.None
    ) {
      this.config.onboardingSetupStatus = recovered.onboardingSetupStatus;
    }

    await this.config.save();
  }

  public async importFromServer(ipAddress: string) {
    const serverDetails: IConfigServerDetails = {
      ipAddress,
      sshUser: this.config.serverDetails.sshUser,
      type: this.config.serverDetails.type,
      workDir: this.config.serverDetails.workDir,
      sshPort: this.config.serverDetails.sshPort,
    };

    const serverData = await this.fetchServerData(serverDetails);

    if (!serverData) {
      throw new Error('Failed to fetch server data');
    } else if (serverData.walletAddress !== this.walletKeys.miningBotAddress) {
      throw new Error('Wallet address mismatch');
    }

    // TODO: We might want to return this data to the caller (BotCreatePanel) so they can hold it in case the user
    // wants to click the Cancel button.
    const hasMiningSeats = this.config.hasMiningSeats || !!serverData.hasMiningSeats;
    const hasMiningBids = this.config.hasMiningBids || !!serverData.hasMiningBids || hasMiningSeats;
    this.config.hasMiningSeats = hasMiningSeats;
    this.config.hasMiningBids = hasMiningBids;

    if (serverData.biddingRules) {
      this.config.biddingRules = serverData.biddingRules;
    }
    const hasCompletedMiningSetup =
      this.config.miningSetupStatus === MiningSetupStatus.Finished || hasMiningBids || !!serverData.biddingRules;
    this.config.miningSetupStatus = hasCompletedMiningSetup ? MiningSetupStatus.Finished : MiningSetupStatus.Checklist;
    this.config.oldestFrameIdToSync = serverData.oldestFrameIdToSync ?? this.config.oldestFrameIdToSync;
    this.config.ethereumBeaconApiUrl = serverData.ethereumBeaconApiUrl;
    this.config.ethereumExecutionRpcUrl = serverData.ethereumExecutionRpcUrl;
    this.config.serverDetails = { ...this.config.serverDetails, ipAddress };
    this.config.isServerInstalled = true;
    this.config.isServerInstalling = false;
    this.config.hasExtensionTreasury = true;
    this.config.hasExtensionOperations = true;
    if (serverData.biddingRules) {
      await this.config.saveBiddingRules();
    } else {
      await this.config.save();
    }
  }

  private async inspectAccountState(walletKeys: WalletKeys): Promise<IRecoveredAccountState> {
    const mainchainClient = await getMainchainClient(false);
    const finalizedApi = await getFinalizedClient(mainchainClient);
    const addresses = [
      walletKeys.legacyMiningHoldAddress,
      walletKeys.miningBotAddress,
      walletKeys.vaultingAddress,
      walletKeys.operationalAddress,
    ].filter(Boolean);
    const crosschainTransfer = finalizedApi.query.crosschainTransfer;
    const activeCouncilPromise = crosschainTransfer
      ?.activeGlobalIssuanceCouncilByDestinationChain?.('Ethereum')
      ?.then(async councilHash => {
        if (!councilHash) return;
        return (await crosschainTransfer.globalIssuanceCouncilByHash(councilHash)) ?? undefined;
      });
    const ownedMintingAuthoritySignersPromise = findOwnedEthereumMintingAuthoritySigners(finalizedApi, walletKeys);
    const [balances, operationalAccount, ownedVault, activeCouncil, ownedMintingAuthoritySigners] = await Promise.all([
      readArgonWalletBalanceValues(finalizedApi, addresses),
      finalizedApi.query.operationalAccounts.operationalAccounts(walletKeys.operationalAddress),
      getVaultByOperator({ client: finalizedApi, operatorAddress: walletKeys.vaultingAddress }).catch(() => undefined),
      activeCouncilPromise,
      ownedMintingAuthoritySignersPromise,
    ]);

    const hasExistingWalletValue = balances.some(balance => {
      return hasArgonWalletValue(balance);
    });
    const balancesByAddress = new Map(addresses.map((address, index) => [address, balances[index]]));
    const operationalProgress = getOperationalChainProgressFromAccount(operationalAccount);
    let hasMiningSeats = operationalProgress.hasFirstMiningSeat;
    let hasMiningBids = hasMiningSeats;
    if (!hasMiningSeats) {
      const [miningSeats, miningActivity] = await Promise.all([
        Mining.fetchMiningSeatsForAccount(walletKeys.miningBotAddress, finalizedApi).catch(() => undefined),
        findAddressActivity(walletKeys.miningBotAddress, {
          activityMask: AccountActivityKind.MiningBid | AccountActivityKind.MiningSeat,
        }).catch(() => undefined),
      ]);

      hasMiningSeats =
        Object.keys(miningSeats ?? {}).length > 0 ||
        !!miningActivity?.blocks.some(block => !!(block.activityMask & AccountActivityKind.MiningSeat));
      hasMiningBids = hasMiningSeats || !!miningActivity?.blocks.length;
    }

    const hasMiningWalletValue = [walletKeys.legacyMiningHoldAddress, walletKeys.miningBotAddress].some(address => {
      const balance = balancesByAddress.get(address);
      return balance ? hasArgonWalletValue(balance) : false;
    });
    const hasMiningActivity = hasMiningWalletValue || hasMiningBids;
    // Member Bitcoin events also carry VaultPosition because they affect vault capital. Only the runtime's operator
    // index proves that this account owns a vault and should regain Operations.
    const hasVaultActivity = operationalProgress.hasVault || !!ownedVault;
    const hasActivatedCrosschain = isAccountInGlobalIssuanceCouncil(activeCouncil, walletKeys.vaultingAddress);
    const hasCrosschainHistory = hasActivatedCrosschain || ownedMintingAuthoritySigners.length > 0;
    let hasTreasuryHistory = false;
    if (!operationalProgress.hasOperationalAccount) {
      const treasuryActivity = await findAddressActivity(walletKeys.defaultArgonAddress, {
        activityMask:
          AccountActivityKind.BondPosition | AccountActivityKind.BitcoinLock | AccountActivityKind.BitcoinMint,
      }).catch(() => undefined);

      if (treasuryActivity) {
        hasTreasuryHistory ||= treasuryActivity.blocks.some(block => {
          return !!(
            block.activityMask &
            (AccountActivityKind.BondPosition | AccountActivityKind.BitcoinLock | AccountActivityKind.BitcoinMint)
          );
        });
      }
    }

    const hasOperationsHistory =
      operationalProgress.hasOperationalAccount || hasMiningActivity || hasVaultActivity || hasCrosschainHistory;
    hasTreasuryHistory ||= hasOperationsHistory;

    const operatorName = getOperationalProfileName(operationalAccount);
    const onboardingSetupStatus = getOnboardingSetupStatus({
      hasOnboardingHistory: hasOperationsHistory,
      hasMiningSeats,
      hasVault: !!ownedVault,
      isServerInstalled: false,
      operatorName,
    });

    let miningSetupStatus = MiningSetupStatus.None;
    if (hasMiningBids) {
      miningSetupStatus = MiningSetupStatus.Finished;
    } else if (hasMiningActivity) {
      miningSetupStatus = MiningSetupStatus.Checklist;
    }

    return {
      walletAccountsHadPreviousLife: hasExistingWalletValue || hasTreasuryHistory,
      hasExtensionTreasury: hasTreasuryHistory,
      hasExtensionOperations: hasOperationsHistory,
      isUpgradedToOperations: operationalProgress.isUpgradedToOperations,
      hasActivatedCrosschain,
      miningSetupStatus,
      vaultingSetupStatus: hasVaultActivity ? VaultingSetupStatus.Finished : VaultingSetupStatus.None,
      onboardingSetupStatus,
      hasMiningBids,
      hasMiningSeats,
    };
  }

  private async shutdownBackgroundSync() {
    await getWalletsForArgon().close();
    getBlockWatch().stop();
  }

  private async fetchServerData(serverDetails: IConfigServerDetails): Promise<ITryServerData | undefined> {
    if (!serverDetails.ipAddress) return;

    const serverData = await SSH.tryConnection(serverDetails);
    return serverData;
  }
}

const pendingImportSchema = z.object({
  wallet: walletFileSchema,
  keychainValue: z.string().optional(),
  encryptedMnemonicCleanup: z
    .unknown()
    .refine(value => !Array.isArray(value) || value.length <= 2, 'An account import can remove at most two mnemonics.')
    .pipe(z.array(z.string()))
    .default([]),
  config: ConfigSchema.partial(),
});
