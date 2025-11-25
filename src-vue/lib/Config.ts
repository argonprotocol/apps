import packageJson from '../../package.json';
import { Db } from './Db';
import {
  ConfigSchema,
  IConfig,
  IConfigDefaults,
  IConfigStringified,
  InstallStepKey,
  InstallStepStatus,
  PanelKey,
  ServerType,
} from '../interfaces/IConfig';
import { MICROGONS_PER_ARGON } from '@argonprotocol/mainchain';
import {
  BidAmountAdjustmentType,
  BidAmountFormulaType,
  JsonExt,
  MicronotPriceChangeType,
  SeatGoalInterval,
  SeatGoalType,
} from '@argonprotocol/apps-core';
import { message as tauriMessage } from '@tauri-apps/plugin-dialog';
import { createDeferred, ensureOnlyOneInstance } from './Utils';
import IDeferred from '../interfaces/IDeferred';
import { CurrencyKey } from './Currency';
import { getUserJurisdiction } from './Countries';
import { NETWORK_NAME } from './Env.ts';
import { invokeWithTimeout } from './tauriApi.ts';
import { LocalMachine } from './LocalMachine.ts';
import PluginSql from '@tauri-apps/plugin-sql';
import { ZodAny } from 'zod';
import { WalletKeys } from './WalletKeys.ts';
import { WalletRecoveryFn } from './WalletRecovery.ts';

export class Config implements IConfig {
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
  private _loadedData!: IConfig;
  private _rawData = {} as IConfigStringified;
  private _walletPreviousHistoryLoadPct: number = 0;

  constructor(
    dbPromise: Promise<Db>,
    private _walletKeys: WalletKeys,
    private accountRecoveryFn?: WalletRecoveryFn,
  ) {
    ensureOnlyOneInstance(this.constructor);
    this._loadedDeferred = createDeferred<void>(false);
    this.hasDbMigrationError = false;

    this._dbPromise = dbPromise;
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

  public async restoreToConnection(sql: PluginSql): Promise<void> {
    const preserveFields: (keyof IConfig)[] = [
      'serverCreation',
      'serverDetails',
      'miningAccountAddress',
      'biddingRules',
      'vaultingRules',
      'hasReadVaultingInstructions',
      'hasReadMiningInstructions',
      'isMiningMachineCreated',
      'isPreparingMinerSetup',
      'oldestFrameIdToSync',
      'defaultCurrencyKey',
      'requiresPassword',
    ];

    for (const key of Object.keys(defaults) as (keyof IConfig)[]) {
      this._fieldsToSave.add(key);
      if (!preserveFields.includes(key)) {
        const defaultValue = await defaults[key as keyof IConfigDefaults]();
        this._rawData[key] = JsonExt.stringify(defaultValue, 2);
        (this._loadedData as any)[key] = defaultValue as any;
      }
    }
    await this._injectFirstTimeAppData(this._loadedData, this._rawData, this._fieldsToSave);
    const data = Config.extractDataToSave(this._fieldsToSave, this._rawData);
    await this._db.configTable.insertOrReplace(data, sql);
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

      for (const [key, value] of Object.entries(defaults)) {
        let rawValue = dbRawData[key as keyof typeof dbRawData];
        const schemaField = ConfigSchema.shape[key as keyof IConfig] as unknown as ZodAny | undefined;
        if (schemaField && rawValue !== undefined && rawValue !== '') {
          const data = JsonExt.parse(rawValue as string);
          const isValid = schemaField.safeParse(data);
          if (!isValid?.success) {
            console.warn(`ConfigSchema validation error: ${key}`);
            if (NETWORK_NAME !== 'mainnet') {
              await tauriMessage(
                `A field in your Config (${key}) is corrupted and could not be loaded. ${isValid.error.toString()}`,
                {
                  title: 'Mining Config Migration Issue',
                  kind: 'error',
                },
              );
            }
            dbRawData[key as keyof typeof dbRawData] = undefined;
            rawValue = undefined;
          } else {
            loadedData[key] = isValid.data;
          }
        }
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

      if (this._walletKeys.miningAddress !== loadedData.miningAccountAddress) {
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

    return this._loadedDeferred.promise;
  }

  public get walletAccountsHadPreviousLife(): IConfig['walletAccountsHadPreviousLife'] {
    return this.getField('walletAccountsHadPreviousLife');
  }
  public set walletAccountsHadPreviousLife(value: IConfig['walletAccountsHadPreviousLife']) {
    this.setField('walletAccountsHadPreviousLife', value);
  }

  public get walletPreviousLifeRecovered(): IConfig['walletPreviousLifeRecovered'] {
    return this.getField('walletPreviousLifeRecovered');
  }
  public set walletPreviousLifeRecovered(value: IConfig['walletPreviousLifeRecovered']) {
    this.setField('walletPreviousLifeRecovered', value);
  }

  public get miningAccountPreviousHistory(): IConfig['miningAccountPreviousHistory'] {
    return this.getField('miningAccountPreviousHistory');
  }

  public get miningAccountAddress(): IConfig['miningAccountAddress'] {
    return this.getField('miningAccountAddress');
  }
  public set miningAccountPreviousHistory(value: IConfig['miningAccountPreviousHistory']) {
    this.setField('miningAccountPreviousHistory', value);
  }

  public get isBootingUpPreviousWalletHistory(): boolean {
    return this._loadedData.walletAccountsHadPreviousLife && !this._loadedData.walletPreviousLifeRecovered;
  }

  public get walletPreviousHistoryLoadPct(): number {
    if (!this.isBootingUpPreviousWalletHistory) return 100;
    return Math.min(this._walletPreviousHistoryLoadPct, 100);
  }

  public get panelKey(): PanelKey {
    return this.getField('panelKey');
  }
  public set panelKey(value: PanelKey) {
    this.setField('panelKey', value);
  }

  public get requiresPassword(): boolean {
    return this.getField('requiresPassword');
  }
  public set requiresPassword(value: boolean) {
    this.setField('requiresPassword', value);
  }

  public get showWelcomeOverlay(): boolean {
    return this.getField('showWelcomeOverlay');
  }
  public set showWelcomeOverlay(value: boolean) {
    this.setField('showWelcomeOverlay', value);
  }

  public get serverCreation(): IConfig['serverCreation'] {
    return this.getField('serverCreation');
  }
  public set serverCreation(value: IConfig['serverCreation']) {
    this.setField('serverCreation', value);
  }

  public get serverDetails(): IConfig['serverDetails'] {
    return this.getField('serverDetails');
  }
  public set serverDetails(value: IConfig['serverDetails']) {
    this.setField('serverDetails', value);
  }

  public get installDetails(): IConfig['installDetails'] {
    return this.getField('installDetails');
  }
  public set installDetails(value: IConfig['installDetails']) {
    this.setField('installDetails', value);
  }

  public get oldestFrameIdToSync(): number {
    return this.getField('oldestFrameIdToSync');
  }
  public set oldestFrameIdToSync(value: number) {
    this.setField('oldestFrameIdToSync', value);
  }

  public get latestFrameIdProcessed(): number {
    return this.getField('latestFrameIdProcessed');
  }
  public set latestFrameIdProcessed(value: number) {
    this.setField('latestFrameIdProcessed', value);
  }

  public get hasReadMiningInstructions(): boolean {
    return this.getField('hasReadMiningInstructions');
  }
  public set hasReadMiningInstructions(value: boolean) {
    this.setField('hasReadMiningInstructions', value);
  }

  public get isPreparingMinerSetup(): boolean {
    return this.getField('isPreparingMinerSetup');
  }
  public set isPreparingMinerSetup(value: boolean) {
    this.setField('isPreparingMinerSetup', value);
  }

  public get isMinerReadyToInstall(): boolean {
    return this.getField('isMinerReadyToInstall');
  }
  public set isMinerReadyToInstall(value: boolean) {
    this.setField('isMinerReadyToInstall', value);
  }

  public get isMiningMachineCreated(): boolean {
    return this.getField('isMiningMachineCreated');
  }
  public set isMiningMachineCreated(value: boolean) {
    this.setField('isMiningMachineCreated', value);
  }

  public get isMinerUpToDate(): boolean {
    return this.getField('isMinerUpToDate');
  }
  public set isMinerUpToDate(value: boolean) {
    this.setField('isMinerUpToDate', value);
  }

  public get isMinerInstalled(): boolean {
    return this.getField('isMinerInstalled');
  }
  public set isMinerInstalled(value: boolean) {
    this.setField('isMinerInstalled', value);
  }

  public get isMinerWaitingForUpgradeApproval(): boolean {
    return this.getField('isMinerWaitingForUpgradeApproval');
  }
  public set isMinerWaitingForUpgradeApproval(value: boolean) {
    this.setField('isMinerWaitingForUpgradeApproval', value);
  }

  public get hasReadVaultingInstructions(): boolean {
    return this.getField('hasReadVaultingInstructions');
  }

  public set hasReadVaultingInstructions(value: boolean) {
    this.setField('hasReadVaultingInstructions', value);
  }

  public get isPreparingVaultSetup(): boolean {
    return this.getField('isPreparingVaultSetup');
  }

  public set isPreparingVaultSetup(value: boolean) {
    this.setField('isPreparingVaultSetup', value);
  }

  public get isVaultReadyToCreate(): boolean {
    return this.getField('isVaultReadyToCreate');
  }

  public set isVaultReadyToCreate(value: boolean) {
    this.setField('isVaultReadyToCreate', value);
  }

  public get isVaultActivated(): boolean {
    return this.getField('isVaultActivated');
  }

  public set isVaultActivated(value: boolean) {
    this.setField('isVaultActivated', value);
  }

  public get hasMiningSeats(): boolean {
    return this.getField('hasMiningSeats');
  }

  public set hasMiningSeats(value: boolean) {
    this.setField('hasMiningSeats', value);
  }

  public get hasMiningBids(): boolean {
    return this.getField('hasMiningBids');
  }

  public set hasMiningBids(value: boolean) {
    this.setField('hasMiningBids', value);
  }

  public get biddingRules(): IConfig['biddingRules'] {
    return this.getField('biddingRules');
  }

  public set biddingRules(value: IConfig['biddingRules']) {
    this.setField('biddingRules', value, false);
  }

  public get vaultingRules(): IConfig['vaultingRules'] {
    return this.getField('vaultingRules');
  }

  public set vaultingRules(value: IConfig['vaultingRules']) {
    this.setField('vaultingRules', value, false);
  }

  public get defaultCurrencyKey(): CurrencyKey {
    return this.getField('defaultCurrencyKey');
  }

  public set defaultCurrencyKey(value: CurrencyKey) {
    this.setField('defaultCurrencyKey', value);
  }

  public get userJurisdiction(): IConfig['userJurisdiction'] {
    return this.getField('userJurisdiction');
  }

  public set userJurisdiction(value: IConfig['userJurisdiction']) {
    this.setField('userJurisdiction', value);
  }

  public get isValidJurisdiction(): boolean {
    this._throwErrorIfNotLoaded();
    return this.userJurisdiction.countryCode === 'KY';
  }

  public get hasSavedBiddingRules(): boolean {
    this._throwErrorIfNotLoaded();
    return !!this._rawData[dbFields.biddingRules];
  }

  public get hasSavedVaultingRules(): boolean {
    this._throwErrorIfNotLoaded();
    return !!this._rawData[dbFields.vaultingRules];
  }

  public async saveBiddingRules() {
    this._tryFieldsToSave(dbFields.biddingRules, this.biddingRules);
    await this.save();
  }

  public async saveVaultingRules() {
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

  private getField<T extends keyof IConfig>(field: T): IConfig[T] {
    this._throwErrorIfNotLoaded();
    return this._loadedData[field];
  }

  private setField<T extends keyof IConfig>(field: T, value: IConfig[T], trySaveToDb = true): void {
    this._throwErrorIfNotLoaded();
    this._loadedData[field] = value;
    if (trySaveToDb) {
      this._tryFieldsToSave((dbFields as any)[field], value);
    }
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

    const miningAccountAddress = this._walletKeys.miningAddress;
    loadedData.miningAccountAddress = miningAccountAddress;
    stringifiedData[dbFields.miningAccountAddress] = JsonExt.stringify(miningAccountAddress, 2);
    fieldsToSave.add(dbFields.miningAccountAddress);

    const walletHadPreviousLife = await this._walletKeys.didWalletHavePreviousLife();
    loadedData.walletAccountsHadPreviousLife = walletHadPreviousLife;
    stringifiedData[dbFields.walletAccountsHadPreviousLife] = JsonExt.stringify(walletHadPreviousLife, 2);
    fieldsToSave.add(dbFields.walletAccountsHadPreviousLife);

    if (walletHadPreviousLife) {
      loadedData.showWelcomeOverlay = false;
      stringifiedData[dbFields.showWelcomeOverlay] = JsonExt.stringify(false, 2);
      fieldsToSave.add(dbFields.showWelcomeOverlay);
    }
  }

  private async _bootupFromAccountPreviousHistory() {
    console.log('Config: Booting up from account previous history...');
    if (!this.accountRecoveryFn) {
      throw new Error('Config: No account recovery function provided');
    }

    const { miningHistory, vaultingRules } = await this.accountRecoveryFn(pct => {
      this._walletPreviousHistoryLoadPct = pct;
    });
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
      this.isVaultActivated = true;
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
      argonCirculationGrowthPctMax: 0,

      argonotPriceChangeType: MicronotPriceChangeType.Between,
      argonotPriceChangePctMin: 0,
      argonotPriceChangePctMax: 0,

      startingBidFormulaType: BidAmountFormulaType.PreviousDayLow,
      startingBidAdjustmentType: BidAmountAdjustmentType.Relative,
      startingBidCustom: 0n * BigInt(MICROGONS_PER_ARGON),
      startingBidAdjustAbsolute: 0n * BigInt(MICROGONS_PER_ARGON),
      startingBidAdjustRelative: 0,

      rebiddingDelay: 1,
      rebiddingIncrementBy: 10n * BigInt(MICROGONS_PER_ARGON),

      maximumBidFormulaType: BidAmountFormulaType.BreakevenAtSlowGrowth,
      maximumBidAdjustmentType: BidAmountAdjustmentType.Relative,
      maximumBidCustom: 0n,
      maximumBidAdjustAbsolute: 0n,
      maximumBidAdjustRelative: -1.0,

      seatGoalType: SeatGoalType.Min,
      seatGoalCount: 1,
      seatGoalPercent: 0,
      seatGoalInterval: SeatGoalInterval.Epoch,

      initialMicrogonRequirement: 0n,
      initialMicronotRequirement: 0n,
      initialCapitalCommitment: undefined,

      sidelinedMicronots: 0n,
      sidelinedMicrogons: 0n,
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
  userJurisdiction: async () => {
    try {
      return await getUserJurisdiction();
    } catch (error) {
      console.error('Error getting user jurisdiction:', error);
      return {
        ipAddress: '',
        city: '',
        region: '',
        countryName: '',
        countryCode: '',
        latitude: '',
        longitude: '',
      };
    }
  },
};
