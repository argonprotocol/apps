import { DOCKER_COMPOSE_PROJECT_NAME } from './ServerAdmin.ts';
import { invokeWithTimeout } from './tauriApi.ts';
import { message } from '@tauri-apps/plugin-dialog';

export class LocalMachine {
  public static async create(sshPubkey: string): Promise<{ sshPort: number }> {
    console.log(`Creating local machine`);
    const sshPort = await invokeWithTimeout<number>(
      'create_local_vm',
      { envText: `COMPOSE_PROJECT_NAME=${DOCKER_COMPOSE_PROJECT_NAME}\nSSH_PUBKEY="${sshPubkey.trim()}"` },
      120_000,
    );
    console.log(`Local machine created SSH port: ${sshPort}`);

    return { sshPort };
  }

  public static async findAvailablePort(startingPort: number): Promise<number> {
    return await invokeWithTimeout<number>('find_available_port', { startingPort }, 10_000);
  }

  public static async isDockerRunning(): Promise<boolean> {
    return await invokeWithTimeout<boolean>('is_docker_running', {}, 60e3);
  }

  public static async activate(): Promise<{ sshPort: number }> {
    console.log(`Loading local machine`);
    while (!(await this.isDockerRunning())) {
      await message(`Docker does not appear to be running. Please open Docker Desktop and try again.`, {
        title: 'Docker Not Running',
        kind: 'error',
        okLabel: "It's Running Now",
      });
    }
    const sshPort = await invokeWithTimeout<number>('activate_local_vm', {}, 120_000);
    console.log(`Local machine SSH port: ${sshPort}`);
    return { sshPort };
  }

  public static async remove() {
    console.log(`Removing local machine`);
    await invokeWithTimeout('remove_local_vm', {}, 60e3);
    console.log(`Local machine removed`);
  }
}
