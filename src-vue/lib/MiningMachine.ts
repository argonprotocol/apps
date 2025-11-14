import { enable as enableAutostart } from '@tauri-apps/plugin-autostart';
import { IConfigServerDetails, ServerType } from '../interfaces/IConfig';
import { Config } from './Config';
import { LocalMachine } from './LocalMachine';
import { SSH } from './SSH';
import { invokeWithTimeout } from './tauriApi';
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
  public static async setup(
    config: Config,
    walletKeys: WalletKeys,
    progressFn: (pct: number) => void,
  ): Promise<IConfigServerDetails> {
    const sshPublicKey = walletKeys.sshPublicKey;

    if (config.serverCreation?.digitalOcean) {
      const { apiKey } = config.serverCreation.digitalOcean;
      return await this.setupDigitalOcean(
        apiKey,
        sshPublicKey,
        config.miningAccountAddress,
        config.userJurisdiction,
        progressFn,
      );
    } else if (config.serverCreation?.customServer) {
      const { port, sshUser, ipAddress } = config.serverCreation.customServer;
      return await this.setupCustomServer(port, sshUser, ipAddress, config, progressFn);
    } else if (config.serverCreation?.localComputer) {
      return await this.setupLocalComputer(walletKeys.sshPublicKey, progressFn);
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
    userLocation: { latitude: string; longitude: string },
    progressFn: (pct: number) => void,
  ): Promise<IConfigServerDetails> {
    progressFn(5);
    const existing = await this.findExistingDigitalOceanDroplet(apiKey, miningAccountAddress);
    if (existing) {
      progressFn(100);
      return existing;
    }

    const dropletName = `Argon-Investor-Console-${NETWORK_NAME}-${INSTANCE_NAME.replace(/\s+/g, '-')}`.toLowerCase();
    const sshKey = await this.createSshKey(dropletName, apiKey, sshPublicKey);
    progressFn(25);
    const { region, size } = await this.chooseRegionAndSize(apiKey, userLocation);
    progressFn(40);

    const createRes = await fetch('https://api.digitalocean.com/v2/droplets', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        name: dropletName,
        region,
        size,
        image: 'ubuntu-25-04-x64',
        ssh_keys: [sshKey],
        tags: [miningAccountAddress],
      }),
    });
    const createData = (await createRes.json()) as ICreateDropletResponse;

    if (createRes.status !== 202) {
      console.log('[MINING_MACHINE] DigitalOcean setup response', createRes, createData);
      const extraDetail = (createData as any).message ?? '';
      throw new MiningMachineError(`Failed to create DigitalOcean droplet${extraDetail ? ` - ${extraDetail}` : ''}`);
    }
    progressFn(60);

    let progress = 60;
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
        progressFn(95);
        const result = await this.fetchDigitalOceanDroplet(apiKey, createData.droplet.id);
        progressFn(100);
        return result;
      }
      progress += 1;
      progress = Math.min(90, progress);
      progressFn(progress);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  public static async chooseRegionAndSize(
    apiKey: string,
    userLocation: { latitude: string; longitude: string },
  ): Promise<{ region: string; size: string }> {
    const preferredRegion = await this.chooseBestDigitalOceanRegion(userLocation);
    const regions = await fetch('https://api.digitalocean.com/v2/regions', {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
    });
    const regionsData = (await regions.json()) as {
      regions: {
        name: string;
        slug: string;
        features: string;
        available: boolean;
        sizes: string[];
      }[];
    };
    const regionSlugs = regionsData.regions.find(r => r.slug === preferredRegion && r.available);
    let size: string | null = null;
    const preferences = ['s-4vcpu-8gb', 's-4vcpu-8gb-amd', 's-4vcpu-8gb-intel'];
    if (regionSlugs) {
      for (const pref of preferences) {
        if (regionSlugs.sizes.includes(pref)) {
          size = pref;
          return { region: preferredRegion, size };
        }
      }
    }
    return { region: DEFAULT_REGION, size: preferences[0] };
  }

  public static async chooseBestDigitalOceanRegion(userJurisdiction: {
    longitude: string;
    latitude: string;
  }): Promise<string> {
    const lat = Number(userJurisdiction.latitude);
    const long = Number(userJurisdiction.longitude);
    if (isNaN(lat) || isNaN(long)) {
      console.log(`[MINING_MACHINE] Invalid user location, defaulting to ${DEFAULT_REGION}`, {
        lat,
        long,
        userJurisdiction,
      });
      return DEFAULT_REGION;
    }
    const regions = this.findClosestRegions({ lat, long });
    let best = null;
    let bestMs = BigInt(Number.MAX_SAFE_INTEGER);

    for (const region of regions) {
      const url = `https://${region}.digitaloceanspaces.com/cache_buster_${Date.now()}`;

      const ms = await invokeWithTimeout<bigint>('measure_latency', { url }, 5000).catch(() => bestMs);
      console.log(`[MINING_MACHINE] Latency to region ${region}: ${ms} ms`);
      if (ms < bestMs) {
        bestMs = ms;
        best = region;
      }
    }

    return best ?? DEFAULT_REGION;
  }

  private static findClosestRegions(location: ILatLog): string[] {
    const distances: { region: string; distance: number }[] = [];
    for (const [region, coords] of Object.entries(DO_REGIONS)) {
      const d = haversine(location, coords);
      distances.push({ region, distance: d });
    }
    distances.sort((a, b) => a.distance - b.distance);
    if (distances.length > 3) {
      distances.length = 3;
    }
    return distances.map(x => x.region);
  }

  private static async fetchDigitalOceanDroplet(apiKey: string, dropletId: string): Promise<IConfigServerDetails> {
    console.log('[MINING_MACHINE] Fetching DigitalOcean droplet', dropletId);
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

  public static async setupLocalComputer(
    sshPublicKey: string,
    progressFn: (pct: number) => void,
  ): Promise<IConfigServerDetails> {
    const newServerDetails: IConfigServerDetails = {
      type: ServerType.LocalComputer,
      ipAddress: `127.0.0.1`,
      port: 0,
      sshUser: 'argon',
      workDir: '/app',
    };

    progressFn(5);
    const dockerChecks = await this.runDockerChecks();
    if (!dockerChecks.isDockerStarted) {
      throw new MiningMachineError('Docker is not running');
    } else if (dockerChecks.blockedPorts.length) {
      throw new MiningMachineError(
        `Required ports are in use by other applications: ${String(dockerChecks.blockedPorts.join(', '))})`,
      );
    }
    progressFn(25);
    try {
      const { sshPort } = await LocalMachine.create(sshPublicKey);
      newServerDetails.port = sshPort;
    } catch (err) {
      throw new MiningMachineError(
        `Something went wrong trying to create your local Docker server. Try restarting Docker.`,
      );
    }
    progressFn(75);
    if (!IS_TEST) {
      await invokeWithTimeout('toggle_nosleep', { enable: true }, 5000);
      await enableAutostart();
    }
    progressFn(100);

    return newServerDetails;
  }

  public static async setupCustomServer(
    port: number,
    sshUser: string,
    ipAddress: string,
    config: Config,
    progressFn: (pct: number) => void,
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
    progressFn(100);

    if (serverMeta.walletAddress && serverMeta.walletAddress !== config.miningAccountAddress) {
      throw new MiningMachineError('The server has a different wallet address than your mining account.');
    }

    return newServerDetails;
  }
}

const R = 6371; // km

function haversine(loc1: ILatLog, loc2: ILatLog): number {
  const { lat: lat1, long: lon1 } = loc1;
  const { lat: lat2, long: lon2 } = loc2;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

interface ILatLog {
  lat: number;
  long: number;
}

const DEFAULT_REGION = 'nyc3';

// only add regions with digitaloceanspaces domains and latest DO sizes/images
const DO_REGIONS = {
  // nyc1: { lat: 40.7128, long: -74.006 }, // New York City
  // nyc2: { lat: 40.7128, long: -74.006 }, // same metro
  nyc3: { lat: 40.7128, long: -74.006 },

  ams3: { lat: 52.3676, long: 4.9041 }, // Amsterdam

  // sfo2: { lat: 37.7749, long: -122.4194 }, // San Francisco
  sfo3: { lat: 37.7749, long: -122.4194 },

  sgp1: { lat: 1.3521, long: 103.8198 }, // Singapore

  lon1: { lat: 51.5072, long: -0.1276 }, // London

  fra1: { lat: 50.1109, long: 8.6821 }, // Frankfurt

  tor1: { lat: 43.6532, long: -79.3832 }, // Toronto

  blr1: { lat: 12.9716, long: 77.5946 }, // Bangalore

  syd1: { lat: -33.8688, long: 151.2093 }, // Sydney

  atl1: { lat: 33.749, long: -84.388 }, // Atlanta
};
