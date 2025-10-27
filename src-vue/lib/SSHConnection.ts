import { invokeWithTimeout } from './tauriApi';
import { listen } from '@tauri-apps/api/event';
import { IConfigServerDetails, ServerType } from '../interfaces/IConfig.ts';

export interface ISSHConfig extends IConfigServerDetails {
  privateKeyPath?: string;
}

export class SSHConnection {
  public isConnected = false;
  public isConnectedPromise?: Promise<void>;

  public get address() {
    return `${this.host}:${this.port}`;
  }

  public host: string;
  public port: number;
  public username: string;
  public privateKeyPath?: string;
  public isDockerHostProxy = false;
  public isDestroyed = false;

  constructor(sshConfig: ISSHConfig) {
    this.host = sshConfig.ipAddress;
    this.port = sshConfig.port ?? 22;
    this.username = sshConfig.sshUser;
    this.privateKeyPath = sshConfig.privateKeyPath;
    this.isDockerHostProxy = sshConfig.type === ServerType.LocalComputer;
  }

  public async connect(retries = 3): Promise<void> {
    if (this.isConnectedPromise || this.isDestroyed) {
      return this.isConnectedPromise;
    }

    this.isConnected = false;
    this.isConnectedPromise = new Promise(async (resolve, reject) => {
      const sshConfig = {
        address: this.address,
        host: this.host,
        port: this.port,
        username: this.username,
        privateKeyPath: this.privateKeyPath,
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
        if (String(error).toLowerCase().includes('connection refused') && retries > 0 && !this.isDestroyed) {
          console.log(`Connection refused... retrying ${3 - retries + 1}/3`);
          await new Promise(r => setTimeout(r, 1000 * (4 - retries)));
          await this.close();
          return this.connect(retries - 1);
        }
        reject(error);
      }
    });

    return this.isConnectedPromise;
  }

  public async runCommandWithTimeout(command: string, timeout: number): Promise<[string, number]> {
    const payload = { address: this.address, command };
    return await invokeWithTimeout('ssh_run_command', payload, timeout);
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
    await invokeWithTimeout('close_ssh_connection', payload, 5_000);
    this.isConnectedPromise = undefined;
    this.isConnected = false;
    if (destroy) {
      this.isDestroyed = true;
    }
  }
}
