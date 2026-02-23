import { InstallStepKey, InstallStepStatus } from '../interfaces/IConfig';
import { SERVER_ENV_VARS } from './Env.ts';

type IStepLabelList = [string, string, string];

export interface IStepLabel {
  key: InstallStepKey;
  templates?: IStepLabelList;
  options: IStepLabelList;
}

const serverConnectTemplates: IStepLabelList = [
  `Connect to {IP_ADDRESS}`,
  `Connecting to {IP_ADDRESS}`,
  `Connected to {IP_ADDRESS}`,
];

export const stepLabels: IStepLabel[] = [
  {
    key: InstallStepKey.ServerConnect,
    templates: serverConnectTemplates,
    options: serverConnectTemplates.map(x => x.replace('{IP_ADDRESS}', 'Server')) as IStepLabelList,
  },
  {
    key: InstallStepKey.FileUpload,
    options: [
      `Upload Core Server Files`,
      `Uploading Core Server Files`,
      `Uploaded Core Server Files`,
    ] as IStepLabelList,
  },
  {
    key: InstallStepKey.UbuntuCheck,
    options: [`Check Ubuntu 24.04`, `Checking Ubuntu 24.04`, `Checked Ubuntu 24.04`],
  },
  {
    key: InstallStepKey.DockerInstall,
    options: [`Set Up Docker v27+`, `Setting Up Docker v27+`, `Setup Docker v27+`],
  },
  {
    key: InstallStepKey.BitcoinInstall,
    options: [
      `Install Bitcoin v${SERVER_ENV_VARS.BITCOIN_VERSION}`,
      `Installing Bitcoin v${SERVER_ENV_VARS.BITCOIN_VERSION}`,
      `Installed Bitcoin v${SERVER_ENV_VARS.BITCOIN_VERSION}`,
    ],
  },
  {
    key: InstallStepKey.ArgonInstall,
    options: [
      `Install Argon ${SERVER_ENV_VARS.ARGON_VERSION}`,
      `Installing Argon ${SERVER_ENV_VARS.ARGON_VERSION}`,
      `Installed Argon ${SERVER_ENV_VARS.ARGON_VERSION}`,
    ],
  },
  {
    key: InstallStepKey.MiningLaunch,
    options: [`Launch Bitcoin & Argon Nodes`, `Launching Bitcoin & Argon Nodes`, `Launched Bitcoin & Argon Nodes`],
  },
];
