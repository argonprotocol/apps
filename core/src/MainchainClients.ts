import { type ApiDecoration, type ArgonClient, getClient } from '@argonprotocol/mainchain';
import { wrapApi } from './ClientWrapper.js';
import { createTypedEventEmitter } from './utils.js';

export type ArgonQueryClient = ArgonClient | ApiDecoration<'promise'>;

interface ILastErrorInfo {
  errors: Error[];
  lastErrorTime: number;
}

interface IDisconnectLogInfo {
  message: string;
  time: number;
}

export class MainchainClients {
  public events = createTypedEventEmitter<{
    degraded: (error: Error | undefined, clientType: 'archive' | 'pruned') => void;
    working: (apiPath: string, clientType: 'archive' | 'pruned') => void;
    'on-pruned-client': (client: ArgonClient, url: string) => void;
  }>();
  public get prunedClientOrArchivePromise(): Promise<ArgonClient> {
    return this.prunedClientPromise ?? this.archiveClientPromise;
  }

  archiveUrl: string;
  archiveClientPromise: Promise<ArgonClient>;

  prunedUrl?: string;
  prunedClientPromise?: Promise<ArgonClient>;
  lastErrorByClient: { archive: ILastErrorInfo; pruned: ILastErrorInfo } = {
    archive: { errors: [], lastErrorTime: 0 },
    pruned: { errors: [], lastErrorTime: 0 },
  };
  private readonly lastDisconnectLogByClient: { archive: IDisconnectLogInfo; pruned: IDisconnectLogInfo } = {
    archive: { message: '', time: 0 },
    pruned: { message: '', time: 0 },
  };
  private isShuttingDown = false;

  constructor(
    archiveUrl: string,
    private enableApiLogging = () => true,
    connectedArchiveClient?: ArgonClient,
  ) {
    this.archiveUrl = archiveUrl;
    this.archiveClientPromise = (
      connectedArchiveClient ? Promise.resolve(connectedArchiveClient) : getMainchainClientOrThrow(archiveUrl)
    ).then(x => this.wrapClient(x, 'archive'));
  }

  public async setArchiveClient(url: string) {
    if (this.archiveUrl === url) {
      try {
        await this.archiveClientPromise;
        return; // No change, do nothing
      } catch {
        // Previous connection failed, try to reconnect
      }
    }
    const client = getMainchainClientOrThrow(url).then(x => this.wrapClient(x, 'archive'));
    this.archiveUrl = url;
    this.archiveClientPromise = client;
    return this.archiveClientPromise;
  }

  public async setPrunedClient(url: string): Promise<ArgonClient> {
    if (this.prunedUrl === url && this.prunedClientPromise) {
      return this.prunedClientPromise;
    }

    const previousClientPromise = this.prunedClientPromise;
    const client = await getMainchainClientOrThrow(url).then(client => this.wrapClient(client, 'pruned'));
    this.prunedClientPromise = Promise.resolve(client);
    this.prunedUrl = url;
    this.events.emit('on-pruned-client', client, url);
    void previousClientPromise?.then(previousClient => previousClient.disconnect()).catch(() => undefined);
    return this.prunedClientPromise;
  }

  public clearPrunedClient(): void {
    const previousClientPromise = this.prunedClientPromise;
    if (!previousClientPromise) return;

    this.prunedClientPromise = undefined;
    this.prunedUrl = undefined;
    void previousClientPromise.then(previousClient => previousClient.disconnect()).catch(() => undefined);
  }

  public async get(needsHistoricalBlocks: boolean): Promise<ArgonClient & { clientType: 'archive' | 'pruned' }> {
    let client: ArgonClient;
    if (needsHistoricalBlocks || !this.prunedClientPromise) {
      client = await this.archiveClientPromise;
      Object.assign(client, { clientType: 'archive' });
      return client as ArgonClient & { clientType: 'archive' };
    }
    client = await this.prunedClientPromise;
    Object.assign(client, { clientType: 'pruned' });
    return client as ArgonClient & { clientType: 'pruned' };
  }

  public async disconnect() {
    this.isShuttingDown = true;
    await Promise.allSettled([
      this.archiveClientPromise.then(client => client.disconnect()),
      this.prunedClientPromise?.then(client => client.disconnect()),
    ]);
  }

  private wrapClient(client: ArgonClient, clientType: 'archive' | 'pruned'): ArgonClient {
    let apiError: Error | undefined;
    const name = clientType === 'archive' ? 'ARCHIVE_RPC' : 'PRUNED_RPC';
    const api = wrapApi(client, name, {
      onError: (path, error, ...args) => {
        const disconnectMessage = error instanceof Error ? error.message : '';
        const lowered = disconnectMessage.toLowerCase();
        const isDisconnect = lowered.includes('disconnected from ws://') || lowered.includes('abnormal closure');
        if (isDisconnect) {
          if (!this.isShuttingDown) {
            const logInfo = this.lastDisconnectLogByClient[clientType];
            const shouldLog = logInfo.message !== disconnectMessage || Date.now() - logInfo.time > 5_000;
            if (shouldLog) {
              this.lastDisconnectLogByClient[clientType] = { message: disconnectMessage, time: Date.now() };
              console.info(`[${name}] ${path} disconnected: ${disconnectMessage}`);
            }
          }
          return;
        }

        if (apiError === error) return;
        apiError = error;
        const errorTracker = this.lastErrorByClient[clientType];
        errorTracker.errors.push(error);
        errorTracker.lastErrorTime = Date.now();
        if (errorTracker.errors.length > 5) {
          this.events.emit('degraded', error, clientType);
        }

        const argsJson = args.map(getJson);
        console.error(`[${name}] ${path}(${JSON.stringify(argsJson)}) Error:`, error);
      },
      onSuccess: (path, result, ...args) => {
        if (!path.includes('query.') && !path.includes('rpc.')) {
          return; // not api calls
        }
        apiError = undefined;
        if (this.lastErrorByClient[clientType]) {
          this.lastErrorByClient[clientType] = { errors: [], lastErrorTime: 0 };
        }
        this.events.emit('working', path, clientType);
        if (this.enableApiLogging()) {
          const resultJson = path.endsWith('.system.events') ? `${(result as any).length} events` : getJson(result);
          const argsJson = args.map(getJson);
          console.log(`[${name}] ${path}(${JSON.stringify(argsJson)})`, resultJson);
        }
      },
    });
    api.on('disconnected', () => {
      this.events.emit('degraded', undefined, clientType);
    });
    api.on('connected', () => {
      if (!apiError) this.events.emit('working', '', clientType);
    });
    return api;
  }
}

function getJson(a: unknown): any {
  if (!a || typeof a !== 'object') return a;
  if ('toJSON' in a && typeof a.toJSON === 'function') {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    return a.toJSON();
  }
  return a;
}

async function getMainchainClientOrThrow(host: string): Promise<ArgonClient> {
  return getClient(host, { throwOnConnect: true });
}
