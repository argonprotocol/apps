import { z } from 'zod';
import { BiddingRulesSchema } from '@argonprotocol/apps-core';
import { VaultingRulesSchema } from './IVaultingRules';
import { UnitOfMeasurement, ICurrencyKey } from '../lib/Currency';

const CurrencyKeySchema = z
  .nativeEnum(UnitOfMeasurement)
  .refine(
    (val): val is ICurrencyKey =>
      val === UnitOfMeasurement.ARGN ||
      val === UnitOfMeasurement.USD ||
      val === UnitOfMeasurement.EUR ||
      val === UnitOfMeasurement.GBP ||
      val === UnitOfMeasurement.INR,
  );

const HostOrIpSchema = z
  .string()
  .refine(value => value === '' || !/^[a-z]+:\/\//i.test(value), 'Must not include a protocol prefix');

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

export enum MiningSetupStatus {
  None = 'None',
  Checklist = 'Checklist',
  Installing = 'Installing',
  Finished = 'Finished',
}

export enum VaultingSetupStatus {
  None = 'None',
  Checklist = 'Checklist',
  Installing = 'Installing',
  Finished = 'Finished',
}

export enum ServerType {
  DigitalOcean = 'DigitalOcean',
  CustomServer = 'CustomServer',
  LocalComputer = 'LocalComputer',
}

export enum BootstrapType {
  Private = 'Private',
  Public = 'Public',
}

export const ConfigServerAddDigitalOceanSchema = z.object({
  apiKey: z.string(),
});
export const ConfigServerAddLocalComputerSchema = z.object({});
export const ConfigServerAddCustomServerSchema = z.object({
  port: z.number(),
  sshUser: z.string(),
  ipAddress: z.string().ip().or(z.literal('')),
  hasRunningBot: z.boolean().optional(),
});

export const ConfigServerAddSchema = z.object({
  localComputer: ConfigServerAddLocalComputerSchema.optional(),
  digitalOcean: ConfigServerAddDigitalOceanSchema.optional(),
  customServer: ConfigServerAddCustomServerSchema.optional(),
});

export const ConfigServerDetailsSchema = z.object({
  ipAddress: z.string().ip().or(z.literal('')),
  port: z.number().optional(),
  sshUser: z.string(),
  type: z.nativeEnum(ServerType),
  workDir: z.string(),
});

export const ConfigCertificationDetailsSchema = z.object({
  hasSavedMnemonic: z.boolean(),
  hasVault: z.boolean(),
  hasUniswapTransfer: z.boolean(),
  hasTreasuryBondParticipation: z.boolean(),
  hasFirstMiningSeat: z.boolean(),
  hasSecondMiningSeat: z.boolean(),
  hasBitcoinLock: z.boolean(),
  showBonusTooltip: z.boolean().optional(),
});

export const ConfigInstallerStep = z.object({
  progress: z.number(),
  status: z.nativeEnum(InstallStepStatus),
  startDate: z.date().nullable(),
});

export const ConfigServerInstallerSchema = z.object({
  [InstallStepKey.ServerConnect]: ConfigInstallerStep,
  [InstallStepKey.FileUpload]: ConfigInstallerStep,
  [InstallStepKey.UbuntuCheck]: ConfigInstallerStep,
  [InstallStepKey.DockerInstall]: ConfigInstallerStep,
  [InstallStepKey.BitcoinInstall]: ConfigInstallerStep,
  [InstallStepKey.ArgonInstall]: ConfigInstallerStep,
  [InstallStepKey.MiningLaunch]: ConfigInstallerStep,
  errorType: z.nativeEnum(InstallStepErrorType).nullable(),
  errorMessage: z.string().nullable(),
  isRunning: z.boolean(),
});

export const ConfigBootstrapDetailsSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal(BootstrapType.Private),
    ipAddress: HostOrIpSchema,
    inviteCode: z.string(),
    privateKey: z.string(),
  }),
  z.object({
    type: z.literal(BootstrapType.Public),
    ipAddress: HostOrIpSchema,
    inviteCode: z.string().optional(),
    privateKey: z.string().optional(),
  }),
]);

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

export const UpstreamOperatorSchema = z.object({
  name: z.string(),
  vaultId: z.number(),
  inviteCode: z.string(),
});

// ---- Main Schema ---- //

export const ConfigSchema = z.object({
  version: z.string(),

  requiresPassword: z.boolean(),
  bootstrapDetails: ConfigBootstrapDetailsSchema.optional(),

  upstreamOperator: UpstreamOperatorSchema.optional(),

  miningSetupStatus: z.nativeEnum(MiningSetupStatus),
  vaultingSetupStatus: z.nativeEnum(VaultingSetupStatus),

  serverAdd: ConfigServerAddSchema.optional(),
  serverDetails: ConfigServerDetailsSchema,
  serverInstaller: ConfigServerInstallerSchema,
  oldestFrameIdToSync: z.number(),
  latestFrameIdProcessed: z.number(),

  walletAccountsHadPreviousLife: z.boolean(),
  walletPreviousLifeRecovered: z.boolean(),
  miningBotAccountPreviousHistory: z.array(MiningAccountPreviousHistoryRecordSchema).nullable(),

  isServerInstalled: z.boolean(), // is set once after first install
  isServerInstalling: z.boolean(), // is true whenever the Installer is running

  hasProfileName: z.boolean(),

  hasMiningSeats: z.boolean(),
  hasMiningBids: z.boolean(),
  biddingRules: BiddingRulesSchema,
  vaultingRules: VaultingRulesSchema,

  defaultCurrencyKey: CurrencyKeySchema,
  userJurisdiction: z.object({
    ipAddress: z.string(),
    city: z.string(),
    region: z.string(),
    countryName: z.string(),
    countryCode: z.string(),
    latitude: z.string(),
    longitude: z.string(),
  }),
  certificationDetails: ConfigCertificationDetailsSchema.optional(),
});

// ---- Optional Type Inference ---- //

export type IMiningAccountPreviousHistoryBid = z.infer<typeof MiningAccountPreviousHistoryBidSchema>;
export type IMiningAccountPreviousHistorySeat = z.infer<typeof MiningAccountPreviousHistorySeatSchema>;
export type IMiningAccountPreviousHistoryRecord = z.infer<typeof MiningAccountPreviousHistoryRecordSchema>;

export type IConfigServerAddDigitalOcean = z.infer<typeof ConfigServerAddDigitalOceanSchema>;
export type IConfigServerAddLocalComputer = z.infer<typeof ConfigServerAddLocalComputerSchema>;
export type IConfigServerAddCustomServer = z.infer<typeof ConfigServerAddCustomServerSchema>;
export type IConfigServerAdd = z.infer<typeof ConfigServerAddSchema>;

export type IConfigCertificationDetailsSchema = z.infer<typeof ConfigCertificationDetailsSchema>;

export type IConfigServerDetails = z.infer<typeof ConfigServerDetailsSchema>;
export type IConfigServerInstallDetails = z.infer<typeof ConfigServerInstallerSchema>;
export type IConfigInstallStep = z.infer<typeof ConfigInstallerStep>;
export type IConfigSyncDetails = z.infer<typeof ConfigSyncDetailsSchema>;
export type IConfig = z.infer<typeof ConfigSchema>;

export type IConfigStringified = {
  [K in keyof IConfig]: string;
};

export type IConnectedVault = z.infer<typeof UpstreamOperatorSchema>;

export interface IConfigDefaults {
  requiresPassword: () => IConfig['requiresPassword'];
  bootstrapDetails: () => IConfig['bootstrapDetails'];
  upstreamOperator: () => IConfig['upstreamOperator'];

  miningSetupStatus: () => IConfig['miningSetupStatus'];
  vaultingSetupStatus: () => IConfig['vaultingSetupStatus'];

  serverAdd: () => IConfig['serverAdd'];
  serverDetails: () => IConfig['serverDetails'];
  serverInstaller: () => IConfig['serverInstaller'];
  oldestFrameIdToSync: () => IConfig['oldestFrameIdToSync'];
  latestFrameIdProcessed: () => IConfig['latestFrameIdProcessed'];
  walletAccountsHadPreviousLife: () => IConfig['walletAccountsHadPreviousLife'];
  walletPreviousLifeRecovered: () => IConfig['walletPreviousLifeRecovered'];
  miningBotAccountPreviousHistory: () => IConfig['miningBotAccountPreviousHistory'];

  isServerInstalled: () => IConfig['isServerInstalled'];
  isServerInstalling: () => IConfig['isServerInstalling'];

  hasProfileName: () => IConfig['hasProfileName'];

  hasMiningSeats: () => IConfig['hasMiningSeats'];
  hasMiningBids: () => IConfig['hasMiningBids'];
  biddingRules: () => IConfig['biddingRules'];
  vaultingRules: () => IConfig['vaultingRules'];
  defaultCurrencyKey: () => IConfig['defaultCurrencyKey'];
  userJurisdiction: () => Promise<IConfig['userJurisdiction']>;
  certificationDetails: () => IConfig['certificationDetails'];
}
