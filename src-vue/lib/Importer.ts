import { type Config } from './Config';
import Restarter from './Restarter';
import { Db } from './Db';
import { invokeWithTimeout } from './tauriApi';
import { ITryServerData, SSH } from './SSH';
import { BootstrapType, IConfigServerDetails } from '../interfaces/IConfig';
import { IS_LOCAL_BUILD, NETWORK_NAME, SECURITY } from './Env.ts';
import { hasArgonWalletValue } from './WalletForArgon.ts';
import { WalletKeys } from './WalletKeys.ts';
import { MemoryWalletKeys } from './MemoryWalletKeys.ts';
import { readArgonWalletBalanceValues } from './WalletsForArgon.ts';
import { getWalletsForArgon } from '../stores/wallets.ts';
import { getBlockWatch, getFinalizedClient } from '../stores/mainchain.ts';

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
    if (NETWORK_NAME === 'mainnet' && !IS_LOCAL_BUILD) {
      const importWalletKeys = new MemoryWalletKeys({
        substrateSuri: mnemonic,
        masterMnemonic: mnemonic,
      });
      const finalizedApi = await getFinalizedClient();
      const addresses = [
        importWalletKeys.miningHoldAddress,
        importWalletKeys.miningBotAddress,
        importWalletKeys.vaultingAddress,
        importWalletKeys.operationalAddress,
        importWalletKeys.investmentAddress,
      ];
      const balances = await readArgonWalletBalanceValues(finalizedApi, addresses);

      const hasExistingWalletValue = balances.some(balance => {
        return hasArgonWalletValue(balance);
      });

      if (!hasExistingWalletValue) {
        throw new Error('No existing wallet value was found for that mnemonic on this network.');
      }
    }

    await this.shutdownBackgroundSync();
    const restarter = new Restarter(this.dbPromise, this.config);
    await restarter.deleteAndCreateLocalDatabase();
    const db = await this.dbPromise;
    await db.reconnect();

    const security = await invokeWithTimeout('overwrite_mnemonic', { mnemonic }, 10_000);
    Object.assign(SECURITY, security);

    await this.config.load(true);
    this.config.bootstrapDetails = {
      type: BootstrapType.Public,
      routerHost: 'LOADING',
    };
    await this.config.save();

    restarter.restart();
  }

  private async shutdownBackgroundSync() {
    await getWalletsForArgon().close();
    getBlockWatch().stop();
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
    this.config.biddingRules = serverData.biddingRules!;
    this.config.oldestFrameIdToSync = serverData.oldestFrameIdToSync!;
    this.config.ethereumBeaconApiUrl = serverData.ethereumBeaconApiUrl;
    this.config.ethereumExecutionRpcUrl = serverData.ethereumExecutionRpcUrl;
    this.config.serverDetails = { ...this.config.serverDetails, ipAddress: ipAddress };
    await this.config.save();
  }

  private async fetchServerData(serverDetails: IConfigServerDetails): Promise<ITryServerData | undefined> {
    if (!serverDetails.ipAddress) return;

    const serverData = await SSH.tryConnection(serverDetails);
    return serverData;
  }
}
