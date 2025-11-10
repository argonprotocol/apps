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
    options: [
      `Check Ubuntu 24.04 and Related Libraries`,
      `Checking Ubuntu 24.04 and Related Libraries`,
      `Checked Ubuntu 24.04 and Related Libraries`,
    ],
  },
  {
    key: InstallStepKey.DockerInstall,
    options: [
      `Verify Docker v27+ and Install Required Images`,
      `Verifying Docker v27+ and Installing Required Images`,
      `Verified Docker v27+ and Installed Required Images`,
    ],
  },
  {
    key: InstallStepKey.BitcoinInstall,
    options: [
      `Install Bitcoin v${SERVER_ENV_VARS.BITCOIN_VERSION} and Sync Bitcoin Block Data`,
      `Installing Bitcoin v${SERVER_ENV_VARS.BITCOIN_VERSION} and Syncing Bitcoin Block Data`,
      `Installed Bitcoin v${SERVER_ENV_VARS.BITCOIN_VERSION} and Synced Bitcoin Block Data`,
    ],
  },
  {
    key: InstallStepKey.ArgonInstall,
    options: [
      `Install Argon ${SERVER_ENV_VARS.ARGON_VERSION} and Sync Argon Block Data`,
      `Installing Argon ${SERVER_ENV_VARS.ARGON_VERSION} and Syncing Argon Block Data`,
      `Installed Argon ${SERVER_ENV_VARS.ARGON_VERSION} and Synced Argon Block Data`,
    ],
  },
  {
    key: InstallStepKey.MiningLaunch,
    options: [
      `Launch Bitcoin & Argon Mining Nodes`,
      `Launching Bitcoin & Argon Mining Nodes`,
      `Launched Bitcoin & Argon Mining Nodes`,
    ],
  },
];
