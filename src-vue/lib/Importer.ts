import { type Config } from './Config';
import Restarter from './Restarter';
import { Db } from './Db';
import { invokeWithTimeout } from './tauriApi';
import { type ITryServerData, SSH } from './SSH';
import {
  type IConfigServerDetails,
  type IConfigStringified,
  MiningSetupStatus,
  VaultingSetupStatus,
} from '../interfaces/IConfig';
import { IS_LOCAL_BUILD, NETWORK_NAME, SECURITY } from './Env.ts';
import { hasArgonWalletValue } from './WalletForArgon.ts';
import { WalletKeys } from './WalletKeys.ts';
import { MemoryWalletKeys } from './MemoryWalletKeys.ts';
import { readArgonWalletBalanceValues } from './WalletsForArgon.ts';
import { getWalletsForArgon } from '../stores/wallets.ts';
import { getBlockWatch, getFinalizedClient } from '../stores/mainchain.ts';
import { AccountActivityKind, JsonExt, Mining } from '@argonprotocol/apps-core';
import { getOperationalChainProgressFromAccount } from './OperationalAccount.ts';
import { findAddressActivity } from './IndexerClient.ts';

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

  public async importFromMnemonic(mnemonic: string) {
    const importWalletKeys = new MemoryWalletKeys({
      substrateSuri: mnemonic,
      masterMnemonic: mnemonic,
    });
    const finalizedApi = await getFinalizedClient();
    const addresses = [
      importWalletKeys.legacyMiningHoldAddress,
      importWalletKeys.miningBotAddress,
      importWalletKeys.vaultingAddress,
      importWalletKeys.operationalAddress,
    ];
    const [balances, operationalAccount] = await Promise.all([
      readArgonWalletBalanceValues(finalizedApi, addresses),
      finalizedApi.query.operationalAccounts.operationalAccounts(importWalletKeys.operationalAddress),
    ]);

    const hasExistingWalletValue = balances.some(balance => {
      return hasArgonWalletValue(balance);
    });
    const operationalProgress = getOperationalChainProgressFromAccount(operationalAccount);
    let hasMiningSeats = operationalProgress.hasFirstMiningSeat;
    let hasMiningBids = hasMiningSeats;
    if (!hasMiningSeats) {
      const [miningSeats, miningActivity] = await Promise.all([
        Mining.fetchMiningSeatsForAccount(importWalletKeys.miningBotAddress, finalizedApi).catch(() => undefined),
        findAddressActivity(importWalletKeys.miningBotAddress, {
          activityMask: AccountActivityKind.MiningBid | AccountActivityKind.MiningSeat,
        }).catch(() => undefined),
      ]);

      hasMiningSeats =
        Object.keys(miningSeats ?? {}).length > 0 ||
        !!miningActivity?.blocks.some(block => !!(block.activityMask & AccountActivityKind.MiningSeat));
      hasMiningBids = hasMiningSeats || !!miningActivity?.blocks.length;
    }

    const hasMiningWalletValue = hasArgonWalletValue(balances[0]) || hasArgonWalletValue(balances[1]);
    const hasMiningActivity = hasMiningWalletValue || hasMiningBids;
    let hasVaultActivity = operationalProgress.hasVault;
    let hasTreasuryHistory = false;
    if (!operationalProgress.hasOperationalAccount) {
      const accountActivity = await findAddressActivity(importWalletKeys.defaultArgonAddress, {
        activityMask:
          AccountActivityKind.VaultPosition |
          AccountActivityKind.VaultRevenue |
          AccountActivityKind.BondPosition |
          AccountActivityKind.BitcoinLock |
          AccountActivityKind.BitcoinMint,
      }).catch(() => undefined);

      if (accountActivity) {
        hasVaultActivity ||= accountActivity.blocks.some(block => {
          return !!(block.activityMask & (AccountActivityKind.VaultPosition | AccountActivityKind.VaultRevenue));
        });
        hasTreasuryHistory ||= accountActivity.blocks.some(block => {
          return !!(
            block.activityMask &
            (AccountActivityKind.BondPosition | AccountActivityKind.BitcoinLock | AccountActivityKind.BitcoinMint)
          );
        });
      }
    }

    const hasOperationsHistory = operationalProgress.hasOperationalAccount || hasMiningActivity || hasVaultActivity;
    hasTreasuryHistory ||= hasOperationsHistory;

    const hasPreviousLife = hasExistingWalletValue || hasTreasuryHistory;
    let miningSetupStatus = MiningSetupStatus.None;
    if (hasMiningBids) {
      miningSetupStatus = MiningSetupStatus.Finished;
    } else if (hasMiningActivity) {
      miningSetupStatus = MiningSetupStatus.Checklist;
    }

    if (NETWORK_NAME === 'mainnet' && !IS_LOCAL_BUILD && !hasPreviousLife) {
      throw new Error('No existing wallet value was found for that mnemonic on this network.');
    }

    await this.shutdownBackgroundSync();
    const restarter = new Restarter(this.dbPromise, this.config);
    await restarter.deleteAndCreateLocalDatabase();
    const db = await this.dbPromise;
    await db.reconnect();

    const security = await invokeWithTimeout('overwrite_mnemonic', { mnemonic }, 10_000);
    Object.assign(SECURITY, security);

    // The live Config and wallet singletons still reference the previous mnemonic until the app reloads.
    const importedConfig: Partial<IConfigStringified> = {
      showWelcomeOverlay: JsonExt.stringify(false, 2),
      walletAccountsHadPreviousLife: JsonExt.stringify(hasPreviousLife, 2),
      walletPreviousLifeRecovered: JsonExt.stringify(!hasPreviousLife, 2),
      hasExtensionTreasury: JsonExt.stringify(hasTreasuryHistory, 2),
      hasExtensionOperations: JsonExt.stringify(hasOperationsHistory, 2),
      miningSetupStatus: JsonExt.stringify(miningSetupStatus, 2),
      vaultingSetupStatus: JsonExt.stringify(
        hasVaultActivity ? VaultingSetupStatus.Finished : VaultingSetupStatus.None,
        2,
      ),
      hasMiningBids: JsonExt.stringify(hasMiningBids, 2),
      hasMiningSeats: JsonExt.stringify(hasMiningSeats, 2),
    };
    await db.configTable.insertOrReplace(importedConfig);

    restarter.restart();
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
