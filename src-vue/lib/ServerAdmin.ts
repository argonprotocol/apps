import { parse as parseEnv } from 'dotenv';
import { IBiddingRules, JsonExt, toComposeProjectName } from '@argonprotocol/apps-core';
import { SSHConnection } from './SSHConnection';
import { DEPLOY_ENV_FILE, INSTANCE_NAME, NETWORK_NAME, SERVER_ENV_VARS } from './Env.ts';
import { KeyringPair$Json } from '@argonprotocol/mainchain';
import { IConfigServerDetails, InstallStepKey } from '../interfaces/IConfig';
import { join, tempDir } from '@tauri-apps/api/path';
import { LocalMachine } from './LocalMachine.ts';
import { getInstanceConfigDir } from './Utils.ts';

export enum InstallStepStatusType {
  Pending = 'Pending',
  Started = 'Started',
  Finished = 'Finished',
  Failed = 'Failed',
}

export interface IInstallStepStatuses {
  [key: string]: InstallStepStatusType;
}

const installStepStatusPriorityByType: Record<InstallStepStatusType, number> = {
  [InstallStepStatusType.Pending]: 0,
  [InstallStepStatusType.Started]: 1,
  [InstallStepStatusType.Finished]: 2,
  [InstallStepStatusType.Failed]: 3,
};
export const DOCKER_COMPOSE_PROJECT_NAME = toComposeProjectName(INSTANCE_NAME, NETWORK_NAME);
const DEV_DOCKER_SERVER_ENV_KEYS = [
  'ARGON_ARCHIVE_NODE',
  'ARGON_BOOTNODES',
  'BITCOIN_ADDNODE',
  'NOTEBOOK_ARCHIVE_HOSTS',
] as const;
const TROUBLESHOOTING_COLLECTION_EXPECTED_MS = 30e3;
const TROUBLESHOOTING_COLLECTION_TIMEOUT_MS = 180e3;

export class ServerAdmin {
  private readonly connection: SSHConnection;
  private readonly serverDetails: IConfigServerDetails;

  constructor(connection: SSHConnection, serverDetails: IConfigServerDetails) {
    this.connection = connection;
    this.serverDetails = serverDetails;
  }

  private get workDir() {
    return this.serverDetails.workDir;
  }

  private get installerScriptPath() {
    return `${this.workDir}/server/scripts/installer.sh`;
  }

  public static async virtualMachineFolder(): Promise<string> {
    let path = await join(await getInstanceConfigDir(), 'virtual-machine');
    // On Windows, convert to Docker-compatible path: replace backslashes, convert drive letter to /c/ form.
    if (typeof process !== 'undefined' && process.platform === 'win32') {
      // Replace backslashes with forward slashes
      path = path.replace(/\\/g, '/');
      // If starts with drive letter, e.g., C:/, convert to /c/
      path = path.replace(/^([A-Z]):\//i, (_m, drive: string) => `/${drive.toLowerCase()}/`);
    }
    return path;
  }

  public async isConnected(): Promise<boolean> {
    const [output] = await this.connection.runCommandWithTimeout('pwd', 10e3);
    return !!output;
  }

  public async createWorkdir(): Promise<void> {
    const username = this.connection.username;
    await this.connection.runCommandWithTimeout(
      `if [ ! -d "${this.workDir}" ]; then sudo mkdir -p "${this.workDir}" && sudo chown -R "${username}" "${this.workDir}"; fi`,
      10e3,
    );
  }

  public async uploadAccountAddress(address: string): Promise<void> {
    await this.connection.uploadFileWithTimeout(address, `${this.workDir}/account`, 10e3);
  }

  public async downloadTroubleshootingPackage(onProgress: (progress: number) => void): Promise<string> {
    let totalProgress = 5;
    onProgress(totalProgress);
    const collectionStartedAt = Date.now();
    const collectionProgressTimer = setInterval(() => {
      const elapsedRatio = (Date.now() - collectionStartedAt) / TROUBLESHOOTING_COLLECTION_EXPECTED_MS;
      totalProgress = 5 + 18 * (1 - Math.exp(-elapsedRatio));
      onProgress(totalProgress);
    }, 1e3);
    let output = '';

    try {
      [output] = await this.connection.runCommandWithTimeout(
        `sudo ${this.workDir}/server/scripts/create_troubleshooting_gz.sh`,
        TROUBLESHOOTING_COLLECTION_TIMEOUT_MS,
        0,
      );
    } finally {
      clearInterval(collectionProgressTimer);
    }

    const file = output.match(/Bundle ready: (.+\.tar\.gz)/);
    if (!file || !file[1]) {
      console.error('Failed to create troubleshooting package:', output);
      throw new Error(`Failed to create troubleshooting package: ${output.trim() || 'No script output was returned'}`);
    }
    totalProgress = 25;
    onProgress(totalProgress);
    const filename = file[1].trim();
    const localFilename = filename.split('/').pop() || 'troubleshooting.tar.gz';
    const tmp = await tempDir();
    const downloadPath = await join(tmp, localFilename);
    console.info(`Downloading troubleshooting package: ${filename} to ${tmp}`);
    await this.connection.downloadFileWithTimeout(
      file[1],
      downloadPath,
      x => {
        const downloadPercent = Math.min(75, x * 0.75);
        onProgress(25 + downloadPercent); // 25% for creation, 75% for download
      },
      60e3,
    );
    return downloadPath;
  }

  public async downloadAccountAddress(): Promise<string> {
    const [address] = await this.connection.runCommandWithTimeout(
      `cat ${this.workDir}/account 2>/dev/null || true`,
      10e3,
    );
    return address.trim();
  }

  public async uploadBiddingRules(biddingRules: IBiddingRules): Promise<void> {
    const biddingRulesStr = JsonExt.stringify(biddingRules, 2);
    await this.connection.uploadFileWithTimeout(biddingRulesStr, `${this.workDir}/config/biddingRules.json`, 20e3);
  }

  public async downloadBiddingRules(): Promise<IBiddingRules | undefined> {
    const [biddingRulesRaw] = await this.connection.runCommandWithTimeout(
      `cat ${this.workDir}/config/biddingRules.json 2>/dev/null || true`,
      20e3,
    );
    return biddingRulesRaw ? JsonExt.parse(biddingRulesRaw) : undefined;
  }

  public async downloadConfigState(): Promise<{
    biddingRules: IBiddingRules | undefined;
    oldestFrameIdToSync?: number;
    ethereumBeaconApiUrl?: string;
    ethereumExecutionRpcUrl?: string;
  }> {
    const [biddingRules, envState] = await Promise.all([this.downloadBiddingRules(), this.downloadEnvState()]);
    return {
      biddingRules,
      ...envState,
    };
  }

  public async uploadEnvState(envState: {
    oldestFrameIdToSync: number;
    miningFundingAccountId: string;
    vaultOperatorAddress: string;
    operatorAccountId: string;
    ethereumBeaconApiUrl?: string;
    ethereumExecutionRpcUrl?: string;
  }): Promise<void> {
    const lines = [
      `OLDEST_FRAME_ID_TO_SYNC=${envState.oldestFrameIdToSync || ''}`,
      `MINING_FUNDING_ACCOUNT_ID=${envState.miningFundingAccountId}`,
      `VAULT_OPERATOR_ADDRESS=${envState.vaultOperatorAddress}`,
      `OPERATOR_ACCOUNT_ID=${envState.operatorAccountId}`,
    ];
    const ethereumBeaconApiUrl = envState.ethereumBeaconApiUrl?.trim();
    const ethereumExecutionRpcUrl = envState.ethereumExecutionRpcUrl?.trim();

    if (envState.ethereumBeaconApiUrl === '') {
      lines.push('ETHEREUM_BEACON_API_URL=');
    } else if (ethereumBeaconApiUrl) {
      lines.push(`ETHEREUM_BEACON_API_URL=${ethereumBeaconApiUrl}`);
    }
    if (ethereumExecutionRpcUrl) {
      lines.push(`ETHEREUM_EXECUTION_RPC_URL=${ethereumExecutionRpcUrl}`);
    }

    const envStateStr = `${lines.join('\n')}\n`;
    await this.connection.uploadFileWithTimeout(envStateStr, `${this.workDir}/config/.env.state`, 10e3);
  }

  public async downloadEnvState(): Promise<{
    oldestFrameIdToSync?: number;
    ethereumBeaconApiUrl?: string;
    ethereumExecutionRpcUrl?: string;
  }> {
    const [envStateRaw] = await this.connection.runCommandWithTimeout(
      `cat ${this.workDir}/config/.env.state 2>/dev/null || true`,
      10e3,
    );
    const envState = envStateRaw ? parseEnv(envStateRaw) : {};
    const hasBeaconApiUrl = 'ETHEREUM_BEACON_API_URL' in envState;
    const hasOldestFrameIdToSync = 'OLDEST_FRAME_ID_TO_SYNC' in envState;
    return {
      oldestFrameIdToSync: hasOldestFrameIdToSync ? Number(envState.OLDEST_FRAME_ID_TO_SYNC || '0') : undefined,
      ethereumBeaconApiUrl: hasBeaconApiUrl ? (envState.ETHEREUM_BEACON_API_URL?.trim() ?? '') : undefined,
      ethereumExecutionRpcUrl: envState.ETHEREUM_EXECUTION_RPC_URL?.trim() || undefined,
    };
  }

  public async getDataDir(service: string): Promise<string> {
    const [output, code] = await this.runComposeCommand(
      `config ${service} --format json 2>/dev/null | jq -er '.services.["${service}"].volumes[0].source'`,
      10e3,
    );
    const dataDir = output.trim();
    if (code !== 0 || !dataDir.startsWith('/') || dataDir.includes('\n') || dataDir.includes('\r')) {
      throw new Error(`Invalid data directory returned for ${service}`);
    }
    return dataDir;
  }

  public async cleanDirectory(directory: string): Promise<void> {
    if (!directory.startsWith('/') || directory === '/' || directory.includes('\n') || directory.includes('\r')) {
      throw new Error('Invalid directory to clean');
    }
    console.info(`Cleaning directory: ${directory}`);
    await this.connection.runCommandWithTimeout(
      `set -euo pipefail && sudo find "${directory}" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +`,
      60e3,
    );
    const [remainingFiles, code] = await this.connection.runCommandWithTimeout(
      `sudo find "${directory}" -mindepth 1 -maxdepth 1 -print -quit`,
      10e3,
    );
    if (code !== 0 || remainingFiles.trim()) {
      throw new Error(`Directory was not fully cleaned: ${directory}`);
    }
  }

  public async stopMiningDockers(): Promise<void> {
    await this.runComposeCommand(`stop argon-miner`);
  }

  public async startMiningDockers(): Promise<void> {
    await this.runComposeCommand(`up argon-miner -d`, 60e3);
  }

  public async resyncMiner(): Promise<void> {
    const dataDir = await this.getDataDir('argon-miner');
    const chainDataDir = `${dataDir}/chains`;
    await this.stopMiningDockers();
    console.info(`Wiping Argon chain data directory: ${chainDataDir}`);
    await this.cleanDirectory(chainDataDir);
    await this.removeLogStep(InstallStepKey.ArgonInstall);
    await this.startMiningDockers();
  }

  public async stopBitcoinDocker(): Promise<void> {
    await this.runComposeCommand(`stop bitcoin-node`, 60e3);
  }

  public async startBitcoinDocker(): Promise<void> {
    await this.runComposeCommand(`up bitcoin-node -d`, 60e3);
  }

  public async resyncBitcoin(): Promise<void> {
    const dataDir = await this.getDataDir('bitcoin-node');
    await this.stopBitcoinDocker();
    console.info(`Wiping Bitcoin data directory: ${dataDir}`);
    await this.cleanDirectory(dataDir);
    await this.removeLogStep(InstallStepKey.BitcoinInstall);
    await this.startBitcoinDocker();
  }

  public async stopBotDocker(): Promise<void> {
    await this.runComposeCommand(`stop bot`, 10e3);
  }

  public async startBotDocker(): Promise<void> {
    // Recreate the bot so env_file changes are re-read.
    await this.runComposeCommand(`up -d --no-deps --force-recreate bot`, 20e3);
  }

  public async restartDocker(): Promise<void> {
    await this.runComposeCommand(`restart argon-miner bitcoin-node bot`, 10e3);
  }

  public async uploadEnvSecurity(envSecurity: { sessionMiniSecret: string }): Promise<void> {
    const envSecurityStr = `SESSION_MINI_SECRET="${envSecurity.sessionMiniSecret}"\n`;
    await this.connection.uploadFileWithTimeout(envSecurityStr, `${this.workDir}/config/.env.security`, 10e3);
  }

  public async uploadMiningBotWallet(miningBotWalletJson: KeyringPair$Json): Promise<void> {
    const miningBotWalletStringified = JsonExt.stringify(miningBotWalletJson, 2);
    await this.connection.uploadFileWithTimeout(
      miningBotWalletStringified,
      `${this.workDir}/config/walletMiningBot.json`,
      10e3,
    );
  }

  public async uploadVaultDelegateWallet(delegateWalletJson: KeyringPair$Json): Promise<void> {
    const delegateWalletStringified = JsonExt.stringify(delegateWalletJson, 2);
    await this.connection.uploadFileWithTimeout(
      delegateWalletStringified,
      `${this.workDir}/config/walletVaultDelegate.json`,
      10e3,
    );
  }

  public async removeAllLogFiles(): Promise<void> {
    await this.connection.runCommandWithTimeout(`rm -rf ${this.workDir}/logs/*`, 60e3);
  }

  public async removeLogStep(stepKey: string): Promise<void> {
    await this.connection.runCommandWithTimeout(`rm -rf ${this.workDir}/logs/step-${stepKey}.*`, 60e3);
  }

  public async getComposeProjectName(): Promise<string> {
    const [existingEnv] = await this.connection.runCommandWithTimeout(
      `cat ${this.workDir}/server/.env 2>/dev/null || true`,
      10e3,
    );
    const composeProjectName = parseEnv(existingEnv).COMPOSE_PROJECT_NAME?.trim() || DOCKER_COMPOSE_PROJECT_NAME;
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(composeProjectName)) {
      throw new Error('Invalid Docker Compose project name in the existing server configuration');
    }

    return composeProjectName;
  }

  public async startInstallerScript(options: { composeProjectName?: string } = {}): Promise<void> {
    const remoteScriptPath = this.installerScriptPath;
    const remoteScriptLogPath = `${this.workDir}/logs/installer.log`;
    const [existingEnv] = await this.connection.runCommandWithTimeout(
      `cat ${this.workDir}/server/.env 2>/dev/null || true`,
      10e3,
    );
    const existingEnvVars = parseEnv(existingEnv);
    const composeProjectName =
      options.composeProjectName?.trim() || existingEnvVars.COMPOSE_PROJECT_NAME?.trim() || DOCKER_COMPOSE_PROJECT_NAME;
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(composeProjectName)) {
      throw new Error('Invalid Docker Compose project name in the existing server configuration');
    }

    let prepareEnvCommand =
      `cd ${this.workDir}/server && cp ${DEPLOY_ENV_FILE} .env` +
      ` && echo "COMPOSE_PROJECT_NAME=${composeProjectName}" >> .env`;

    if (this.connection.isDockerHostProxy) {
      const existingBitcoinP2pPort = Number(existingEnvVars.BITCOIN_P2P_PORT);
      const existingArgonP2pPort = Number(existingEnvVars.ARGON_P2P_PORT);

      const bitcoinP2pPort =
        Number.isInteger(existingBitcoinP2pPort) && existingBitcoinP2pPort > 0 && existingBitcoinP2pPort <= 65_535
          ? existingBitcoinP2pPort
          : await LocalMachine.findAvailablePort(18445);
      const argonP2pPort =
        Number.isInteger(existingArgonP2pPort) && existingArgonP2pPort > 0 && existingArgonP2pPort <= 65_535
          ? existingArgonP2pPort
          : await LocalMachine.findAvailablePort(Math.max(30337, bitcoinP2pPort + 1));

      prepareEnvCommand += ` && echo "GATEWAY_PORT=0" >> .env`;
      prepareEnvCommand += ` && echo "BITCOIN_P2P_PORT=${bitcoinP2pPort}" >> .env`;
      prepareEnvCommand += ` && echo "ARGON_P2P_PORT=${argonP2pPort}" >> .env`;

      if (NETWORK_NAME === 'dev-docker') {
        for (const key of DEV_DOCKER_SERVER_ENV_KEYS) {
          const value = SERVER_ENV_VARS[key];
          if (!value) {
            throw new Error(
              `Missing ${key}. Start dev-docker through yarn dev:docker so upstream ports can be resolved.`,
            );
          }

          prepareEnvCommand += ` && echo "${key}=${value}" >> .env`;
        }
      }
    } else {
      if (this.serverDetails.ipAddress) {
        prepareEnvCommand += ` && echo "GATEWAY_CERTBOT_ENABLED=true" >> .env`;
        prepareEnvCommand += ` && echo "GATEWAY_CERT_IP=${this.serverDetails.ipAddress}" >> .env`;
        prepareEnvCommand += ` && echo "GATEWAY_CERTBOT_HTTP_PORT=80" >> .env`;
      }
      if (typeof this.serverDetails.gatewayPort === 'number') {
        prepareEnvCommand += ` && echo "GATEWAY_PORT=${this.serverDetails.gatewayPort}" >> .env`;
      }
    }

    await this.connection.runCommandWithTimeout(prepareEnvCommand, 10e3);

    if (this.connection.isDockerHostProxy) {
      const fullVmPath = await ServerAdmin.virtualMachineFolder();
      // sed replace all instances of ../ with the fullPath
      const sedCommand = `sed -i -e 's|^ROOT=.*|ROOT="${fullVmPath}/app"|' ${this.workDir}/server/.env`;
      await this.connection.runCommandWithTimeout(sedCommand, 10e3);
    }

    if (await this.isInstallerScriptRunning()) {
      console.log('Restart the installer script: stopping existing one first');
      await this.killInstallerScript();
      // wait a bit to ensure it's stopped
      await new Promise(r => setTimeout(r, 2000));
    }
    const shellCommand = `IS_DOCKER_HOST_PROXY=${this.connection.isDockerHostProxy} ARGON_CHAIN=${NETWORK_NAME} nohup ${remoteScriptPath} > ${remoteScriptLogPath} 2>&1 &`;
    await this.connection.runCommandWithTimeout(shellCommand, 10e3);

    console.info(`started: ${shellCommand}`);
    const pid = await this.getInstallerPid();
    console.info('Installer PID:', pid);

    if (this.connection.isDockerHostProxy && NETWORK_NAME === 'dev-docker') {
      await this.ensureNotaryNetworkAlias();
    }
  }

  private async ensureNotaryNetworkAlias(): Promise<void> {
    const notaryContainerId = SERVER_ENV_VARS.NOTARY_ALIAS_CONTAINER_ID?.trim();
    if (!notaryContainerId) return;

    const networkName = `${DOCKER_COMPOSE_PROJECT_NAME}-net`;
    const command =
      `sudo docker network create ${networkName} >/dev/null 2>&1 || true` +
      ` && sudo docker network connect --alias notary.localhost ${networkName} ${notaryContainerId} >/dev/null 2>&1 || true`;

    await this.connection.runCommandWithTimeout(command, 180e3);
  }

  public async createConfigDir(): Promise<void> {
    await this.connection.runCommandWithTimeout(`mkdir -p ${this.workDir}/config`, 10e3);
  }

  public async createLogsDir(): Promise<void> {
    await this.connection.runCommandWithTimeout(`mkdir -p ${this.workDir}/logs`, 10e3);
  }

  public async downloadRemoteShasum(): Promise<string> {
    const [version] = await this.connection.runCommandWithTimeout(
      `cat ${this.workDir}/server/SHASUM256 2>/dev/null || true`,
      10e3,
    );
    return version.trim();
  }

  public async isInstallerScriptRunning(): Promise<boolean> {
    return (await this.getInstallerPid()) !== undefined;
  }

  public async getInstallerPid(): Promise<string | undefined> {
    try {
      const [pid] = await this.connection.runCommandWithTimeout(
        `pid=$(cat /tmp/installer.lock 2>/dev/null || true); ps -p "$pid" >/dev/null 2>&1 && echo "$pid"`,
        10e3,
      );
      return pid?.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  public async waitForGatewayPort(timeoutMs = 10 * 60e3): Promise<number | undefined> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const [endpoint, code] = await this.runComposeCommand('port nginx 443', 10e3).catch(() => ['', 1] as const);
      if (code === 0) {
        const port = endpoint
          .split('\n')
          .map(x => x.trim())
          .filter(Boolean)
          .at(-1)
          ?.match(/:(\d+)$/)?.[1];

        if (port) return Number(port);
      }

      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  public async killInstallerScript(): Promise<void> {
    try {
      const pid = await this.getInstallerPid();
      if (pid) {
        await this.connection.runCommandWithTimeout(`sudo kill -9 ${pid}`, 10e3);
        await this.connection.runCommandWithTimeout(`sudo rm /tmp/installer.lock`, 10e3);
      }
    } catch (error) {
      console.error('Error killing installer script:', error);
    }
  }

  public async downloadInstallStepStatuses(): Promise<IInstallStepStatuses> {
    const stepStatuses: IInstallStepStatuses = {};
    const [output, code] = await this.connection.runCommandWithTimeout(`ls ${this.workDir}/logs/step-*`, 10e3);
    if (code !== 0) {
      return stepStatuses;
    }

    stepStatuses[InstallStepKey.ServerConnect] = InstallStepStatusType.Finished;

    for (const filename of output.split('\n').filter(s => s)) {
      const [, key, newStatus] = filename.match(/step-(.+)\.(.+)/) || [];
      const prevStatus = stepStatuses[key] || InstallStepStatusType.Pending;
      if (!key || !newStatus) {
        continue;
      }

      const newStatusNumber = installStepStatusPriorityByType[newStatus as InstallStepStatusType];
      const prevStatusNumber = installStepStatusPriorityByType[prevStatus];

      if (newStatusNumber > prevStatusNumber) {
        stepStatuses[key] = newStatus as InstallStepStatusType;
      }
    }

    return stepStatuses;
  }

  public async extractInstallStepFailureMessage(stepKey: InstallStepKey): Promise<string> {
    const stepName = InstallStepKey[stepKey];
    const [output, code] = await this.connection.runCommandWithTimeout(
      `cat ${this.workDir}/logs/step-${stepName}.${InstallStepStatusType.Failed}`,
      10e3,
    );
    if (code === 0) {
      return output.trim();
    }
    return '';
  }

  public async deleteBotStorageFiles(): Promise<void> {
    await this.connection.runCommandWithTimeout(`sudo rm -rf ${this.workDir}/data/bot-*`, 10e3);
  }

  public async completelyWipeEverything(): Promise<void> {
    const shellCommand = `sudo ${this.workDir}/server/scripts/wipe_server.sh `;

    try {
      await this.connection.runCommandWithTimeout(shellCommand, 60e3);
    } catch (error) {
      console.error('Error wiping server:', error);
    }
    if (this.connection.isDockerHostProxy) {
      await LocalMachine.remove();
    }
  }

  private async runComposeCommand(command: string, timeoutMs = 60e3): Promise<[string, number]> {
    return await this.connection.runCommandWithTimeout(
      `cd ${this.workDir}/server && sudo docker compose ${command}`,
      timeoutMs,
    );
  }
}
