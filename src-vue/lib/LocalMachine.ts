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

  public static async checkBlockedPorts(): Promise<number[]> {
    console.log(`Finding blocked (needed) ports for local machine`);
    const neededPorts = await invokeWithTimeout<number[]>('check_needed_ports', {}, 10_000);
    if (neededPorts.length) {
      console.log(`Local machine is blocked on SSH ports: [${neededPorts.join(',')}]`);
    }
    return neededPorts;
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
