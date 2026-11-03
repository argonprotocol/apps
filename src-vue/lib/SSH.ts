import { Config } from './Config';
import { IConfigServerDetails } from '../interfaces/IConfig';
import { InvokeTimeout } from './tauriApi';
import { SSHConnection } from './SSHConnection';
import { ServerAdmin } from './ServerAdmin';
import type { WalletKeys } from './WalletKeys.ts';
import { base64Encode } from '@polkadot/util-crypto';

export type ITryServerData = Awaited<ReturnType<ServerAdmin['downloadConfigState']>> & {
  walletAddress: string | undefined;
  availableDiskBytes?: number;
};

export class SSH {
  public static connection?: SSHConnection;
  private static config: Config;
  private static walletKeys: WalletKeys;

  public static setConfig(config: Config, walletKeys: WalletKeys): void {
    this.config = config;
    this.walletKeys = walletKeys;
    if (
      this.connection &&
      this.connection.address !== `${this.config.serverDetails.ipAddress}:${this.config.serverDetails.sshPort ?? 22}`
    ) {
      void this.closeConnection();
    }
  }

  public static async getIpAddress(): Promise<string> {
    await this.config.isLoadedPromise;
    return this.config.serverDetails.ipAddress;
  }

  public static async getOrCreateConnection(retries = 3): Promise<SSHConnection> {
    if (!this.walletKeys.canAccessServer) throw new Error('Server access is unavailable');
    await this.config.isLoadedPromise;
    this.connection ??= new SSHConnection({ ...this.config.serverDetails }, this.walletKeys);
    try {
      await this.connection.connect(retries);
    } catch (e) {
      this.connection = undefined;
      throw e;
    }

    return this.connection;
  }

  public static async tryConnection(serverDetails: IConfigServerDetails): Promise<ITryServerData> {
    if (!this.walletKeys.canAccessServer) throw new Error('Server access is unavailable');
    const connection = new SSHConnection({ ...serverDetails }, this.walletKeys);
    await connection.connect(0);
    const server = new ServerAdmin(connection, serverDetails);
    const walletAddress = await server.downloadAccountAddress();
    if (this.connection) {
      void this.connection.close(true);
    }
    this.connection = connection; // save the working connection

    if (!walletAddress) {
      const availableDiskBytes = await server.getAvailableDiskBytes().catch(() => undefined);

      return {
        walletAddress: undefined,
        biddingRules: undefined,
        oldestFrameIdToSync: undefined,
        ethereumBeaconApiUrl: undefined,
        ethereumExecutionRpcUrl: undefined,
        availableDiskBytes,
      };
    }

    const configState = await server.downloadConfigState();

    return {
      walletAddress,
      ...configState,
    };
  }

  private static shouldReconnect(error: Error): boolean {
    return error instanceof InvokeTimeout || String(error) === 'No SSH connection';
  }

  public static async runCommand(command: string, retries = 3): Promise<[string, number]> {
    const connection = await this.getOrCreateConnection();
    try {
      return await connection.runCommandWithTimeout(command, 60 * 1e3);
    } catch (e) {
      const hasRetries = retries > 0;
      let shouldRetry = e === 'SSHCommandMissingExitStatus' && hasRetries;
      if (this.shouldReconnect(e as any) && hasRetries) {
        await this.reconnect();
        shouldRetry = true;
      }

      if (shouldRetry) {
        console.error(`SSH command timed out, retrying (${3 - retries + 1}/${3})...`, command);
        return this.runCommand(command, retries - 1);
      }
      console.error(`Error running command ${command}`, e);

      throw e;
    }
  }

  public static async uploadFile(contents: string, remotePath: string): Promise<void> {
    const connection = await this.getOrCreateConnection();
    try {
      await connection.uploadFileWithTimeout(contents, remotePath, 60 * 1e3);
    } catch (e) {
      if (this.shouldReconnect(e as any)) {
        await this.reconnect();
        return this.uploadFile(contents, remotePath);
      }
      throw e;
    }
  }

  public static async downloadFile(args: {
    remotePath: string;
    downloadPath: string;
    progressCallback: (progress: number) => void;
  }): Promise<void> {
    const connection = await this.getOrCreateConnection();
    try {
      await connection.downloadFileWithTimeout(args.remotePath, args.downloadPath, args.progressCallback, 60 * 1e3);
    } catch (e) {
      if (this.shouldReconnect(e as any)) {
        return this.reconnect().then(() => this.downloadFile(args));
      }
      throw e;
    }
  }

  public static async uploadEmbeddedFile(
    localRelativePath: string,
    remotePath: string,
    progressCallback: (progress: number) => void,
  ): Promise<void> {
    const connection = await this.getOrCreateConnection();
    await connection.uploadEmbeddedFileWithTimeout(localRelativePath, remotePath, progressCallback, 120 * 1e3);
  }

  public static async closeConnection(): Promise<void> {
    if (this.connection) {
      await this.connection.close(true);
      this.connection = undefined;
    }
  }

  private static async reconnect(): Promise<void> {
    await this.connection?.close();
    await this.connection?.connect();
  }
}

export function formatEd25519PublicKey(publicKey: Uint8Array): string {
  const algorithm = new TextEncoder().encode('ssh-ed25519');
  const blob = new Uint8Array(4 + algorithm.length + 4 + publicKey.length);
  const lengths = new DataView(blob.buffer);
  lengths.setUint32(0, algorithm.length);
  blob.set(algorithm, 4);
  lengths.setUint32(4 + algorithm.length, publicKey.length);
  blob.set(publicKey, 8 + algorithm.length);
  return `ssh-ed25519 ${base64Encode(blob)}`;
}
