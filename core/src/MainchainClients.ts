import { type ApiDecoration, type ArgonClient, getClient } from '@argonprotocol/mainchain';
import { wrapApi } from './ClientWrapper.js';
import { createTypedEventEmitter } from './utils.js';

export type ArgonQueryClient = ArgonClient | ApiDecoration<'promise'>;
const stringifyApiLogValue = (_key: string, value: unknown) => (typeof value === 'bigint' ? value.toString() : value);

interface ILastErrorInfo {
  errors: Error[];
  lastErrorTime: number;
}

interface IDisconnectLogInfo {
  message: string;
  time: number;
}

type IClientType = 'archive' | 'pruned';
type IClientConnectionState = 'connected' | 'disconnected';

export class MainchainClients {
  public events = createTypedEventEmitter<{
    'connection-state-changed': (hasConnectedClient: boolean) => void;
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
  private readonly connectionStateByClient: Record<IClientType, IClientConnectionState> = {
    archive: 'disconnected',
    pruned: 'disconnected',
  };
  private readonly currentClientByType: { archive?: ArgonClient; pruned?: ArgonClient } = {};
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
    ).then(client => this.wrapClient(client, 'archive'));
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
    const previousClientPromise = this.archiveClientPromise;
    this.archiveUrl = url;
    this.archiveClientPromise = getMainchainClientOrThrow(url).then(client => this.wrapClient(client, 'archive'));
    const connectedClient = await this.archiveClientPromise;
    void previousClientPromise.then(previousClient => previousClient.disconnect()).catch(() => undefined);
    return connectedClient;
  }

  public async setPrunedClient(url: string): Promise<ArgonClient> {
    if (this.prunedUrl === url && this.prunedClientPromise) {
      return this.prunedClientPromise;
    }

    const previousClientPromise = this.prunedClientPromise;
    this.prunedUrl = url;
    this.prunedClientPromise = getMainchainClientOrThrow(url).then(client => this.wrapClient(client, 'pruned'));
    const client = await this.prunedClientPromise;
    this.events.emit('on-pruned-client', client, url);
    void previousClientPromise?.then(previousClient => previousClient.disconnect()).catch(() => undefined);
    return this.prunedClientPromise;
  }

  public clearPrunedClient(): void {
    const previousClientPromise = this.prunedClientPromise;
    if (!previousClientPromise) return;

    this.prunedClientPromise = undefined;
    this.prunedUrl = undefined;
    this.currentClientByType.pruned = undefined;
    this.setConnectionState('pruned', 'disconnected');
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

  public hasConnectedClient(): boolean {
    if (this.connectionStateByClient.archive === 'connected') {
      return true;
    }

    if (!this.prunedClientPromise) {
      return false;
    }

    return this.connectionStateByClient.pruned === 'connected';
  }

  private wrapClient(client: ArgonClient, clientType: IClientType): ArgonClient {
    let apiError: Error | undefined;
    const name = clientType === 'archive' ? 'ARCHIVE_RPC' : 'PRUNED_RPC';
    const api = wrapApi(client, name, {
      onError: (path, error, ...args) => {
        if (this.currentClientByType[clientType] !== api || this.connectionStateByClient[clientType] !== 'connected') {
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
        console.error(`[${name}] ${path}(${JSON.stringify(argsJson, stringifyApiLogValue)}) Error:`, error);
      },
      onSuccess: (path, result, ...args) => {
        if (!path.includes('query.') && !path.includes('rpc.')) {
          return; // not api calls
        }
        if (this.currentClientByType[clientType] !== api) {
          return;
        }
        apiError = undefined;
        if (this.lastErrorByClient[clientType]) {
          this.lastErrorByClient[clientType] = { errors: [], lastErrorTime: 0 };
        }
        this.events.emit('working', path, clientType);
        if (this.enableApiLogging()) {
          const resultJson = path.endsWith('.system.events') ? `${(result as any).length} events` : getJson(result);
          const argsJson = args.map(getJson);
          console.log(`[${name}] ${path}(${JSON.stringify(argsJson, stringifyApiLogValue)})`, resultJson);
        }
      },
    });
    this.currentClientByType[clientType] = api;
    this.setConnectionState(clientType, 'connected');
    api.on('disconnected', () => {
      if (this.currentClientByType[clientType] !== api) {
        return;
      }

      this.setConnectionState(clientType, 'disconnected');
      this.events.emit('degraded', undefined, clientType);
      if (this.isShuttingDown) {
        return;
      }

      const disconnectMessage = `${name} disconnected`;
      const logInfo = this.lastDisconnectLogByClient[clientType];
      const shouldLog = logInfo.message !== disconnectMessage || Date.now() - logInfo.time > 5_000;
      if (shouldLog) {
        this.lastDisconnectLogByClient[clientType] = { message: disconnectMessage, time: Date.now() };
        console.info(`[${name}] transport disconnected`);
      }
    });
    api.on('connected', () => {
      if (this.currentClientByType[clientType] !== api) {
        return;
      }
      this.setConnectionState(clientType, 'connected');
      if (!apiError) this.events.emit('working', '', clientType);
    });
    return api;
  }

  private setConnectionState(clientType: IClientType, connectionState: IClientConnectionState): void {
    if (this.connectionStateByClient[clientType] === connectionState) {
      return;
    }

    this.connectionStateByClient[clientType] = connectionState;
    this.events.emit('connection-state-changed', this.hasConnectedClient());
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
