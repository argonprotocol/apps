import packageJson from '../../package.json';
import { Db } from './Db';
import {
  IConfig,
  IConfigDefaults,
  IConfigStringified,
  InstallStepKey,
  InstallStepStatus,
  PanelKey,
  ServerType,
} from '../interfaces/IConfig';
import { Keyring, type KeyringPair, MICROGONS_PER_ARGON } from '@argonprotocol/mainchain';
import {
  BidAmountAdjustmentType,
  BidAmountFormulaType,
  JsonExt,
  MicronotPriceChangeType,
  miniSecretFromUri,
  SeatGoalInterval,
  SeatGoalType,
} from '@argonprotocol/commander-core';
import { message as tauriMessage } from '@tauri-apps/plugin-dialog';
import { createDeferred, ensureOnlyOneInstance } from './Utils';
import IDeferred from '../interfaces/IDeferred';
import { CurrencyKey } from './Currency';
import { bip39 } from '@argonprotocol/bitcoin';
import { getUserJurisdiction } from './Countries';
import ISecurity from '../interfaces/ISecurity';
import { getMainchainClients } from '../stores/mainchain';
import { WalletBalances } from './WalletBalances';
import { SECURITY } from './Env.ts';
import { invokeWithTimeout } from './tauriApi.ts';
import { LocalMachine } from './LocalMachine.ts';
import { VaultRecoveryFn } from './MyVaultRecovery.ts';

export class Config {
  public readonly version: string = packageJson.version;

  public get isLoaded(): boolean {
    return this._loadedDeferred.isSettled;
  }
  public get isLoadedPromise(): Promise<void> {
    return this._loadedDeferred.promise;
  }
  public hasDbMigrationError: boolean;

  private _loadedDeferred!: IDeferred<void>;

  private _db!: Db;
  private _fieldsToSave: Set<string> = new Set();
  private _dbPromise: Promise<Db>;
  private _security!: ISecurity;
  private _loadedData!: IConfig;
  private _rawData = {} as IConfigStringified;
  private _masterAccount!: KeyringPair;
  private _miningAccount!: KeyringPair;
  private _walletPreviousHistoryLoadPct: number = 0;
  private _vaultingAccount!: KeyringPair;
  private _miningSessionMiniSecret!: string;

  constructor(
    dbPromise: Promise<Db>,
    private vaultRecoveryFn?: VaultRecoveryFn,
  ) {
    ensureOnlyOneInstance(this.constructor);
    this._loadedDeferred = createDeferred<void>(false);
    this.hasDbMigrationError = false;

    this._dbPromise = dbPromise;
    this._security = {
      masterMnemonic: '',
      sshPublicKey: '',
    };
    this._loadedData = {
      version: packageJson.version,
      panelKey: PanelKey.Mining,
      requiresPassword: false,
      showWelcomeOverlay: false,
      serverDetails: {
        ipAddress: '',
        sshUser: '',
        type: ServerType.DigitalOcean,
        workDir: '~',
      },
      installDetails: Config.getDefault(dbFields.installDetails) as IConfig['installDetails'],
      oldestFrameIdToSync: Config.getDefault(dbFields.oldestFrameIdToSync) as number,
      latestFrameIdProcessed: Config.getDefault(dbFields.latestFrameIdProcessed) as number,
      miningAccountAddress: Config.getDefault(dbFields.miningAccountAddress) as string,
      walletAccountsHadPreviousLife: Config.getDefault(dbFields.walletAccountsHadPreviousLife) as boolean,
      walletPreviousLifeRecovered: Config.getDefault(dbFields.walletPreviousLifeRecovered) as boolean,
      miningAccountPreviousHistory: Config.getDefault(
        dbFields.miningAccountPreviousHistory,
      ) as IConfig['miningAccountPreviousHistory'],

      hasReadMiningInstructions: Config.getDefault(dbFields.hasReadMiningInstructions) as boolean,
      isPreparingMinerSetup: Config.getDefault(dbFields.isPreparingMinerSetup) as boolean,
      isMinerReadyToInstall: Config.getDefault(dbFields.isMinerReadyToInstall) as boolean,
      isMiningMachineCreated: Config.getDefault(dbFields.isMiningMachineCreated) as boolean,
      isMinerInstalled: Config.getDefault(dbFields.isMinerInstalled) as boolean,
      isMinerUpToDate: Config.getDefault(dbFields.isMinerUpToDate) as boolean,
      isMinerWaitingForUpgradeApproval: Config.getDefault(dbFields.isMinerWaitingForUpgradeApproval) as boolean,

      hasReadVaultingInstructions: Config.getDefault(dbFields.hasReadVaultingInstructions) as boolean,
      isPreparingVaultSetup: Config.getDefault(dbFields.isPreparingVaultSetup) as boolean,
      isVaultReadyToCreate: Config.getDefault(dbFields.isVaultReadyToCreate) as boolean,
      isVaultActivated: Config.getDefault(dbFields.isVaultActivated) as boolean,

      hasMiningSeats: Config.getDefault(dbFields.hasMiningSeats) as boolean,
      hasMiningBids: Config.getDefault(dbFields.hasMiningBids) as boolean,
      biddingRules: Config.getDefault(dbFields.biddingRules) as IConfig['biddingRules'],
      vaultingRules: Config.getDefault(dbFields.vaultingRules) as IConfig['vaultingRules'],
      defaultCurrencyKey: Config.getDefault(dbFields.defaultCurrencyKey) as CurrencyKey,
      userJurisdiction: {
        ipAddress: '',
        city: '',
        region: '',
        countryName: '',
        countryCode: '',
        latitude: '',
        longitude: '',
      },
    };
  }

  public async load(force = false) {
    if (!force && (this._loadedDeferred.isSettled || this._loadedDeferred.isRunning)) {
      return this._loadedDeferred.promise;
    }
    console.log('Config: Loading configuration from database...');
    this._loadedDeferred.setIsRunning(true);
    try {
      const db = await this._dbPromise;
      const fieldsToSave: Set<string> = new Set();
      const loadedData: any = {};
      const rawData = {} as IConfigStringified & { miningAccountAddress: string };

      const dbRawData = await db.configTable.fetchAllAsObject();

      if (db.hasMigrationError) {
        this.hasDbMigrationError = true;
      }

      this._security = SECURITY;

      for (const [key, value] of Object.entries(defaults)) {
        const rawValue = dbRawData[key as keyof typeof dbRawData];
        if (rawValue === undefined || rawValue === '') {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-call
          const defaultValue = await value();
          loadedData[key] = defaultValue;
          if (key !== dbFields.biddingRules && key !== dbFields.vaultingRules) {
            fieldsToSave.add(key);
            rawData[key as keyof typeof rawData] = JsonExt.stringify(defaultValue, 2);
          }
          continue;
        }

        loadedData[key] = JsonExt.parse(rawValue as string);
        rawData[key as keyof typeof rawData] = rawValue as string;
        if (key === dbFields.serverDetails) {
          // Ensure old serverDetails without type are set to DigitalOcean
          loadedData.serverDetails.type ??= ServerType.DigitalOcean;
          loadedData.serverDetails.workDir ??= '~';
          fieldsToSave.add(key);
          rawData[dbFields.serverDetails] = JsonExt.stringify(loadedData.serverDetails, 2);
        }
      }

      const isFirstTimeAppLoad = Object.keys(dbRawData).length === 0;
      if (isFirstTimeAppLoad) {
        await this._injectFirstTimeAppData(loadedData, rawData, fieldsToSave);
      }

      if (loadedData.serverDetails.type === ServerType.LocalComputer && loadedData.isMinerInstalled) {
        const { sshPort } = await LocalMachine.activate();
        await invokeWithTimeout('toggle_nosleep', { enable: true }, 5000);
        loadedData.serverDetails.ipAddress = `127.0.0.1`;
        loadedData.serverDetails.port = sshPort;
        fieldsToSave.add(dbFields.serverDetails);
        rawData[dbFields.serverDetails] = JsonExt.stringify(loadedData.serverDetails, 2);
      }
      const dataToSave = Config.extractDataToSave(fieldsToSave, rawData);
      await db.configTable.insertOrReplace(dataToSave);

      if (this.miningAccount.address !== loadedData.miningAccountAddress) {
        await tauriMessage(
          'Your database does not match your current mining account address. Something has corrupted your data.',
          {
            title: 'Mining Account Inconsistency',
            kind: 'error',
          },
        );
      }

      this._db = db;
      this._loadedData = loadedData as IConfig;
      this._rawData = rawData;
      this._loadedDeferred.resolve();
      if (this.walletAccountsHadPreviousLife && !this.walletPreviousLifeRecovered) {
        await this._bootupFromAccountPreviousHistory();
      }
    } catch (e) {
      this._loadedDeferred.reject(e);
    }
  }

  get masterAccount(): KeyringPair {
    // we will allow this to operate even if not loaded so this._injectFirstTimeAppData can set the miningAccountAddress
    if (this._masterAccount) return this._masterAccount;

    const masterAccount = new Keyring({ type: 'sr25519' }).createFromUri(this._security.masterMnemonic);
    if (!this.isLoaded) return masterAccount;

    this._masterAccount = masterAccount;
    return this._masterAccount;
  }

  get miningSessionMiniSecret(): string {
    this._throwErrorIfNotLoaded();
    return (this._miningSessionMiniSecret ||= miniSecretFromUri(`${this.security.masterMnemonic}//mining//sessions`));
  }

  get miningAccount(): KeyringPair {
    // we will allow this to operate even if not loaded so this._injectFirstTimeAppData can set the miningAccountAddress
    if (this._miningAccount) return this._miningAccount;

    const miningAccount = this.masterAccount.derive(`//mining`);
    if (!this.isLoaded) return miningAccount;

    this._miningAccount = miningAccount;
    return this._miningAccount;
  }

  get vaultingAccount(): KeyringPair {
    if (this._vaultingAccount) return this._vaultingAccount;

    const vaultingAccount = this.masterAccount.derive(`//vaulting`);
    if (!this.isLoaded) return vaultingAccount;
    this._vaultingAccount = vaultingAccount;
    return this._vaultingAccount;
  }

  get walletAccountsHadPreviousLife(): IConfig['walletAccountsHadPreviousLife'] {
    this._throwErrorIfNotLoaded();
    return this._loadedData.walletAccountsHadPreviousLife;
  }

  set walletAccountsHadPreviousLife(value: IConfig['walletAccountsHadPreviousLife']) {
    this._throwErrorIfNotLoaded();
    this._loadedData.walletAccountsHadPreviousLife = value;
    this._tryFieldsToSave(dbFields.walletAccountsHadPreviousLife, value);
  }

  get walletPreviousLifeRecovered(): IConfig['walletPreviousLifeRecovered'] {
    this._throwErrorIfNotLoaded();
    return this._loadedData.walletPreviousLifeRecovered;
  }

  set walletPreviousLifeRecovered(value: IConfig['walletPreviousLifeRecovered']) {
    this._throwErrorIfNotLoaded();
    this._loadedData.walletPreviousLifeRecovered = value;
    this._tryFieldsToSave(dbFields.walletPreviousLifeRecovered, value);
  }

  get miningAccountPreviousHistory(): IConfig['miningAccountPreviousHistory'] {
    this._throwErrorIfNotLoaded();
    return this._loadedData.miningAccountPreviousHistory;
  }

  set miningAccountPreviousHistory(value: IConfig['miningAccountPreviousHistory']) {
    this._throwErrorIfNotLoaded();
    this._loadedData.miningAccountPreviousHistory = value;
    this._tryFieldsToSave(dbFields.miningAccountPreviousHistory, value);
  }

  get isBootingUpPreviousWalletHistory(): boolean {
    return this._loadedData.walletAccountsHadPreviousLife && !this._loadedData.walletPreviousLifeRecovered;
  }

  get walletPreviousHistoryLoadPct(): number {
    if (!this.isBootingUpPreviousWalletHistory) return 100;
    return Math.min(this._walletPreviousHistoryLoadPct, 100);
  }

  get bitcoinXprivSeed(): Uint8Array {
    return bip39.mnemonicToSeedSync(this.security.masterMnemonic);
  }

  //////////////////////////////

  get panelKey(): PanelKey {
    this._throwErrorIfNotLoaded();
    return this._loadedData.panelKey;
  }

  set panelKey(value: PanelKey) {
    this._throwErrorIfNotLoaded();
    this._loadedData.panelKey = value;
    this._tryFieldsToSave(dbFields.panelKey, value);
  }

  get requiresPassword(): boolean {
    this._throwErrorIfNotLoaded();
    return this._loadedData.requiresPassword;
  }

  set requiresPassword(value: boolean) {
    this._throwErrorIfNotLoaded();
    this._loadedData.requiresPassword = value;
    this._tryFieldsToSave(dbFields.requiresPassword, value);
  }

  get showWelcomeOverlay(): boolean {
    this._throwErrorIfNotLoaded();
    return this._loadedData.showWelcomeOverlay;
  }

  set showWelcomeOverlay(value: boolean) {
    this._throwErrorIfNotLoaded();
    this._loadedData.showWelcomeOverlay = value;
    this._tryFieldsToSave(dbFields.showWelcomeOverlay, value);
  }

  get security(): ISecurity {
    this._throwErrorIfNotLoaded();
    return this._security;
  }

  get serverCreation(): IConfig['serverCreation'] {
    this._throwErrorIfNotLoaded();
    return this._loadedData.serverCreation;
  }

  set serverCreation(value: IConfig['serverCreation']) {
    this._throwErrorIfNotLoaded();
    this._loadedData.serverCreation = value;
    this._tryFieldsToSave(dbFields.serverCreation, value);
  }

  get serverDetails(): IConfig['serverDetails'] {
    this._throwErrorIfNotLoaded();
    return this._loadedData.serverDetails;
  }

  set serverDetails(value: IConfig['serverDetails']) {
    this._throwErrorIfNotLoaded();
    this._loadedData.serverDetails = value;
    this._tryFieldsToSave(dbFields.serverDetails, value);
  }

  get installDetails(): IConfig['installDetails'] {
    this._throwErrorIfNotLoaded();
    return this._loadedData.installDetails;
  }

  set installDetails(value: IConfig['installDetails']) {
    this._throwErrorIfNotLoaded();
    this._loadedData.installDetails = value;
    this._tryFieldsToSave(dbFields.installDetails, value);
  }

  get oldestFrameIdToSync(): number {
    this._throwErrorIfNotLoaded();
    return this._loadedData.oldestFrameIdToSync;
  }

  set oldestFrameIdToSync(value: number) {
    this._throwErrorIfNotLoaded();
    this._loadedData.oldestFrameIdToSync = value;
    this._tryFieldsToSave(dbFields.oldestFrameIdToSync, value);
  }

  get latestFrameIdProcessed(): number {
    this._throwErrorIfNotLoaded();
    return this._loadedData.latestFrameIdProcessed;
  }

  set latestFrameIdProcessed(value: number) {
    this._throwErrorIfNotLoaded();
    this._loadedData.latestFrameIdProcessed = value;
    this._tryFieldsToSave(dbFields.latestFrameIdProcessed, value);
  }

  get hasReadMiningInstructions(): boolean {
    this._throwErrorIfNotLoaded();
    return this._loadedData.hasReadMiningInstructions;
  }

  set hasReadMiningInstructions(value: boolean) {
    this._throwErrorIfNotLoaded();
    this._loadedData.hasReadMiningInstructions = value;
    this._tryFieldsToSave(dbFields.hasReadMiningInstructions, value);
  }

  get isPreparingMinerSetup(): boolean {
    this._throwErrorIfNotLoaded();
    return this._loadedData.isPreparingMinerSetup;
  }

  set isPreparingMinerSetup(value: boolean) {
    this._throwErrorIfNotLoaded();
    this._loadedData.isPreparingMinerSetup = value;
    this._tryFieldsToSave(dbFields.isPreparingMinerSetup, value);
  }

  get isMinerReadyToInstall(): boolean {
    this._throwErrorIfNotLoaded();
    return this._loadedData.isMinerReadyToInstall;
  }

  set isMinerReadyToInstall(value: boolean) {
    this._throwErrorIfNotLoaded();
    this._loadedData.isMinerReadyToInstall = value;
    this._tryFieldsToSave(dbFields.isMinerReadyToInstall, value);
  }

  get isMiningMachineCreated(): boolean {
    this._throwErrorIfNotLoaded();
    return this._loadedData.isMiningMachineCreated;
  }

  set isMiningMachineCreated(value: boolean) {
    this._throwErrorIfNotLoaded();
    this._loadedData.isMiningMachineCreated = value;
    this._tryFieldsToSave(dbFields.isMiningMachineCreated, value);
  }

  get isMinerUpToDate(): boolean {
    this._throwErrorIfNotLoaded();
    return this._loadedData.isMinerUpToDate;
  }

  set isMinerUpToDate(value: boolean) {
    this._throwErrorIfNotLoaded();
    this._loadedData.isMinerUpToDate = value;
    this._tryFieldsToSave(dbFields.isMinerUpToDate, value);
  }

  get isMinerInstalled(): boolean {
    this._throwErrorIfNotLoaded();
    return this._loadedData.isMinerInstalled;
  }

  set isMinerInstalled(value: boolean) {
    this._throwErrorIfNotLoaded();
    this._loadedData.isMinerInstalled = value;
    this._tryFieldsToSave(dbFields.isMinerInstalled, value);
  }

  get isMinerWaitingForUpgradeApproval(): boolean {
    this._throwErrorIfNotLoaded();
    return this._loadedData.isMinerWaitingForUpgradeApproval;
  }

  set isMinerWaitingForUpgradeApproval(value: boolean) {
    this._throwErrorIfNotLoaded();
    this._loadedData.isMinerWaitingForUpgradeApproval = value;
    this._tryFieldsToSave(dbFields.isMinerWaitingForUpgradeApproval, value);
  }

  get hasReadVaultingInstructions(): boolean {
    this._throwErrorIfNotLoaded();
    return this._loadedData.hasReadVaultingInstructions;
  }

  set hasReadVaultingInstructions(value: boolean) {
    this._throwErrorIfNotLoaded();
    this._loadedData.hasReadVaultingInstructions = value;
    this._tryFieldsToSave(dbFields.hasReadVaultingInstructions, value);
  }

  get isPreparingVaultSetup(): boolean {
    this._throwErrorIfNotLoaded();
    return this._loadedData.isPreparingVaultSetup;
  }

  set isPreparingVaultSetup(value: boolean) {
    this._throwErrorIfNotLoaded();
    this._loadedData.isPreparingVaultSetup = value;
    this._tryFieldsToSave(dbFields.isPreparingVaultSetup, value);
  }

  get isVaultReadyToCreate(): boolean {
    this._throwErrorIfNotLoaded();
    return this._loadedData.isVaultReadyToCreate;
  }

  set isVaultReadyToCreate(value: boolean) {
    this._throwErrorIfNotLoaded();
    this._loadedData.isVaultReadyToCreate = value;
    this._tryFieldsToSave(dbFields.isVaultReadyToCreate, value);
  }

  get isVaultActivated(): boolean {
    this._throwErrorIfNotLoaded();
    return this._loadedData.isVaultActivated;
  }

  set isVaultActivated(value: boolean) {
    this._throwErrorIfNotLoaded();
    this._loadedData.isVaultActivated = value;
    this._tryFieldsToSave(dbFields.isVaultActivated, value);
  }

  get hasMiningSeats(): boolean {
    this._throwErrorIfNotLoaded();
    return this._loadedData.hasMiningSeats;
  }

  set hasMiningSeats(value: boolean) {
    this._throwErrorIfNotLoaded();
    this._loadedData.hasMiningSeats = value;
    this._tryFieldsToSave(dbFields.hasMiningSeats, value);
  }

  get hasMiningBids(): boolean {
    this._throwErrorIfNotLoaded();
    return this._loadedData.hasMiningBids;
  }

  set hasMiningBids(value: boolean) {
    this._throwErrorIfNotLoaded();
    this._loadedData.hasMiningBids = value;
    this._tryFieldsToSave(dbFields.hasMiningBids, value);
  }

  get biddingRules(): IConfig['biddingRules'] {
    this._throwErrorIfNotLoaded();
    return this._loadedData.biddingRules;
  }

  set biddingRules(value: IConfig['biddingRules']) {
    this._throwErrorIfNotLoaded();
    this._loadedData.biddingRules = value;
  }

  get vaultingRules(): IConfig['vaultingRules'] {
    this._throwErrorIfNotLoaded();
    return this._loadedData.vaultingRules;
  }

  set vaultingRules(value: IConfig['vaultingRules']) {
    this._throwErrorIfNotLoaded();
    this._loadedData.vaultingRules = value;
  }

  get defaultCurrencyKey(): CurrencyKey {
    this._throwErrorIfNotLoaded();
    return this._loadedData.defaultCurrencyKey;
  }

  set defaultCurrencyKey(value: CurrencyKey) {
    this._throwErrorIfNotLoaded();
    this._loadedData.defaultCurrencyKey = value;
    this._tryFieldsToSave(dbFields.defaultCurrencyKey, value);
  }

  get userJurisdiction(): IConfig['userJurisdiction'] {
    this._throwErrorIfNotLoaded();
    return this._loadedData.userJurisdiction;
  }

  set userJurisdiction(value: IConfig['userJurisdiction']) {
    this._throwErrorIfNotLoaded();
    this._loadedData.userJurisdiction = value;
    this._tryFieldsToSave(dbFields.userJurisdiction, value);
  }

  get isValidJurisdiction(): boolean {
    this._throwErrorIfNotLoaded();
    return this.userJurisdiction.countryCode === 'KY';
  }

  get hasSavedBiddingRules(): boolean {
    this._throwErrorIfNotLoaded();
    return !!this._rawData[dbFields.biddingRules];
  }

  get hasSavedVaultingRules(): boolean {
    this._throwErrorIfNotLoaded();
    return !!this._rawData[dbFields.vaultingRules];
  }

  public async saveBiddingRules() {
    this._throwErrorIfNotLoaded();
    this._tryFieldsToSave(dbFields.biddingRules, this.biddingRules);
    await this.save();
  }

  public async saveVaultingRules() {
    this._throwErrorIfNotLoaded();
    this._tryFieldsToSave(dbFields.vaultingRules, this.vaultingRules);
    await this.save();
  }

  public async save() {
    this._throwErrorIfNotLoaded();
    const dataToSave = Config.extractDataToSave(this._fieldsToSave, this._rawData);
    this._fieldsToSave = new Set();
    if (Object.keys(dataToSave).length === 0) return;

    await this._db.configTable.insertOrReplace(dataToSave);
  }

  public resetField(field: keyof typeof dbFields) {
    this._throwErrorIfNotLoaded();
    (this as any)[field] = defaults[field]();
    this._fieldsToSave.add(field);
  }

  private _throwErrorIfNotLoaded() {
    if (!this.isLoaded) throw new Error('Config is not yet loaded. You must wait for isLoaded to be true.');
  }

  private _tryFieldsToSave(field: keyof typeof dbFields, value: any) {
    const stringifiedValue = JsonExt.stringify(value, 2);
    if (this._rawData[field] === stringifiedValue) return;

    this._rawData[field] = stringifiedValue;
    this._fieldsToSave.add(field);
  }

  private async _injectFirstTimeAppData(
    loadedData: Partial<IConfig>,
    stringifiedData: IConfigStringified,
    fieldsToSave: Set<string>,
  ) {
    // We cannot use this._tryFieldsToSave because this._stringifiedData and this._fieldsToSave are not initialized yet. Instead
    // we can set the values to their temporary loadedData and stringifiedData objects

    const miningAccountAddress = this.miningAccount.address;
    loadedData.miningAccountAddress = miningAccountAddress;
    stringifiedData[dbFields.miningAccountAddress] = JsonExt.stringify(miningAccountAddress, 2);
    fieldsToSave.add(dbFields.miningAccountAddress);

    const walletHadPreviousLife = await this._didWalletHavePreviousLife({
      miningAccountAddress,
      vaultingAccountAddress: this.vaultingAccount.address,
    });
    loadedData.walletAccountsHadPreviousLife = walletHadPreviousLife;
    stringifiedData[dbFields.walletAccountsHadPreviousLife] = JsonExt.stringify(walletHadPreviousLife, 2);
    fieldsToSave.add(dbFields.walletAccountsHadPreviousLife);

    if (walletHadPreviousLife) {
      loadedData.showWelcomeOverlay = false;
      stringifiedData[dbFields.showWelcomeOverlay] = JsonExt.stringify(false, 2);
      fieldsToSave.add(dbFields.showWelcomeOverlay);
    }
  }

  private async _didWalletHavePreviousLife(addresses: {
    miningAccountAddress: string;
    vaultingAccountAddress: string;
  }) {
    const walletBalances = new WalletBalances(getMainchainClients());
    await walletBalances.load(addresses);

    const miningHasValue = WalletBalances.doesWalletHaveValue(walletBalances.miningWallet);
    const vaultingHasValue = WalletBalances.doesWalletHaveValue(walletBalances.vaultingWallet);
    return miningHasValue || vaultingHasValue;
  }

  private async _bootupFromAccountPreviousHistory() {
    console.log('Config: Booting up from account previous history...', {
      miningAccountAddress: this.miningAccount.address,
      vaultingAccountAddress: this.vaultingAccount.address,
    });
    const walletBalances = new WalletBalances(getMainchainClients());
    await walletBalances.load({
      miningAccountAddress: this.miningAccount.address,
      vaultingAccountAddress: this.vaultingAccount.address,
    });
    walletBalances.onLoadHistoryProgress = (loadPct: number) => {
      this._walletPreviousHistoryLoadPct = loadPct;
    };

    const { miningHistory, vaultingRules } = await walletBalances.loadHistory(
      this.miningAccount,
      this.bitcoinXprivSeed,
      this.vaultRecoveryFn,
    );
    if (!miningHistory?.length && !vaultingRules) {
      console.warn('Config: No previous history found');
      this.walletAccountsHadPreviousLife = false;
      return;
    }
    if (miningHistory) {
      console.log('Config: Previous mining history found');
      const frameIdsProcessed = miningHistory.map(x => x.frameId);
      const oldestFrameIdProcessed = frameIdsProcessed.length ? Math.min(...frameIdsProcessed) : 0;
      if (miningHistory.length === 1 && !miningHistory[0].seats.length) {
        // We only found bids for today, which means today was the start
        this.oldestFrameIdToSync = oldestFrameIdProcessed;
        this.hasMiningBids = true;
      } else if (miningHistory.length) {
        // We found seat history, so we can set the oldestFrameIdToSync to the previous frame of the oldest we have
        // It must be previous frame because we can't have a seat for today if we didn't bid yesterday
        this.oldestFrameIdToSync = oldestFrameIdProcessed - 1;
        this.hasMiningBids = true;
        this.hasMiningSeats = true;
      }
      this.miningAccountPreviousHistory = miningHistory;
      this.isPreparingMinerSetup = true;
      this.hasReadMiningInstructions = miningHistory.length > 0;
    }

    if (vaultingRules) {
      console.log('Config: Previous vaulting rules found');
      this.vaultingRules = vaultingRules;
      this.isVaultReadyToCreate = true;
      this.isPreparingVaultSetup = true;
      this.hasReadVaultingInstructions = true;

      this._tryFieldsToSave(dbFields.vaultingRules, vaultingRules);
    }

    this.walletPreviousLifeRecovered = true;
    await this.save();
  }

  private static extractDataToSave(
    fieldsToSave: Set<string>,
    stringifiedData: IConfigStringified,
  ): Partial<IConfigStringified> {
    const toSave = {} as IConfigStringified;
    for (const field of fieldsToSave) {
      const value = stringifiedData[field as keyof IConfig];
      if (value !== undefined) {
        toSave[field as keyof IConfigStringified] = value;
      }
    }

    return toSave;
  }

  public static getDefault(field: keyof typeof dbFields) {
    return defaults[field]();
  }
}

const dbFields = {
  panelKey: 'panelKey',
  requiresPassword: 'requiresPassword',
  showWelcomeOverlay: 'showWelcomeOverlay',

  serverCreation: 'serverCreation',
  serverDetails: 'serverDetails',
  installDetails: 'installDetails',
  oldestFrameIdToSync: 'oldestFrameIdToSync',
  latestFrameIdProcessed: 'latestFrameIdProcessed',
  miningAccountAddress: 'miningAccountAddress',
  miningAccountPreviousHistory: 'miningAccountPreviousHistory',
  walletAccountsHadPreviousLife: 'walletAccountsHadPreviousLife',
  walletPreviousLifeRecovered: 'walletPreviousLifeRecovered',

  hasReadMiningInstructions: 'hasReadMiningInstructions',
  isPreparingMinerSetup: 'isPreparingMinerSetup',
  isMinerReadyToInstall: 'isMinerReadyToInstall',
  isMiningMachineCreated: 'isMiningMachineCreated',
  isMinerInstalled: 'isMinerInstalled',
  isMinerUpToDate: 'isMinerUpToDate',
  isMinerWaitingForUpgradeApproval: 'isMinerWaitingForUpgradeApproval',

  hasReadVaultingInstructions: 'hasReadVaultingInstructions',
  isPreparingVaultSetup: 'isPreparingVaultSetup',
  isVaultReadyToCreate: 'isVaultReadyToCreate',
  isVaultActivated: 'isVaultActivated',

  hasMiningSeats: 'hasMiningSeats',
  hasMiningBids: 'hasMiningBids',
  biddingRules: 'biddingRules',
  vaultingRules: 'vaultingRules',
  defaultCurrencyKey: 'defaultCurrencyKey',
  userJurisdiction: 'userJurisdiction',
} as const;

const defaults: IConfigDefaults = {
  panelKey: () => PanelKey.Mining,
  requiresPassword: () => false,
  showWelcomeOverlay: () => true,

  serverCreation: () => undefined,
  serverDetails: () => {
    return {
      ipAddress: '',
      sshUser: 'root',
      type: ServerType.DigitalOcean,
      workDir: '~',
    };
  },
  installDetails: () => {
    const defaultStep = {
      progress: 0,
      status: InstallStepStatus.Pending,
      startDate: null,
    };
    return {
      [InstallStepKey.ServerConnect]: { ...defaultStep },
      [InstallStepKey.FileUpload]: { ...defaultStep },
      [InstallStepKey.UbuntuCheck]: { ...defaultStep },
      [InstallStepKey.DockerInstall]: { ...defaultStep },
      [InstallStepKey.BitcoinInstall]: { ...defaultStep },
      [InstallStepKey.ArgonInstall]: { ...defaultStep },
      [InstallStepKey.MiningLaunch]: { ...defaultStep },
      errorType: null,
      errorMessage: null,
      isRunning: false,
    };
  },
  oldestFrameIdToSync: () => 0,
  latestFrameIdProcessed: () => 0,
  miningAccountAddress: () => '',
  miningAccountPreviousHistory: () => null,
  walletAccountsHadPreviousLife: () => false,
  walletPreviousLifeRecovered: () => false,

  hasReadMiningInstructions: () => false,
  isPreparingMinerSetup: () => false,
  isMinerReadyToInstall: () => false,
  isMiningMachineCreated: () => false,
  isMinerInstalled: () => false,
  isMinerUpToDate: () => false,
  isMinerWaitingForUpgradeApproval: () => false,

  hasReadVaultingInstructions: () => false,
  isPreparingVaultSetup: () => false,
  isVaultReadyToCreate: () => false,
  isVaultActivated: () => false,

  hasMiningSeats: () => false,
  hasMiningBids: () => false,
  biddingRules: () => {
    return {
      argonCirculationGrowthPctMin: 0,
      argonCirculationGrowthPctMax: 10,

      argonotPriceChangeType: MicronotPriceChangeType.Between,
      argonotPriceChangePctMin: -10,
      argonotPriceChangePctMax: +10,

      startingBidFormulaType: BidAmountFormulaType.PreviousDayLow,
      startingBidAdjustmentType: BidAmountAdjustmentType.Relative,
      startingBidCustom: 0n * BigInt(MICROGONS_PER_ARGON),
      startingBidAdjustAbsolute: 0n * BigInt(MICROGONS_PER_ARGON),
      startingBidAdjustRelative: 0,

      rebiddingDelay: 1,
      rebiddingIncrementBy: 1n * BigInt(MICROGONS_PER_ARGON),

      maximumBidFormulaType: BidAmountFormulaType.BreakevenAtSlowGrowth,
      maximumBidAdjustmentType: BidAmountAdjustmentType.Relative,
      maximumBidCustom: 0n,
      maximumBidAdjustAbsolute: 0n,
      maximumBidAdjustRelative: -1.0,

      seatGoalType: SeatGoalType.Min,
      seatGoalCount: 3,
      seatGoalPercent: 0,
      seatGoalInterval: SeatGoalInterval.Epoch,

      baseMicrogonCommitment: 1_000n * BigInt(MICROGONS_PER_ARGON),
      baseMicronotCommitment: 0n,
    };
  },
  vaultingRules: () => {
    return {
      capitalForSecuritizationPct: 50,
      capitalForTreasuryPct: 50,
      securitizationRatio: 1,
      profitSharingPct: 10,
      btcFlatFee: 2n * BigInt(MICROGONS_PER_ARGON),
      btcPctFee: 5,

      btcUtilizationPctMin: 50,
      btcUtilizationPctMax: 100,

      poolUtilizationPctMin: 50,
      poolUtilizationPctMax: 100,

      personalBtcPct: 100,

      baseMicrogonCommitment: 2_000n * BigInt(MICROGONS_PER_ARGON),
      baseMicronotCommitment: 0n,
    };
  },
  defaultCurrencyKey: () => CurrencyKey.ARGN,
  userJurisdiction: getUserJurisdiction,
};
