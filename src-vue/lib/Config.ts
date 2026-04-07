import packageJson from '../../package.json';
import { Db } from './Db';
import {
  ConfigSchema,
  IConfig,
  IConfigCertificationDetailsSchema,
  IConfigDefaults,
  IConfigStringified,
  InstallStepKey,
  InstallStepStatus,
  MiningSetupStatus,
  ServerType,
  VaultingSetupStatus,
} from '../interfaces/IConfig';
import { MICROGONS_PER_ARGON } from '@argonprotocol/mainchain';
import {
  BidAmountAdjustmentType,
  BidAmountFormulaType,
  createDeferred,
  ICurrencyKey,
  type IDeferred,
  JsonExt,
  MicronotPriceChangeType,
  SeatGoalInterval,
  SeatGoalType,
} from '@argonprotocol/apps-core';
import { message as tauriMessage } from '@tauri-apps/plugin-dialog';
import { ensureOnlyOneInstance } from './Utils';
import { UnitOfMeasurement } from './Currency';
import { getUserJurisdiction } from './Countries';
import { IS_STABLE_BUILD, IS_TEST, NETWORK_NAME, NETWORK_URL } from './Env.ts';
import { invokeWithTimeout } from './tauriApi.ts';
import { LocalMachine } from './LocalMachine.ts';
import PluginSql from '@tauri-apps/plugin-sql';
import { ZodAny } from 'zod';
import { WalletKeys } from './WalletKeys.ts';
import { WalletRecoveryFn } from './WalletRecovery.ts';

const BOOTSTRAP_NETWORK_PLACEHOLDER = 'ARGON_NETWORK_NAME';

function stripSocketProtocol(value: string): string {
  return value.replace(/^wss?:\/\//i, '');
}

export class Config implements IConfig {
  public readonly version: string = packageJson.version;

  public get isLoaded(): boolean {
    return this._loadedDeferred.isSettled;
  }
  public get isLoadedPromise(): Promise<void> {
    return this._loadedDeferred.promise;
  }
  public hasDbMigrationError: boolean;
  public isRestarting: boolean;

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
    this.isRestarting = false;

    this._dbPromise = dbPromise;
    this._loadedData = {
      version: packageJson.version,
      requiresPassword: false,
      ethereumRpcUrl: Config.getDefault(dbFields.ethereumRpcUrl) as IConfig['ethereumRpcUrl'],
      serverDetails: {
        ipAddress: '',
        sshUser: '',
        type: ServerType.DigitalOcean,
        workDir: '~',
      },
      miningSetupStatus: Config.getDefault(dbFields.miningSetupStatus) as MiningSetupStatus,
      vaultingSetupStatus: Config.getDefault(dbFields.vaultingSetupStatus) as VaultingSetupStatus,
      serverInstaller: Config.getDefault(dbFields.serverInstaller) as IConfig['serverInstaller'],
      oldestFrameIdToSync: Config.getDefault(dbFields.oldestFrameIdToSync) as number,
      latestFrameIdProcessed: Config.getDefault(dbFields.latestFrameIdProcessed) as number,
      walletAccountsHadPreviousLife: Config.getDefault(dbFields.walletAccountsHadPreviousLife) as boolean,
      walletPreviousLifeRecovered: Config.getDefault(dbFields.walletPreviousLifeRecovered) as boolean,
      miningBotAccountPreviousHistory: Config.getDefault(
        dbFields.miningBotAccountPreviousHistory,
      ) as IConfig['miningBotAccountPreviousHistory'],

      isServerInstalled: Config.getDefault(dbFields.isServerInstalled) as boolean,
      isServerInstalling: Config.getDefault(dbFields.isServerInstalling) as boolean,

      hasProfileName: Config.getDefault(dbFields.hasProfileName) as boolean,

      hasMiningSeats: Config.getDefault(dbFields.hasMiningSeats) as boolean,
      hasMiningBids: Config.getDefault(dbFields.hasMiningBids) as boolean,
      biddingRules: Config.getDefault(dbFields.biddingRules) as IConfig['biddingRules'],
      vaultingRules: Config.getDefault(dbFields.vaultingRules) as IConfig['vaultingRules'],
      defaultCurrencyKey: Config.getDefault(dbFields.defaultCurrencyKey) as ICurrencyKey,
      userJurisdiction: {
        ipAddress: '',
        city: '',
        region: '',
        countryName: '',
        countryCode: '',
        latitude: '',
        longitude: '',
      },
      certificationDetails: Config.getDefault(dbFields.certificationDetails) as IConfig['certificationDetails'],
    };
  }

  public async restoreToConnection(sql: PluginSql): Promise<void> {
    const preserveFields: (keyof IConfig)[] = [
      'upstreamOperator',
      'bootstrapDetails',
      'serverAdd',
      'serverDetails',
      'biddingRules',
      'vaultingRules',
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
      const rawData = {} as IConfigStringified;

      const dbRawData = await db.configTable.fetchAllAsObject();

      if (db.hasMigrationError) {
        this.hasDbMigrationError = true;
      }

      for (const [key, value] of Object.entries(defaults)) {
        let rawValue = dbRawData[key as keyof typeof dbRawData];
        if (key === dbFields.bootstrapDetails && rawValue !== undefined && rawValue !== '') {
          const bootstrapDetails = JsonExt.parse(rawValue as string);
          const resolvedIpAddress =
            bootstrapDetails?.routerHost === BOOTSTRAP_NETWORK_PLACEHOLDER
              ? stripSocketProtocol(NETWORK_URL)
              : stripSocketProtocol(bootstrapDetails?.routerHost ?? '');
          if (bootstrapDetails && bootstrapDetails.routerHost !== resolvedIpAddress) {
            bootstrapDetails.routerHost = resolvedIpAddress;
            rawValue = JsonExt.stringify(bootstrapDetails, 2);
            dbRawData[key as keyof typeof dbRawData] = rawValue as any;
            rawData[key as keyof typeof rawData] = rawValue;
            fieldsToSave.add(key);
          }
        }
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

      const isLocalComputer = loadedData.serverDetails.type === ServerType.LocalComputer;
      if (isLocalComputer && !loadedData.isServerInstalling) {
        const { sshPort } = await LocalMachine.activate();
        if (!IS_TEST && IS_STABLE_BUILD) {
          await invokeWithTimeout('toggle_nosleep', { enable: true }, 5000);
        }
        loadedData.serverDetails.ipAddress = `127.0.0.1`;
        loadedData.serverDetails.port = sshPort;
        fieldsToSave.add(dbFields.serverDetails);
        rawData[dbFields.serverDetails] = JsonExt.stringify(loadedData.serverDetails, 2);
      }
      const dataToSave = Config.extractDataToSave(fieldsToSave, rawData);
      await db.configTable.insertOrReplace(dataToSave);

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

  public get miningBotAccountPreviousHistory(): IConfig['miningBotAccountPreviousHistory'] {
    return this.getField('miningBotAccountPreviousHistory');
  }

  public set miningBotAccountPreviousHistory(value: IConfig['miningBotAccountPreviousHistory']) {
    this.setField('miningBotAccountPreviousHistory', value);
  }

  public get isBootingUpPreviousWalletHistory(): boolean {
    return this._loadedData.walletAccountsHadPreviousLife && !this._loadedData.walletPreviousLifeRecovered;
  }

  public get walletPreviousHistoryLoadPct(): number {
    if (!this.isBootingUpPreviousWalletHistory) return 100;
    return Math.min(this._walletPreviousHistoryLoadPct, 100);
  }

  public get miningSetupStatus(): MiningSetupStatus {
    return this.getField('miningSetupStatus');
  }
  public set miningSetupStatus(value: MiningSetupStatus) {
    this.setField('miningSetupStatus', value);
  }

  public get vaultingSetupStatus(): VaultingSetupStatus {
    return this.getField('vaultingSetupStatus');
  }
  public set vaultingSetupStatus(value: VaultingSetupStatus) {
    this.setField('vaultingSetupStatus', value);
  }

  public get requiresPassword(): boolean {
    return this.getField('requiresPassword');
  }
  public set requiresPassword(value: boolean) {
    this.setField('requiresPassword', value);
  }

  public get ethereumRpcUrl(): IConfig['ethereumRpcUrl'] {
    return this.getField('ethereumRpcUrl');
  }
  public set ethereumRpcUrl(value: IConfig['ethereumRpcUrl']) {
    this.setField('ethereumRpcUrl', value);
  }

  public get showWelcomeOverlay(): boolean {
    const bootstrapDetails = this.getField('bootstrapDetails');
    return !bootstrapDetails && !this.isRestarting;
  }

  public get bootstrapDetails(): IConfig['bootstrapDetails'] {
    return this.getField('bootstrapDetails');
  }
  public set bootstrapDetails(value: IConfig['bootstrapDetails']) {
    this.setField('bootstrapDetails', value);
  }

  public get serverAdd(): IConfig['serverAdd'] {
    return this.getField('serverAdd');
  }
  public set serverAdd(value: IConfig['serverAdd']) {
    this.setField('serverAdd', value);
  }

  public get serverDetails(): IConfig['serverDetails'] {
    return this.getField('serverDetails');
  }
  public set serverDetails(value: IConfig['serverDetails']) {
    this.setField('serverDetails', value);
  }

  public get serverInstaller(): IConfig['serverInstaller'] {
    return this.getField('serverInstaller');
  }
  public set serverInstaller(value: IConfig['serverInstaller']) {
    this.setField('serverInstaller', value);
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

  public get isServerInstalled(): boolean {
    return this.getField('isServerInstalled');
  }
  public set isServerInstalled(value: boolean) {
    this.setField('isServerInstalled', value);
  }

  public get isServerAdded(): boolean {
    const serverAdd = this.getField('serverAdd');
    const serverDetails = this.getField('serverDetails');
    const isServerInstalled = this.getField('isServerInstalled');
    const hasServerIp = !!serverDetails?.ipAddress && serverDetails.ipAddress !== '0.0.0.0';
    return isServerInstalled || hasServerIp || (serverAdd ? !!Object.keys(serverAdd).length : false);
  }

  public get isServerInstalling(): boolean {
    return this.getField('isServerInstalling');
  }
  public set isServerInstalling(value: boolean) {
    this.setField('isServerInstalling', value);
  }

  public get hasProfileName(): boolean {
    return this.getField('hasProfileName');
  }
  public set hasProfileName(value: boolean) {
    this.setField('hasProfileName', value);
  }

  public get certificationDetails(): IConfig['certificationDetails'] {
    return this.getField('certificationDetails');
  }

  public set certificationDetails(value: IConfig['certificationDetails']) {
    this.setField('certificationDetails', value);
  }

  public setCertificationDetails(
    certificationDetails: Partial<IConfigCertificationDetailsSchema>,
  ): IConfigCertificationDetailsSchema {
    this.certificationDetails = {
      hasSavedMnemonic: false,
      hasVault: false,
      hasUniswapTransfer: false,
      hasTreasuryBondParticipation: false,
      hasFirstMiningSeat: false,
      hasSecondMiningSeat: false,
      hasBitcoinLock: false,
      showBonusTooltip: true,
      ...(this.certificationDetails || {}),
      ...certificationDetails,
    };
    return this.certificationDetails;
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

  public get upstreamOperator(): IConfig['upstreamOperator'] {
    return this.getField('upstreamOperator');
  }

  public set upstreamOperator(value: IConfig['upstreamOperator']) {
    this.setField('upstreamOperator', value);
  }

  public get defaultCurrencyKey(): ICurrencyKey {
    return this.getField('defaultCurrencyKey');
  }

  public set defaultCurrencyKey(value: ICurrencyKey) {
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

    const walletHadPreviousLife = await this._walletKeys.didWalletHavePreviousLife();
    loadedData.walletAccountsHadPreviousLife = walletHadPreviousLife;
    stringifiedData[dbFields.walletAccountsHadPreviousLife] = JsonExt.stringify(walletHadPreviousLife, 2);
    fieldsToSave.add(dbFields.walletAccountsHadPreviousLife);

    if (walletHadPreviousLife) {
      // TODO: Need to set bootstrapDetails
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
      this.miningBotAccountPreviousHistory = miningHistory;
      this.miningSetupStatus = MiningSetupStatus.Checklist;
      if (this.serverDetails.ipAddress) {
        this.miningSetupStatus = MiningSetupStatus.Finished;
        this.miningBotAccountPreviousHistory = null;
      }
    }

    if (this.serverDetails.ipAddress) {
      this.isServerInstalled = true;
      this.isServerInstalling = false;
      this.setCertificationDetails({ showBonusTooltip: false });
    }

    if (vaultingRules) {
      console.log('Config: Previous vaulting rules found');
      this.vaultingRules = vaultingRules;
      this.vaultingSetupStatus = VaultingSetupStatus.Finished;

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
  miningSetupStatus: 'miningSetupStatus',
  vaultingSetupStatus: 'vaultingSetupStatus',

  requiresPassword: 'requiresPassword',
  ethereumRpcUrl: 'ethereumRpcUrl',
  bootstrapDetails: 'bootstrapDetails',
  upstreamOperator: 'upstreamOperator',

  serverAdd: 'serverAdd',
  serverDetails: 'serverDetails',
  serverInstaller: 'serverInstaller',
  oldestFrameIdToSync: 'oldestFrameIdToSync',
  latestFrameIdProcessed: 'latestFrameIdProcessed',
  miningBotAccountPreviousHistory: 'miningBotAccountPreviousHistory',
  walletAccountsHadPreviousLife: 'walletAccountsHadPreviousLife',
  walletPreviousLifeRecovered: 'walletPreviousLifeRecovered',

  isServerInstalled: 'isServerInstalled',
  isServerInstalling: 'isServerInstalling',

  hasProfileName: 'hasProfileName',

  hasMiningSeats: 'hasMiningSeats',
  hasMiningBids: 'hasMiningBids',
  biddingRules: 'biddingRules',
  vaultingRules: 'vaultingRules',
  defaultCurrencyKey: 'defaultCurrencyKey',
  userJurisdiction: 'userJurisdiction',
  certificationDetails: 'certificationDetails',
} as const;

const defaults: IConfigDefaults = {
  miningSetupStatus: () => MiningSetupStatus.None,
  vaultingSetupStatus: () => VaultingSetupStatus.None,

  requiresPassword: () => false,
  ethereumRpcUrl: () => undefined,
  bootstrapDetails: () => undefined,
  upstreamOperator: () => undefined,

  serverAdd: () => undefined,
  serverDetails: () => {
    return {
      ipAddress: '',
      sshUser: 'root',
      type: ServerType.DigitalOcean,
      workDir: '~',
    };
  },
  serverInstaller: () => {
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
  miningBotAccountPreviousHistory: () => null,
  walletAccountsHadPreviousLife: () => false,
  walletPreviousLifeRecovered: () => false,

  isServerInstalled: () => false,
  isServerInstalling: () => false,

  hasProfileName: () => false,

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
      capitalForSecuritizationPct: 100,
      capitalForTreasuryPct: 0,
      securitizationRatio: 1,
      profitSharingPct: 10,
      btcFlatFee: 2n * BigInt(MICROGONS_PER_ARGON),
      btcPctFee: 5,

      btcUtilizationPctMin: 50,
      btcUtilizationPctMax: 100,

      poolUtilizationPctMin: 50,
      poolUtilizationPctMax: 100,

      personalBtcPct: 0,

      baseMicrogonCommitment: 2_000n * BigInt(MICROGONS_PER_ARGON),
      baseMicronotCommitment: 0n,
    };
  },
  defaultCurrencyKey: () => UnitOfMeasurement.ARGN,
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
  certificationDetails: () => undefined,
};
