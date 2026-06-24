import { InvokeTimeout, invokeWithTimeout } from './tauriApi';
import { listen } from '@tauri-apps/api/event';
import { IConfigServerDetails, ServerType } from '../interfaces/IConfig.ts';

export type ISSHConfig = IConfigServerDetails;

export class SSHConnection {
  public isConnected = false;
  public isConnectedPromise?: Promise<void>;

  public get address() {
    return `${this.host}:${this.port}`;
  }

  public host: string;
  public port: number;
  public username: string;
  public isDockerHostProxy = false;
  public isDestroyed = false;

  constructor(sshConfig: ISSHConfig) {
    this.host = sshConfig.ipAddress;
    this.port = sshConfig.sshPort ?? 22;
    this.username = sshConfig.sshUser;
    this.isDockerHostProxy = sshConfig.type === ServerType.LocalComputer;
  }

  public async connect(retries = 3): Promise<void> {
    if (this.isConnectedPromise || this.isDestroyed) {
      return this.isConnectedPromise;
    }

    this.isConnected = false;
    const connectStartedAt = Date.now();
    this.isConnectedPromise = new Promise(async (resolve, reject) => {
      const sshConfig = {
        address: this.address,
        host: this.host,
        port: this.port,
        username: this.username,
      };
      if (!sshConfig.host) {
        reject(new Error('No SSH host config provided'));
        return;
      }
      try {
        await invokeWithTimeout('open_ssh_connection', sshConfig, 30e3);
        this.isConnected = true;
        resolve();
      } catch (error) {
        const errorString = String(error).toLowerCase();
        const shouldRetry =
          retries > 0 &&
          !this.isDestroyed &&
          (error instanceof InvokeTimeout ||
            errorString.includes('connection refused') ||
            errorString.includes('host unreachable') ||
            errorString.includes('timed out'));
        if (shouldRetry) {
          console.warn(
            `[SSHConnection] Connect failed for ${this.address} after ${Date.now() - connectStartedAt}ms; ` +
              `retrying with ${retries} retries remaining (${errorString})`,
          );
          await new Promise(r => setTimeout(r, 1000));
          await this.close().catch(() => undefined);
          return this.connect(retries - 1).then(resolve, reject);
        }
        console.error(
          `[SSHConnection] Connect failed for ${this.address} after ${Date.now() - connectStartedAt}ms`,
          error,
        );
        reject(error);
      }
    });

    return this.isConnectedPromise;
  }

  public async runCommandWithTimeout(command: string, timeout: number, retries = 1): Promise<[string, number]> {
    const payload = { address: this.address, command };

    try {
      return await invokeWithTimeout('ssh_run_command', payload, timeout);
    } catch (error) {
      if (retries <= 0 || this.isDestroyed) {
        throw error;
      }

      const errorMessage = String(error);
      const isReconnectableError =
        error instanceof InvokeTimeout ||
        errorMessage === 'SSHCommandMissingExitStatus' ||
        errorMessage === 'No SSH connection';
      if (!isReconnectableError) {
        throw error;
      }

      await this.close().catch(() => undefined);
      await this.connect();
      return await this.runCommandWithTimeout(command, timeout, retries - 1);
    }
  }

  public async uploadFileWithTimeout(contents: string, remotePath: string, timeout: number): Promise<void> {
    const payload = { address: this.address, contents, remotePath };
    return await invokeWithTimeout('ssh_upload_file', payload, timeout);
  }

  public async uploadEmbeddedFileWithTimeout(
    localRelativePath: string,
    remotePath: string,
    progressCallback: (progress: number) => void,
    timeout: number,
  ): Promise<void> {
    const eventProgressKey = localRelativePath.replace(/[^a-zA-Z0-9]/g, '_') + '_up_progress';
    const unsub = await listen(eventProgressKey, event => {
      progressCallback(event.payload as number);
      if (event.payload === 100) {
        unsub(); // Unsubscribe when upload is complete
      }
    });
    try {
      const payload = { address: this.address, localRelativePath, remotePath, eventProgressKey };
      await invokeWithTimeout('ssh_upload_embedded_file', payload, timeout);
    } catch (e) {
      unsub();
      throw e;
    }
  }

  public async downloadFileWithTimeout(
    remotePath: string,
    downloadPath: string,
    progressCallback: (progress: number) => void,
    timeout: number,
  ): Promise<void> {
    const eventProgressKey = remotePath.replace(/[^a-zA-Z0-9]/g, '_') + '_dl_progress';
    const unsub = await listen(eventProgressKey, event => {
      progressCallback(event.payload as number);
      if (event.payload === 100) {
        unsub(); // Unsubscribe when upload is complete
      }
    });
    try {
      const payload = { address: this.address, downloadPath, remotePath, eventProgressKey };
      await invokeWithTimeout('ssh_download_file', payload, timeout);
    } catch (e) {
      unsub();
      throw e;
    }
  }

  public async close(destroy = false): Promise<void> {
    const payload = { address: this.address };
    try {
      await invokeWithTimeout('close_ssh_connection', payload, 5_000);
    } finally {
      this.isConnectedPromise = undefined;
      this.isConnected = false;
      if (destroy) {
        this.isDestroyed = true;
      }
    }
  }
}
