import { Config } from './Config';
import { IConfigServerDetails } from '../interfaces/IConfig';
import { InvokeTimeout } from './tauriApi';
import { SSHConnection } from './SSHConnection';
import { IBiddingRules } from '@argonprotocol/commander-core';
import { Server } from './Server';

export interface ITryServerData {
  walletAddress: string | undefined;
  biddingRules: IBiddingRules | undefined;
  oldestFrameIdToSync: number | undefined;
}

export class SSH {
  public static connection?: SSHConnection;
  private static config: Config;

  public static setConfig(config: Config): void {
    this.config = config;
    if (
      this.connection &&
      this.connection.host !== `${this.config.serverDetails.ipAddress}:${this.config.serverDetails.port ?? 22}`
    ) {
      void this.closeConnection();
    }
  }

  public static async getIpAddress(): Promise<string> {
    await this.config.isLoadedPromise;
    return this.config.serverDetails.ipAddress;
  }

  public static async getOrCreateConnection(retries = 3): Promise<SSHConnection> {
    await this.config.isLoadedPromise;
    console.log('Getting or creating SSH connection to', { ...this.config.serverDetails });
    this.connection ??= new SSHConnection({ ...this.config.serverDetails });
    try {
      await this.connection.connect(retries);
    } catch (e) {
      this.connection = undefined;
      throw e;
    }

    return this.connection;
  }

  public static async tryConnection(serverDetails: IConfigServerDetails): Promise<ITryServerData> {
    const connection = new SSHConnection({ ...serverDetails });
    await connection.connect(0);
    const server = new Server(connection, serverDetails);
    const walletAddress = await server.downloadAccountAddress();
    if (this.connection) {
      void this.connection.close(true);
    }
    this.connection = connection; // save the working connection

    if (!walletAddress)
      return {
        walletAddress: undefined,
        biddingRules: undefined,
        oldestFrameIdToSync: undefined,
      };

    const biddingRules = await server.downloadBiddingRules();
    const { oldestFrameIdToSync } = await server.downloadEnvState();

    return {
      walletAddress,
      biddingRules,
      oldestFrameIdToSync,
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
