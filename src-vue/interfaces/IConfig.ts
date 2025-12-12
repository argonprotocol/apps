import { z } from 'zod';
import { BiddingRulesSchema } from '@argonprotocol/apps-core';
import { VaultingRulesSchema } from './IVaultingRules';
import { CurrencyKey } from '../lib/Currency';

export enum InstallStepKey {
  ServerConnect = 'ServerConnect',
  FileUpload = 'FileUpload',
  UbuntuCheck = 'UbuntuCheck',
  DockerInstall = 'DockerInstall',
  BitcoinInstall = 'BitcoinInstall',
  ArgonInstall = 'ArgonInstall',
  MiningLaunch = 'MiningLaunch',
}

export enum InstallStepErrorType {
  Unknown = 'Unknown',
  ServerConnect = InstallStepKey.ServerConnect,
  FileUpload = InstallStepKey.FileUpload,
  UbuntuCheck = InstallStepKey.UbuntuCheck,
  DockerInstall = InstallStepKey.DockerInstall,
  BitcoinInstall = InstallStepKey.BitcoinInstall,
  ArgonInstall = InstallStepKey.ArgonInstall,
  MiningLaunch = InstallStepKey.MiningLaunch,
}

export enum InstallStepStatus {
  Pending = 'Pending',
  Working = 'Working',
  Completing = 'Completing',
  Completed = 'Completed',
  Failed = 'Failed',
  Hidden = 'Hidden',
}

export enum ScreenKey {
  Home = 'Home',
  Mining = 'Mining',
  Vaulting = 'Vaulting',
}

export enum ServerType {
  DigitalOcean = 'DigitalOcean',
  CustomServer = 'CustomServer',
  LocalComputer = 'LocalComputer',
}

export const ConfigServerCreationDigitalOceanSchema = z.object({
  apiKey: z.string(),
});
export const ConfigServerCreationLocalComputerSchema = z.object({});
export const ConfigServerCreationCustomServerSchema = z.object({
  port: z.number(),
  sshUser: z.string(),
  ipAddress: z.string().ip().or(z.literal('')),
  hasRunningBot: z.boolean().optional(),
});

export const ConfigServerCreationSchema = z.object({
  localComputer: ConfigServerCreationLocalComputerSchema.optional(),
  digitalOcean: ConfigServerCreationDigitalOceanSchema.optional(),
  customServer: ConfigServerCreationCustomServerSchema.optional(),
});

export const ConfigServerDetailsSchema = z.object({
  ipAddress: z.string().ip().or(z.literal('')),
  port: z.number().optional(),
  sshUser: z.string(),
  type: z.nativeEnum(ServerType),
  workDir: z.string(),
});

export const ConfigInstallStep = z.object({
  progress: z.number(),
  status: z.nativeEnum(InstallStepStatus),
  startDate: z.string().nullable(),
});

export const ConfigInstallDetailsSchema = z.object({
  [InstallStepKey.ServerConnect]: ConfigInstallStep,
  [InstallStepKey.FileUpload]: ConfigInstallStep,
  [InstallStepKey.UbuntuCheck]: ConfigInstallStep,
  [InstallStepKey.DockerInstall]: ConfigInstallStep,
  [InstallStepKey.BitcoinInstall]: ConfigInstallStep,
  [InstallStepKey.ArgonInstall]: ConfigInstallStep,
  [InstallStepKey.MiningLaunch]: ConfigInstallStep,
  errorType: z.nativeEnum(InstallStepErrorType).nullable(),
  errorMessage: z.string().nullable(),
  isRunning: z.boolean(),
});

export const ConfigSyncDetailsSchema = z.object({
  progress: z.number(),
  startDate: z.string().nullable(),
  startPosition: z.number().nullable(),
  errorType: z.string().nullable(),
  errorMessage: z.string().nullable(),
});

export const MiningAccountPreviousHistoryBidSchema = z.object({
  bidPosition: z.number(),
  microgonsBid: z.bigint(),
  micronotsStaked: z.bigint(),
});

export const MiningAccountPreviousHistorySeatSchema = z.object({
  seatPosition: z.number(),
  microgonsBid: z.bigint(),
  micronotsStaked: z.bigint(),
});

export const MiningAccountPreviousHistoryRecordSchema = z.object({
  frameId: z.number(),
  bids: z.array(MiningAccountPreviousHistoryBidSchema),
  seats: z.array(MiningAccountPreviousHistorySeatSchema),
});

// ---- Main Schema ---- //

export const ConfigSchema = z.object({
  screenKey: z.nativeEnum(ScreenKey),
  version: z.string(),
  requiresPassword: z.boolean(),
  showWelcomeOverlay: z.boolean(),

  serverCreation: ConfigServerCreationSchema.optional(),
  serverDetails: ConfigServerDetailsSchema,
  installDetails: ConfigInstallDetailsSchema,
  oldestFrameIdToSync: z.number(),
  latestFrameIdProcessed: z.number(),

  walletAccountsHadPreviousLife: z.boolean(),
  walletPreviousLifeRecovered: z.boolean(),
  miningAccountPreviousHistory: z.array(MiningAccountPreviousHistoryRecordSchema).nullable(),

  hasReadMiningInstructions: z.boolean(),
  isPreparingMinerSetup: z.boolean(),
  isMinerReadyToInstall: z.boolean(), // isConnected
  isMiningMachineCreated: z.boolean(), // isMiningMachineCreated
  isMinerInstalled: z.boolean(), // isNewServer
  isMinerInstalling: z.boolean(), // isInstalling

  hasReadVaultingInstructions: z.boolean(),
  isPreparingVaultSetup: z.boolean(),
  isVaultReadyToCreate: z.boolean(),
  isVaultActivated: z.boolean(),

  hasMiningSeats: z.boolean(), // hasMiningSeats
  hasMiningBids: z.boolean(), // hasMiningBids
  biddingRules: BiddingRulesSchema,
  vaultingRules: VaultingRulesSchema,

  defaultCurrencyKey: z.nativeEnum(CurrencyKey),
  userJurisdiction: z.object({
    ipAddress: z.string(),
    city: z.string(),
    region: z.string(),
    countryName: z.string(),
    countryCode: z.string(),
    latitude: z.string(),
    longitude: z.string(),
  }),
});

// ---- Optional Type Inference ---- //

export type IMiningAccountPreviousHistoryBid = z.infer<typeof MiningAccountPreviousHistoryBidSchema>;
export type IMiningAccountPreviousHistorySeat = z.infer<typeof MiningAccountPreviousHistorySeatSchema>;
export type IMiningAccountPreviousHistoryRecord = z.infer<typeof MiningAccountPreviousHistoryRecordSchema>;

export type IConfigServerCreationDigitalOcean = z.infer<typeof ConfigServerCreationDigitalOceanSchema>;
export type IConfigServerCreationLocalComputer = z.infer<typeof ConfigServerCreationLocalComputerSchema>;
export type IConfigServerCreationCustomServer = z.infer<typeof ConfigServerCreationCustomServerSchema>;
export type IConfigServerCreation = z.infer<typeof ConfigServerCreationSchema>;

export type IConfigServerDetails = z.infer<typeof ConfigServerDetailsSchema>;
export type IConfigInstallDetails = z.infer<typeof ConfigInstallDetailsSchema>;
export type IConfigInstallStep = z.infer<typeof ConfigInstallStep>;
export type IConfigSyncDetails = z.infer<typeof ConfigSyncDetailsSchema>;
export type IConfig = z.infer<typeof ConfigSchema>;

export type IConfigStringified = {
  [K in keyof IConfig]: string;
};

export interface IConfigDefaults {
  screenKey: () => IConfig['screenKey'];
  requiresPassword: () => IConfig['requiresPassword'];
  showWelcomeOverlay: () => IConfig['showWelcomeOverlay'];

  serverCreation: () => IConfig['serverCreation'];
  serverDetails: () => IConfig['serverDetails'];
  installDetails: () => IConfig['installDetails'];
  oldestFrameIdToSync: () => IConfig['oldestFrameIdToSync'];
  latestFrameIdProcessed: () => IConfig['latestFrameIdProcessed'];
  walletAccountsHadPreviousLife: () => IConfig['walletAccountsHadPreviousLife'];
  walletPreviousLifeRecovered: () => IConfig['walletPreviousLifeRecovered'];
  miningAccountPreviousHistory: () => IConfig['miningAccountPreviousHistory'];

  hasReadMiningInstructions: () => IConfig['hasReadMiningInstructions'];
  isPreparingMinerSetup: () => IConfig['isPreparingMinerSetup'];
  isMinerReadyToInstall: () => IConfig['isMinerReadyToInstall'];
  isMiningMachineCreated: () => IConfig['isMiningMachineCreated'];
  isMinerInstalled: () => IConfig['isMinerInstalled'];
  isMinerInstalling: () => IConfig['isMinerInstalling'];

  hasReadVaultingInstructions: () => IConfig['hasReadVaultingInstructions'];
  isPreparingVaultSetup: () => IConfig['isPreparingVaultSetup'];
  isVaultReadyToCreate: () => IConfig['isVaultReadyToCreate'];
  isVaultActivated: () => IConfig['isVaultActivated'];

  hasMiningSeats: () => IConfig['hasMiningSeats'];
  hasMiningBids: () => IConfig['hasMiningBids'];
  biddingRules: () => IConfig['biddingRules'];
  vaultingRules: () => IConfig['vaultingRules'];
  defaultCurrencyKey: () => IConfig['defaultCurrencyKey'];
  userJurisdiction: () => Promise<IConfig['userJurisdiction']>;
}
