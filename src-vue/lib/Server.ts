import { parse as parseEnv } from 'dotenv';
import { IBiddingRules, JsonExt } from '@argonprotocol/apps-core';
import { SSHConnection } from './SSHConnection';
import { DEPLOY_ENV_FILE, INSTANCE_NAME, NETWORK_NAME, SERVER_ENV_VARS } from './Env.ts';
import { KeyringPair$Json } from '@argonprotocol/mainchain';
import { SSH } from './SSH';
import { IConfigServerDetails, InstallStepKey } from '../interfaces/IConfig';
import { join, tempDir } from '@tauri-apps/api/path';
import { LocalMachine } from './LocalMachine.ts';
import { fetch } from '@tauri-apps/plugin-http';
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
export const DOCKER_COMPOSE_PROJECT_NAME = `${NETWORK_NAME}-${INSTANCE_NAME}`.toLowerCase().replace(/[^a-z0-9]/g, '-');

export interface IBitcoinBlockChainInfo {
  chain: string;
  blocks: number;
  headers: number;
  bestBlockHash: string;
  difficulty: number;
  time: number;
  medianTime: number;
  verificationProgress: number;
  initialBlockDownload: boolean;
  chainwork: string;
  sizeOnDisk: number;
  pruned: boolean;
  warnings: string[];
  localNodeBlockNumber: number;
  mainNodeBlockNumber: number;
}

export interface IArgonBlockChainInfo {
  localNodeBlockNumber: number;
  mainNodeBlockNumber: number;
  isComplete: boolean;
}

export class Server {
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
    const [output] = await this.connection.runCommandWithTimeout(
      `sudo ${this.workDir}/server/scripts/create_troubleshooting_gz.sh`,
      20e3,
    );
    const file = output.match(/Bundle ready: (.+\.tar\.gz)/);
    if (!file || !file[1]) {
      console.error('Failed to create troubleshooting package:', output);
      throw new Error('Failed to create troubleshooting package');
    }
    totalProgress += 20;
    onProgress(totalProgress);
    const filename = file[1].trim();
    const tmp = await tempDir();
    const downloadPath = await join(tmp, filename);
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

  public async uploadEnvState(envState: { oldestFrameIdToSync: number }): Promise<void> {
    const envStateStr = `OLDEST_FRAME_ID_TO_SYNC=${envState.oldestFrameIdToSync || ''}\n`;
    await this.connection.uploadFileWithTimeout(envStateStr, `${this.workDir}/config/.env.state`, 10e3);
  }

  public async downloadEnvState(): Promise<{ oldestFrameIdToSync: number }> {
    const [envStateRaw] = await this.connection.runCommandWithTimeout(
      `cat ${this.workDir}/config/.env.state 2>/dev/null || true`,
      10e3,
    );
    const envState = envStateRaw ? parseEnv(envStateRaw) : {};
    return {
      oldestFrameIdToSync: Number(envState.OLDEST_FRAME_ID_TO_SYNC),
    };
  }

  public async getDataDir(service: string): Promise<string> {
    const [dataDir] = await this.runComposeCommand(
      `config ${service} --format json | jq -r '.services.["${service}"].volumes[0].source'`,
      10e3,
    );
    return dataDir.trim();
  }

  public async cleanDirectory(directory: string): Promise<void> {
    if (!directory || directory === '/') {
      throw new Error('Invalid directory to clean');
    }
    console.info(`Cleaning directory: ${directory}`);
    await this.connection.runCommandWithTimeout(`set -euo pipefail && sudo rm -rf -- "${directory}"/*`, 10e3);
  }

  public async stopMiningDockers(): Promise<void> {
    await this.runComposeCommand(`stop argon-miner `);
  }

  public async startMiningDockers(): Promise<void> {
    await this.runComposeCommand(`up argon-miner -d`, 60e3);
  }

  public async resyncMiner(): Promise<void> {
    const dataDir = await this.getDataDir('argon-miner').catch(() => null);
    if (dataDir) {
      await this.stopMiningDockers();
      console.info(`Wiping Argon Miner data directory: ${dataDir}`);
      await this.cleanDirectory(dataDir);
    }
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
    const dataDir = await this.getDataDir('bitcoin-node').catch(() => null);
    if (dataDir) {
      await this.stopBitcoinDocker();
      console.info(`Wiping Bitcoin data directory: ${dataDir}`);
      await this.cleanDirectory(dataDir);
    }
    await this.removeLogStep(InstallStepKey.BitcoinInstall);
    await this.startBitcoinDocker();
  }

  public async stopBotDocker(): Promise<void> {
    await this.runComposeCommand(`stop bot`, 10e3);
  }

  public async startBotDocker(): Promise<void> {
    // do a restart to load the mounted file
    await this.runComposeCommand(`restart bot`, 10e3);
  }

  public async restartDocker(): Promise<void> {
    await this.runComposeCommand(`restart argon-miner bitcoin-node bot`, 10e3);
  }

  public async uploadEnvSecurity(envSecurity: { sessionMiniSecret: string; keypairPassphrase: string }): Promise<void> {
    const envSecurityStr =
      `SESSION_MINI_SECRET="${envSecurity.sessionMiniSecret}"\n` +
      `KEYPAIR_PASSPHRASE=${envSecurity.keypairPassphrase}`;
    await this.connection.uploadFileWithTimeout(envSecurityStr, `${this.workDir}/config/.env.security`, 10e3);
  }

  public async uploadMiningWallet(miningWalletJson: KeyringPair$Json): Promise<void> {
    const walletMiningJson = JsonExt.stringify(miningWalletJson, 2);
    await this.connection.uploadFileWithTimeout(walletMiningJson, `${this.workDir}/config/walletMining.json`, 10e3);
  }

  public async removeAllLogFiles(): Promise<void> {
    await this.connection.runCommandWithTimeout(`rm -rf ${this.workDir}/logs/*`, 10e3);
  }

  public async removeLogStep(stepKey: string): Promise<void> {
    await this.connection.runCommandWithTimeout(`rm -rf ${this.workDir}/logs/step-${stepKey}.*`, 10e3);
  }

  public async startInstallerScript(): Promise<void> {
    const remoteScriptPath = this.installerScriptPath;
    const remoteScriptLogPath = `${this.workDir}/logs/installer.log`;
    await this.connection.runCommandWithTimeout(
      `cd ${this.workDir}/server && cp ${DEPLOY_ENV_FILE} .env && echo "COMPOSE_PROJECT_NAME=${DOCKER_COMPOSE_PROJECT_NAME}" >> .env`,
      10e3,
    );
    if (this.connection.isDockerHostProxy) {
      const fullVmPath = await Server.virtualMachineFolder();
      // sed replace all instances of ../ with the fullPath
      const sedCommand = `sed -i -e 's|^ROOT=.*|ROOT="${fullVmPath}/app"|' ${this.workDir}/server/.env`;
      await this.connection.runCommandWithTimeout(sedCommand, 10e3);
      await this.connection.runCommandWithTimeout(`sedCommand`, 10e3);
    }
    if (await this.isInstallerScriptRunning()) {
      console.log('Restart the installer script: stopping existing one first');
      await this.connection.runCommandWithTimeout(`pkill -f ${remoteScriptPath} || true`, 10e3);
      // wait a bit to ensure it's stopped
      await new Promise(r => setTimeout(r, 2000));
    }
    const shellCommand = `IS_DOCKER_HOST_PROXY=${this.connection.isDockerHostProxy} ARGON_CHAIN=${NETWORK_NAME} nohup ${remoteScriptPath} > ${remoteScriptLogPath} 2>&1 &`;
    await this.connection.runCommandWithTimeout(shellCommand, 10e3);

    console.info(`started: ${shellCommand}`);
    const [pid] = await this.connection.runCommandWithTimeout(`pgrep -f ${remoteScriptPath} || true`, 10e3);
    console.info('Installer PID:', pid);
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
    try {
      const [pid] = await this.connection.runCommandWithTimeout(`pgrep -f ${this.installerScriptPath}`, 10e3);
      return pid.trim() !== '';
    } catch {
      return false;
    }
  }

  public async fetchBitcoinInstallProgress(): Promise<number> {
    const result = await this.fetchStatus<ISyncStatus>('bitcoin', 'syncstatus', 30e3).catch(() => null);
    return result?.syncPercent ?? 0.0;
  }

  public async fetchBitcoinBlockChainInfo(): Promise<IBitcoinBlockChainInfo> {
    const blocks = await this.fetchStatus<IBitcoinLatestBlocks>('bitcoin', `latestblocks`, 30e3);

    const output2: any = await this.fetchStatus('bitcoin', 'getblockchaininfo', 30e3);
    return {
      chain: output2.chain,
      blocks: output2.blocks,
      headers: output2.headers,
      bestBlockHash: output2.bestblockhash,
      difficulty: output2.difficulty,
      time: output2.time,
      medianTime: output2.mediantime,
      verificationProgress: output2.verificationprogress,
      initialBlockDownload: output2.initialblockdownload,
      chainwork: output2.chainwork,
      sizeOnDisk: output2.size_on_disk,
      pruned: output2.pruned,
      warnings: output2.warnings,
      localNodeBlockNumber: blocks.localNodeBlockNumber,
      mainNodeBlockNumber: blocks.mainNodeBlockNumber,
    };
  }

  public async fetchArgonBlockChainInfo(): Promise<IArgonBlockChainInfo> {
    const { localNodeBlockNumber, mainNodeBlockNumber } = await this.fetchStatus<ILatestBlocks>(
      'argon',
      `latestblocks`,
      10e3,
    );

    const completeResponse = await this.fetchStatus<boolean | object>('argon', 'iscomplete', 10e3);
    const isComplete = completeResponse === true;

    return {
      localNodeBlockNumber,
      mainNodeBlockNumber,
      isComplete,
    };
  }

  public async fetchArgonInstallProgress(): Promise<number> {
    const result = await this.fetchStatus<ISyncStatus>('argon', 'syncstatus', 30e3);

    return result?.syncPercent ?? 0.0;
  }

  public async downloadInstallStepStatuses(): Promise<IInstallStepStatuses> {
    const stepStatuses: IInstallStepStatuses = {};
    const [output, code] = await SSH.runCommand(`ls ${this.workDir}/logs/step-*`);
    if (code !== 0) {
      return stepStatuses;
    }

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
      `cat ${this.workDir}/logs/step-${stepName}.failed`,
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

  private async fetchStatus<T>(service: 'argon' | 'bitcoin', path: string, timeoutMs = 10e3): Promise<T> {
    if (path.startsWith('/')) {
      path = path.slice(1);
    }
    const ip = this.connection.host;
    const aborController = new AbortController();
    const signal = aborController.signal;
    const timeout = setTimeout(() => {
      aborController.abort();
    }, timeoutMs);
    const response = await fetch(`http://${ip}:${SERVER_ENV_VARS.STATUS_PORT}/${service}/${path}`, {
      signal,
    });
    clearTimeout(timeout);
    if (!response.ok) {
      console.error(`[STATUS] ${response.status}: ${service}/${path}`, await response.text());
      throw new Error(`HTTP error ${response.status}`);
    }
    const data = (await response.json()) as Promise<T>;
    console.debug(`[STATUS] ${service}/${path}`, data);
    return data;
  }
}

interface ISyncStatus {
  mainNodeBlockNumber: number;
  localNodeBlockNumber: number;
  syncPercent: number;
}

interface ILatestBlocks {
  mainNodeBlockNumber: number;
  localNodeBlockNumber: number;
}

interface IBitcoinLatestBlocks extends ILatestBlocks {
  localNodeBlockTime: number;
}
