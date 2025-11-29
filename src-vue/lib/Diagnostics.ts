import { Config } from './Config';
import { Server } from './Server';
import { SSH } from './SSH';
import { WalletKeys } from './WalletKeys.ts';

export class Diagnostics {
  private server!: Server;
  private config: Config;
  private walletKeys: WalletKeys;

  constructor(config: Config, walletKeys: WalletKeys) {
    this.config = config;
    this.walletKeys = walletKeys;
  }

  public async load() {
    if (this.server) return;
    const connection = await SSH.getOrCreateConnection();
    this.server = new Server(connection, this.config.serverDetails);
    console.log('Diagnostics IS LOADED');
  }

  public async downloadTroubleshootingPackage(progressCallback: (progress: number) => void): Promise<string> {
    const server = this.server;
    return await server.downloadTroubleshootingPackage(progressCallback);
  }

  public async isConnected() {
    console.log('isConnected', this);
    return await this.server.isConnected();
  }

  public async accountAddressMatches() {
    const remoteAccountAddress = await this.server.downloadAccountAddress();
    return remoteAccountAddress === this.walletKeys.miningAddress;
  }

  public async remoteServerFilesAreUpToDate() {
    // TODO: Will finish sha256 check when Blake pushes his latest changes
    const workdir = this.config.serverDetails.workDir;
    const [outputRaw] = await SSH.runCommand(`ls -la ${workdir}/server`);
    const files = this.extractCleanFiles(outputRaw);
    return { files };
  }

  public async remoteConfigFilesAreUpToDate() {
    const workdir = this.config.serverDetails.workDir;
    const [outputRaw] = await SSH.runCommand(`ls -la ${workdir}/config`);
    const files = this.extractCleanFiles(outputRaw);
    return { files };
  }

  public async lastInstallCompletedSuccessfully() {
    const stepStatuses = await this.server.downloadInstallStepStatuses();
    console.log('stepStatuses', Object.entries(stepStatuses));
    return {
      steps: Object.entries(stepStatuses),
    };
  }

  public async healthOfBitcoinNode() {
    const info = await this.server.fetchBitcoinBlockChainInfo();
    return {
      info,
    };
  }

  public async healthOfArgonNode() {
    const info = await this.server.fetchArgonBlockChainInfo();
    return {
      info,
    };
  }

  private extractCleanFiles(outputRaw: string): string[] {
    const lines = outputRaw.split('\n').filter(Boolean);

    // Skip the first line (total) and parse each line
    const allItems = lines.slice(1).map(line => {
      const parts = line.split(/\s+/);
      if (parts.length >= 9) {
        const permissions = parts[0];
        const filename = parts.slice(8).join(' ');
        // Check if it's a directory (starts with 'd')
        const isDirectory = permissions.startsWith('d');
        return isDirectory ? `${filename}/` : filename;
      }
      return line;
    });

    return allItems.filter(item => !['./', '../'].includes(item));
  }
}
