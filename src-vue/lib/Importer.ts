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
import { JsonExt, Mining } from '@argonprotocol/apps-core';

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
    const [balances, operationalAccount, miningAccount, miningSeats, currentBids, miningSubaccounts] =
      await Promise.all([
        readArgonWalletBalanceValues(finalizedApi, addresses),
        finalizedApi.query.operationalAccounts.operationalAccounts(importWalletKeys.operationalAddress),
        finalizedApi.query.system.account(importWalletKeys.miningBotAddress),
        Mining.fetchMiningSeatsForAccount(importWalletKeys.miningBotAddress, finalizedApi),
        Mining.fetchWinningBids(finalizedApi),
        importWalletKeys.getMiningBotSubaccounts(),
      ]);

    const hasExistingWalletValue = balances.some(balance => {
      return hasArgonWalletValue(balance);
    });
    const operationalDetails = operationalAccount.isSome ? operationalAccount.unwrap() : undefined;
    const hasLiveMiningSeats = Object.keys(miningSeats).length > 0;
    const hasRecordedMiningSeats =
      (operationalDetails?.miningSeatAccrual?.toNumber() ?? 0) +
        (operationalDetails?.miningSeatAppliedTotal?.toNumber() ?? 0) >
      0;
    const hasMiningSeats = hasLiveMiningSeats || hasRecordedMiningSeats;
    const hasMiningBids =
      hasMiningSeats ||
      currentBids.some(bid => {
        return bid.managedByAddress === importWalletKeys.miningBotAddress || !!miningSubaccounts[bid.address];
      });
    const hasMiningAccountInfo =
      hasArgonWalletValue(balances[1]) ||
      miningAccount.nonce.toBigInt() > 0n ||
      miningAccount.providers.toNumber() > 0 ||
      miningAccount.consumers.toNumber() > 0 ||
      miningAccount.sufficients.toNumber() > 0;
    const hasLinkedMiningAccount = operationalDetails?.miningAccount.toHuman() === importWalletKeys.miningBotAddress;
    const hasMiningAccount = hasLinkedMiningAccount || hasMiningAccountInfo || hasMiningBids;
    const hasVault = operationalDetails?.vaultCreated?.toPrimitive() ?? false;
    const hasPreviousLife = hasExistingWalletValue || !!operationalDetails || hasMiningAccount;

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
      hasExtensionTreasury: JsonExt.stringify(hasPreviousLife, 2),
      hasExtensionOperations: JsonExt.stringify(!!operationalDetails || hasMiningAccount, 2),
      miningSetupStatus: JsonExt.stringify(hasMiningAccount ? MiningSetupStatus.Finished : MiningSetupStatus.None, 2),
      vaultingSetupStatus: JsonExt.stringify(hasVault ? VaultingSetupStatus.Finished : VaultingSetupStatus.None, 2),
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
    } else if (!serverData.biddingRules) {
      throw new Error('No bidding rules found on server');
    }

    // TODO: We might want to return this data to the caller (BotCreatePanel) so they can hold it in case the user
    // wants to click the Cancel button.
    this.config.biddingRules = serverData.biddingRules;
    if (serverData.oldestFrameIdToSync !== undefined) {
      this.config.oldestFrameIdToSync = serverData.oldestFrameIdToSync;
    }
    this.config.ethereumBeaconApiUrl = serverData.ethereumBeaconApiUrl;
    this.config.ethereumExecutionRpcUrl = serverData.ethereumExecutionRpcUrl;
    this.config.serverDetails = { ...this.config.serverDetails, ipAddress };
    this.config.isServerInstalled = true;
    this.config.isServerInstalling = false;
    this.config.miningSetupStatus = MiningSetupStatus.Finished;
    this.config.hasExtensionTreasury = true;
    this.config.hasExtensionOperations = true;
    await this.config.saveBiddingRules();
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
