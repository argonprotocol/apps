import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Config } from '../lib/Config.ts';
import { MiningMachine } from '../lib/MiningMachine.ts';
import { ServerType } from '../interfaces/IConfig.ts';
import { createMockedDbPromise } from './helpers/db.ts';
import { createTestWallet } from './helpers/wallet.ts';

const invokeWithTimeout = vi.hoisted(() => vi.fn());
vi.mock('../lib/tauriApi.ts', () => ({ invokeWithTimeout }));

let config: Config;
let walletKeys: ReturnType<typeof createTestWallet>['walletKeys'];
let regions = [{ slug: 'atl1', available: true, sizes: ['s-4vcpu-8gb', 's-4vcpu-8gb-amd'] }];
const creationRequests: RequestInit[] = [];
const creationResponses: (Response | Error)[] = [];

beforeEach(async () => {
  creationRequests.length = 0;
  creationResponses.length = 0;
  regions = [{ slug: 'atl1', available: true, sizes: ['s-4vcpu-8gb', 's-4vcpu-8gb-amd'] }];
  invokeWithTimeout.mockReset().mockImplementation(async (_command, { url }: { url: string }) => {
    if (new URL(url).hostname.startsWith('atl1.')) return 1n;
    return 10n;
  });

  ({ walletKeys } = createTestWallet('//DigitalOceanFallback'));
  config = new Config(
    createMockedDbPromise({
      userJurisdiction: JSON.stringify({
        ipAddress: '203.0.113.20',
        city: 'Synthetic City',
        region: 'Synthetic Region',
        countryName: 'Synthetic Country',
        countryCode: 'US',
        latitude: '35',
        longitude: '-85',
      }),
    }),
    walletKeys,
  );
  await config.load();
  config.serverAdd = { digitalOcean: { apiKey: 'synthetic-digitalocean-token' } };

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/v2/regions') return Response.json({ regions });
      if (url.pathname === '/v2/account/keys') {
        return Response.json({ ssh_keys: [{ id: 'synthetic-key', public_key: walletKeys.sshPublicKey }] });
      }
      if (url.pathname === '/v2/droplets' && init?.method !== 'POST') {
        return Response.json({ droplets: [] });
      }
      if (url.pathname === '/v2/droplets' && init?.method === 'POST') {
        creationRequests.push(init);
        const response = creationResponses.shift();
        if (response instanceof Error) throw response;
        if (response) return response;

        const { region, size } = JSON.parse(init.body as string);
        const advertised = regions.find(entry => entry.slug === region && entry.available);
        if (!advertised?.sizes.includes(size)) {
          return Response.json({ message: 'size is not available in this region' }, { status: 422 });
        }
        return Response.json(
          { droplet: { id: 'synthetic-droplet' }, links: { actions: [{ rel: 'create', href: '/v2/actions/1' }] } },
          { status: 202 },
        );
      }
      if (url.pathname === '/v2/actions/1') return Response.json({ action: { status: 'completed' } });
      if (url.pathname === '/v2/droplets/synthetic-droplet') {
        return Response.json({
          droplet: {
            status: 'active',
            networks: { v4: [{ type: 'public', ip_address: '203.0.113.10' }] },
          },
        });
      }
      throw new Error(`Unexpected DigitalOcean request: ${url.pathname}`);
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

it('tries another advertised size when DigitalOcean rejects the preferred size', async () => {
  creationResponses.push(Response.json({ message: 'Size is not available in this region' }, { status: 422 }));

  const details = await MiningMachine.setup(config, walletKeys);

  expect(details).toEqual({
    type: ServerType.DigitalOcean,
    sshUser: 'root',
    ipAddress: '203.0.113.10',
    sshPort: 22,
    workDir: '~',
  });
  expect(creationRequests.map(request => JSON.parse(request.body as string) as unknown)).toMatchObject([
    { region: 'atl1', size: 's-4vcpu-8gb' },
    { region: 'atl1', size: 's-4vcpu-8gb-amd' },
  ]);
});

it('uses an available region instead of requesting an unchecked New York fallback', async () => {
  regions = [
    { slug: 'atl1', available: true, sizes: [] },
    { slug: 'nyc3', available: true, sizes: [] },
    { slug: 'tor1', available: true, sizes: ['s-4vcpu-8gb-amd'] },
  ];

  const details = await MiningMachine.setup(config, walletKeys);

  expect(details.ipAddress).toBe('203.0.113.10');
  expect(creationRequests.map(request => JSON.parse(request.body as string) as unknown)).toMatchObject([
    { region: 'tor1', size: 's-4vcpu-8gb-amd' },
  ]);
});

it('tries another region after all advertised sizes in the preferred region are rejected', async () => {
  regions.push({ slug: 'tor1', available: true, sizes: ['s-4vcpu-8gb'] });
  creationResponses.push(
    Response.json({ message: 'size is not available in this region' }, { status: 422 }),
    Response.json({ message: 'size is not available in this region' }, { status: 422 }),
  );

  const details = await MiningMachine.setup(config, walletKeys);

  expect(details.ipAddress).toBe('203.0.113.10');
  expect(creationRequests.map(request => JSON.parse(request.body as string) as unknown)).toMatchObject([
    { region: 'atl1', size: 's-4vcpu-8gb' },
    { region: 'atl1', size: 's-4vcpu-8gb-amd' },
    { region: 'tor1', size: 's-4vcpu-8gb' },
  ]);
});

it('finishes with an actionable error after every advertised option is rejected', async () => {
  creationResponses.push(
    Response.json({ message: 'size is not available in this region' }, { status: 422 }),
    Response.json({ message: 'size is not available in this region' }, { status: 422 }),
  );

  await expect(MiningMachine.setup(config, walletKeys)).rejects.toThrow(
    'DigitalOcean has no capacity for the available 4 CPU / 8 GB machines. Please try again later.',
  );
  expect(creationRequests.map(request => JSON.parse(request.body as string) as unknown)).toMatchObject([
    { region: 'atl1', size: 's-4vcpu-8gb' },
    { region: 'atl1', size: 's-4vcpu-8gb-amd' },
  ]);
});

it('does not request a machine when every advertised region is unavailable or lacks a supported size', async () => {
  regions = [
    { slug: 'atl1', available: false, sizes: ['s-4vcpu-8gb'] },
    { slug: 'nyc3', available: true, sizes: ['s-1vcpu-1gb'] },
  ];

  await expect(MiningMachine.setup(config, walletKeys)).rejects.toThrow(
    'DigitalOcean has no available 4 CPU / 8 GB machines in the supported regions. Please try again later.',
  );
  expect(creationRequests).toHaveLength(0);
});

it.each([
  { reason: 'authorization', status: 401, message: 'Unauthorized' },
  { reason: 'account limits', status: 422, message: 'Droplet limit exceeded' },
  { reason: 'server failure', status: 500, message: 'Internal server error' },
])('stops after a creation rejection caused by $reason', async ({ status, message }) => {
  creationResponses.push(Response.json({ message }, { status }));

  await expect(MiningMachine.setup(config, walletKeys)).rejects.toThrow(
    `Failed to create DigitalOcean droplet - ${message}`,
  );
  expect(creationRequests).toHaveLength(1);
});

it('does not create another machine after an ambiguous transport failure', async () => {
  creationResponses.push(new Error('Request timed out'));

  await expect(MiningMachine.setup(config, walletKeys)).rejects.toThrow('Request timed out');
  expect(creationRequests).toHaveLength(1);
});
