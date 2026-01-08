import { fetch } from 'bun';

const LOCAL_NODE_URL = process.env.ARGON_LOCAL_NODE;
const MAIN_NODE_URL = process.env.ARGON_ARCHIVE_NODE;
const port = process.env.PORT || 8080;

const cache: {
  argon?: {
    latestBlocks: IBlockNumbers;
    timestamp: number;
  };
  bitcoin?: {
    latestBlocks: IBitcoinBlockNumbers & IBlockchainInfo;
    timestamp: number;
  };
} = {};

let requestId = 1;

console.log('Starting status server on port', port, {
  LOCAL_NODE_URL,
  MAIN_NODE_URL,
  BITCOIN_CHAIN: process.env.BITCOIN_CHAIN,
});
Bun.serve({
  port,
  routes: {
    '/': () => {
      return Response.json({
        status: 'ok',
        localNodeUrl: LOCAL_NODE_URL,
        mainNodeUrl: MAIN_NODE_URL,
        bitcoinConfig: process.env.BITCOIN_CONFIG,
        serverRoot: process.env.SERVER_ROOT,
      });
    },
    '/argon/iscomplete': safeJsonRoute(async () => {
      const response = await ArgonApis.isComplete();
      return Response.json(response, { status: typeof response === 'boolean' ? 200 : 500 });
    }),
    '/argon/latestblocks': safeJsonRoute(() => ArgonApis.latestBlocks()),
    '/argon/syncstatus': safeJsonRoute(() => ArgonApis.syncStatus()),
    '/bitcoin/getblockchaininfo': safeJsonRoute(() => BitcoinApis.blockchainInfo()),
    '/bitcoin/latestblocks': safeJsonRoute(() => BitcoinApis.latestBlocks()),
    '/bitcoin/syncstatus': safeJsonRoute(() => BitcoinApis.syncStatus()),
    '/bitcoin/recentblocks': safeJsonRoute(async req => {
      const blockCount = Number(new URL(req.url).searchParams.get('blockCount') || '10');
      return BitcoinApis.recentBlocks(blockCount);
    }),
  },

  fetch(_req) {
    return new Response('Not Found', { status: 404 });
  },
});

class ArgonApis {
  static buildProgressFile = Bun.file(`${process.env.LOGS_DIR}/step-ArgonInstall.progress-pull-argon-miner.json`);

  static async dockerPercentComplete(): Promise<number> {
    const percentComplete = await this.buildProgressFile.text().catch(() => '0');

    const percent = Number(percentComplete.trim());
    if (!percent) {
      return percent;
    }
    return getRoundedPercent(percent / 100);
  }

  static async latestBlocks(): Promise<IBlockNumbers> {
    const now = Date.now();
    if (cache.argon && now - cache.argon.timestamp < 2000) {
      return cache.argon.latestBlocks;
    }
    const [localNodeBlockNumber, mainNodeBlockNumber] = await Promise.all([
      this.getBlockNumber(LOCAL_NODE_URL),
      this.getBlockNumber(MAIN_NODE_URL),
    ]);
    cache.argon = { latestBlocks: { localNodeBlockNumber, mainNodeBlockNumber }, timestamp: now };
    return cache.argon.latestBlocks;
  }

  static async isComplete(): Promise<boolean | { error: string }> {
    const version = await callArgonRpc<{ specVersion: number }>(LOCAL_NODE_URL, 'state_getRuntimeVersion');

    if (version.result?.specVersion !== undefined) {
      const syncResponse = await callArgonRpc<{ isSyncing: boolean; peers: number }>(LOCAL_NODE_URL, 'system_health');
      return syncResponse.result?.isSyncing === false;
    }
    if (version.error?.code === 4003) return false;

    const response = { error: 'Unexpected response from node' };
    if (typeof version === 'object') {
      Object.assign(response, { rawResponse: version });
    }
    return response;
  }

  static async syncStatus(): Promise<{ syncPercent: number } & IBlockNumbers> {
    let dockerPercent = await this.dockerPercentComplete().catch(() => 0);
    const { localNodeBlockNumber, mainNodeBlockNumber } = await this.latestBlocks().catch(() => ({
      localNodeBlockNumber: 0,
      mainNodeBlockNumber: 0,
    }));
    // if we have any blocks, docker is definitely done
    if (localNodeBlockNumber > 0) {
      dockerPercent = 100;
    }

    let blockSyncPercent = mainNodeBlockNumber ? getRoundedPercent(localNodeBlockNumber / mainNodeBlockNumber) : 0;
    let syncPercent = getRoundedPercent((dockerPercent * 0.2 + blockSyncPercent * 0.8) / 100, 1);
    // if we're not all the way synced, don't report 100%
    if (syncPercent >= 100) {
      if (localNodeBlockNumber < mainNodeBlockNumber) {
        syncPercent = 99.9;
      } else {
        const complete = await this.isComplete().catch(() => false);
        if (complete !== true) syncPercent = 99.9;
      }
    }
    return { syncPercent, mainNodeBlockNumber, localNodeBlockNumber };
  }

  static async getBlockNumber(url: string): Promise<number> {
    url = url.replace('ws://', 'http://').replace('wss://', 'https://');
    const header = await callArgonRpc<{ number: string }>(url, 'chain_getHeader');
    // header.number is hex string, convert to number
    if (header.result?.number) {
      return parseInt(header.result.number, 16);
    }
    throw new Error(`Invalid getBlockNumber response from node: ${JSON.stringify(header)}`);
  }
}

class BitcoinApis {
  static dataPullProgressFile = Bun.file(`${process.env.LOGS_DIR}/step-BitcoinInstall.progress-pull-bitcoin-data.json`);
  static buildBitcoinProgressFile = Bun.file(`${process.env.LOGS_DIR}/step-BitcoinInstall.progress-build-bitcoin-node.json`);

  static async blockchainInfo(): Promise<IBlockchainInfo> {
    return callBitcoinRpc('getblockchaininfo');
  }

  static async dockerPercentComplete(): Promise<number> {
    const percents = await Promise.all([
      this.dataPullProgressFile.text().catch(() => '0'),
      this.buildBitcoinProgressFile.text().catch(() => '0'),
    ]);

    const sum = percents.reduce((acc, val) => {
      const value = Number(val.trim());
      if (!value) {
        return acc;
      }
      return acc + value;
    }, 0);
    return getRoundedPercent(sum / (percents.length * 100));
  }

  static async latestBlocks(): Promise<IBlockNumbers & IBlockchainInfo> {
    const now = Date.now();
    if (cache.bitcoin && now - cache.bitcoin.timestamp < 2000) {
      return cache.bitcoin.latestBlocks;
    }

    const blockchainInfo = await this.blockchainInfo();

    let mainNodeBlockNumber = 0;
    if (process.env.BITCOIN_CHAIN === 'mainnet') {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      const response = await fetch('https://blockchain.info/latestblock', {
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
      }).finally(() => clearTimeout(timeout));
      if (!response.ok) {
        throw new Error(`Blockchain.info responded with ${response.status}`);
      }
      const data = await response.json();
      mainNodeBlockNumber = data.block_index;
    } else {
      const peerinfo = await callBitcoinRpc<{ startingheight: number }[]>('getpeerinfo');
      for (const peer of peerinfo) {
        mainNodeBlockNumber = Math.max(peer.startingheight, mainNodeBlockNumber);
      }
    }
    cache.bitcoin = {
      latestBlocks: {
        localNodeBlockNumber: blockchainInfo.blocks,
        mainNodeBlockNumber,
        localNodeBlockTime: blockchainInfo.time,
        ...blockchainInfo,
        softforks: undefined,
        bip9_softforks: undefined,
      },
      timestamp: now,
    };
    return cache.bitcoin.latestBlocks;
  }

  static async syncStatus(): Promise<{ syncPercent: number } & IBlockNumbers> {
    let dockerPercent = await this.dockerPercentComplete().catch(() => 0);
    const { localNodeBlockNumber, mainNodeBlockNumber, initialblockdownload, blocks, headers } =
      await this.latestBlocks().catch(() => ({
        localNodeBlockNumber: 0,
        mainNodeBlockNumber: 0,
        initialblockdownload: true,
        blocks: 0,
        headers: 0,
      }));
    // if we have any blocks, docker is definitely done
    if (localNodeBlockNumber > 0) {
      dockerPercent = 100;
    }

    let blockSyncPercent = mainNodeBlockNumber ? getRoundedPercent(localNodeBlockNumber / mainNodeBlockNumber) : 0;
    const localSyncedInfo = await callBitcoinRpc<Record<string, { synced: boolean; best_block_height: number }>>(
      'getindexinfo',
    ).catch(() => ({
      na: { synced: false, best_block_height: 0 },
    }));
    const indexesSynced =
      Object.values(localSyncedInfo).every(index => index.synced && index.best_block_height === localNodeBlockNumber) &&
      Object.keys(localSyncedInfo).length > 0;

    let syncPercent = getRoundedPercent((dockerPercent * 0.7 + blockSyncPercent * 0.3) / 100, 1);

    const isTrulyComplete =
      indexesSynced && !initialblockdownload && blocks === headers && localNodeBlockNumber >= mainNodeBlockNumber;
    // if we're not all the way synced, don't report 100%
    if (syncPercent >= 100 && !isTrulyComplete) {
      syncPercent = 99.9;
    }
    return {
      syncPercent,
      mainNodeBlockNumber,
      localNodeBlockNumber,
      bitcoinNode: { indexinfo: localSyncedInfo, initialblockdownload, blocks, headers },
    } as any;
  }

  static async recentBlocks(blockCount: number): Promise<IBitcoinBlockMeta[]> {
    const blockcount = await callBitcoinRpc<number>('getblockcount');
    const hashes = await Promise.all(
      Array.from({ length: blockCount }, (_, i) => callBitcoinRpc<string>('getblockhash', blockcount - i)),
    );
    return await Promise.all(hashes.map(h => callBitcoinRpc<IBitcoinBlockMeta>('getblock', h, 1)));
  }
}

function getRoundedPercent(num: number, decimals = 1): number {
  const factor = Math.pow(10, decimals);

  const percent = Math.floor(100 * num * factor) / factor;
  return Math.min(percent, 100);
}

function safeJsonRoute(handler: (req: Request) => Promise<any>): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    try {
      const data = await handler(req);
      if (data && data instanceof Response) {
        return data;
      }
      return Response.json(data);
    } catch (err) {
      console.error('Route error:', err);
      return Response.json({ error: String(err) }, { status: 500 });
    }
  };
}

async function callBitcoinRpc<T = unknown>(method: string, ...params: any[]): Promise<T> {
  const body = JSON.stringify({
    jsonrpc: '1.0',
    id: requestId++,
    method,
    params,
  });
  const url = new URL(process.env.BITCOIN_RPC_URL!);
  const login = `${url.username}:${url.password}`;
  url.username = '';
  url.password = '';

  const res = await fetch(url.href, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${Buffer.from(login).toString('base64')}`,
    },
    body,
  });

  if (!res.ok) throw new Error(`Bitcoin RPC HTTP error ${res.status}`);
  const json = await res.json();

  if (json.error) throw new Error(`Bitcoin RPC error ${JSON.stringify(json.error)}`);
  return json.result as T;
}

async function callArgonRpc<T = unknown>(url: string, method: string, params: any[] = []): Promise<JsonRpcResponse<T>> {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: requestId++,
    method,
    params,
  });
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  if (!res.ok) throw new Error(`HTTP error ${res.status}`);
  return await res.json();
}

interface JsonRpcResponse<T = unknown> {
  jsonrpc: '2.0';
  id: number | string;
  result?: T;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface IBitcoinBlockNumbers extends IBlockNumbers {
  localNodeBlockTime: number;
}

interface IBlockNumbers {
  localNodeBlockNumber: number;
  mainNodeBlockNumber: number;
}

interface IBlockchainInfo {
  blocks: number;
  time: number;
  chain: string;
  headers: number;
  bestblockhash: string;
  difficulty: number;
  mediantime: number;
  verificationprogress: number;
  initialblockdownload: boolean;
  chainwork: string;
  size_on_disk: number;
  pruned: boolean;
  pruneheight?: number;
  automatic_pruning?: boolean;
  prune_target_size?: number;
  softforks: any[];
  bip9_softforks: Record<string, { status: string; startTime: number; timeout: number; since: number }>;
  warnings: string;
}

interface IBitcoinBlockMeta {
  hash: string;
  height: number;
  time: number;
  nTx: number;
  size: number;
  weight: number;
  merkleroot: string;
  previousblockhash: string;
  nextblockhash?: string;
  version: number;
  versionHex: string;
  bits: string;
  difficulty: number;
  chainwork: string;
  confirmations: number;
  strippedsize: number;
  nonce: number;
  mediantime: number;
  tx: string[];
}
