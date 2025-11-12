import { enable as enableAutostart } from '@tauri-apps/plugin-autostart';
import { IConfigServerDetails, ServerType } from '../interfaces/IConfig';
import { Config } from './Config';
import { LocalMachine } from './LocalMachine';
import { SSH } from './SSH';
import { invokeWithTimeout } from './tauriApi';
import { SSHFingerprint } from './SSHFingerprint';
import { INSTANCE_NAME, IS_TEST, NETWORK_NAME } from './Env';
import { WalletKeys } from './WalletKeys.ts';

export class MiningMachineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MiningMachineError';
  }
}

// DigitalOcean API response types
type IDropletActionLink = { id: number; rel: string; href: string };
type ICreateDropletResponse = {
  links: { actions: IDropletActionLink[] };
  droplet: { id: string };
};
type IDropletNetworkV4 = { ip_address: string; netmask: string; gateway: string; type: string };
type IDroplet = {
  id: string;
  status: string;
  networks: { v4: IDropletNetworkV4[] };
};

export class MiningMachine {
  public static async setup(config: Config, walletKeys: WalletKeys): Promise<IConfigServerDetails> {
    const sshPublicKey = walletKeys.sshPublicKey;

    if (config.serverCreation?.digitalOcean) {
      const { apiKey } = config.serverCreation.digitalOcean;
      return await this.setupDigitalOcean(apiKey, sshPublicKey, config.miningAccountAddress);
    } else if (config.serverCreation?.customServer) {
      const { port, sshUser, ipAddress } = config.serverCreation.customServer;
      return await this.setupCustomServer(port, sshUser, ipAddress, config);
    } else if (config.serverCreation?.localComputer) {
      return await this.setupLocalComputer(walletKeys.sshPublicKey);
    } else {
      throw new MiningMachineError('No server creation data found');
    }
  }

  public static async testDigitalOcean(apiKey: string) {
    const res = await fetch('https://api.digitalocean.com/v2/droplets', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        name: 'perm-scope-probe',
        region: 'invalid',
        size: 'invalid',
        image: 'invalid',
      }),
    });
    const data = await res.json();
    if (data.id === 'Unauthorized') {
      throw new MiningMachineError('Unauthorized');
    }
  }

  public static async createSshKey(sshKeyName: string, apiKey: string, sshPublicKey: string): Promise<string> {
    const listRes = await fetch('https://api.digitalocean.com/v2/account/keys', {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
    });
    const listData = (await listRes.json()) as {
      ssh_keys: { id: string; fingerprint: string; public_key: string; name: string }[];
    };
    let key = listData.ssh_keys.find(k => k.public_key === sshPublicKey);

    if (!key) {
      const createKeyRes = await fetch('https://api.digitalocean.com/v2/account/keys', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          name: sshKeyName,
          public_key: sshPublicKey,
        }),
      });
      const createKeyData = await createKeyRes.json();
      key = createKeyData.ssh_key;
    }
    if (!key) {
      throw new MiningMachineError('Failed to create SSH key on DigitalOcean');
    }
    return key.id;
  }

  public static async setupDigitalOcean(
    apiKey: string,
    sshPublicKey: string,
    miningAccountAddress: string,
  ): Promise<IConfigServerDetails> {
    const existing = await this.findExistingDigitalOceanDroplet(apiKey, miningAccountAddress);
    if (existing) {
      return existing;
    }

    const dropletName = `Argon-Investor-Console-${NETWORK_NAME}-${INSTANCE_NAME.replace(/\s+/g, '-')}`.toLowerCase();
    const sshKey = await this.createSshKey(dropletName, apiKey, sshPublicKey);
    const createRes = await fetch('https://api.digitalocean.com/v2/droplets', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        name: dropletName,
        // TODO: pick closest to user jurisdiction
        region: 'sfo3',
        size: 's-4vcpu-8gb',
        image: 'ubuntu-25-04-x64',
        ssh_keys: [sshKey],
        tags: [miningAccountAddress],
      }),
    });
    const createData = (await createRes.json()) as ICreateDropletResponse;

    if (createRes.status !== 202) {
      console.log('DigitalOcean setup response', createRes, createData);
      throw new MiningMachineError('Failed to create DigitalOcean droplet');
    }

    while (true) {
      const statusLink = createData.links.actions.find((x: IDropletActionLink) => x.rel === 'create');
      if (!statusLink) {
        throw new MiningMachineError('DigitalOcean did not return a droplet creation status link');
      }
      const statusRes = await fetch(`https://api.digitalocean.com${statusLink.href}`, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
      });
      const statusData = await statusRes.json();
      if (statusData.action.status === 'completed') {
        return await this.fetchDigitalOceanDroplet(apiKey, createData.droplet.id);
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  private static async fetchDigitalOceanDroplet(apiKey: string, dropletId: string): Promise<IConfigServerDetails> {
    console.log('Fetching DigitalOcean droplet', dropletId);
    const res = await fetch(`https://api.digitalocean.com/v2/droplets/${dropletId}`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
    });
    const data = (await res.json()) as { droplet: IDroplet };
    const serverDetails = this.extractDigitalOceanServerDetails(data.droplet);
    if (serverDetails) {
      return serverDetails;
    }

    await new Promise(resolve => setTimeout(resolve, 1000));
    return this.fetchDigitalOceanDroplet(apiKey, dropletId);
  }

  private static async findExistingDigitalOceanDroplet(
    apiKey: string,
    miningAccountAddress: string,
  ): Promise<IConfigServerDetails | null> {
    const res = await fetch(`https://api.digitalocean.com/v2/droplets?tag_name=${miningAccountAddress}`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
    });
    const data = (await res.json()) as { droplets: IDroplet[] };
    if (data.droplets.length === 0) return null;

    const serverDetails = this.extractDigitalOceanServerDetails(data.droplets[0]);
    if (serverDetails) {
      return serverDetails;
    }
    return this.fetchDigitalOceanDroplet(apiKey, data.droplets[0].id);
  }

  private static extractDigitalOceanServerDetails(droplet: IDroplet): IConfigServerDetails | null {
    if (droplet.status !== 'active') return null;

    const publicNetwork = droplet.networks.v4.find((x: IDropletNetworkV4) => x.type === 'public');
    if (!publicNetwork) return null;

    return {
      type: ServerType.DigitalOcean,
      sshUser: 'root',
      ipAddress: publicNetwork.ip_address,
      port: 22,
      workDir: '~',
    };
  }

  public static async runDockerChecks() {
    const response = {
      isDockerStarted: false,
      blockedPorts: [] as number[],
    };
    try {
      response.isDockerStarted = await LocalMachine.isDockerRunning();
    } catch (e) {
      /* no action */
    }

    // check for blocked ports
    try {
      response.blockedPorts = await LocalMachine.checkBlockedPorts();
    } catch (e) {
      /* no action */
    }

    return response;
  }

  public static async setupLocalComputer(sshPublicKey: string): Promise<IConfigServerDetails> {
    const newServerDetails: IConfigServerDetails = {
      type: ServerType.LocalComputer,
      ipAddress: `127.0.0.1`,
      port: 0,
      sshUser: 'argon',
      workDir: '/app',
    };

    const dockerChecks = await this.runDockerChecks();
    if (!dockerChecks.isDockerStarted) {
      throw new MiningMachineError('Docker is not running');
    } else if (dockerChecks.blockedPorts.length) {
      throw new MiningMachineError(
        `Required ports are in use by other applications: ${String(dockerChecks.blockedPorts.join(', '))})`,
      );
    }
    try {
      const { sshPort } = await LocalMachine.create(sshPublicKey);
      newServerDetails.port = sshPort;
    } catch (err) {
      throw new MiningMachineError(
        `Something went wrong trying to create your local Docker server. Try restarting Docker.`,
      );
    }

    if (!IS_TEST) {
      await invokeWithTimeout('toggle_nosleep', { enable: true }, 5000);
      await enableAutostart();
    }

    return newServerDetails;
  }

  public static async setupCustomServer(
    port: number,
    sshUser: string,
    ipAddress: string,
    config: Config,
  ): Promise<IConfigServerDetails> {
    const newServerDetails: IConfigServerDetails = {
      type: ServerType.CustomServer,
      port,
      sshUser: sshUser,
      ipAddress: ipAddress,
      workDir: '~',
    };

    const serverMeta = await (async () => {
      try {
        return await SSH.tryConnection(newServerDetails);
      } catch {
        throw new MiningMachineError('A SSH connection could not be established to your server.');
      }
    })();

    if (serverMeta.walletAddress && serverMeta.walletAddress !== config.miningAccountAddress) {
      throw new MiningMachineError('The server has a different wallet address than your mining account.');
    }

    return newServerDetails;
  }
}
