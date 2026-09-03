import { type ApiDecoration, type ArgonClient as PolkadotArgonClient, getClient } from '@argonprotocol/mainchain';
import {
  isRuntimeClient,
  runtimeClient,
  type CurrentRuntimeQueries,
  type RuntimeClient,
  type RuntimeQueries,
} from '@argonprotocol/runtime-client';
import { wrapApi } from './ClientWrapper.js';
import { createDeferred, type IDeferred } from './Deferred.js';
import { createTypedEventEmitter, raceWithTimeout } from './utils.js';

export type ArgonApi = RuntimeClient<ApiDecoration<'promise'>, RuntimeQueries>;
export type ArgonCurrentApi = RuntimeClient<PolkadotArgonClient, CurrentRuntimeQueries>;
export type ArgonCurrentQueryClient = RuntimeClient<ApiDecoration<'promise'>, CurrentRuntimeQueries>;
export type ArgonClient = ArgonCurrentApi;
export type ArgonQueryClient = ArgonCurrentApi | ArgonCurrentQueryClient | ArgonApi;
const stringifyApiLogValue = (_key: string, value: unknown) => (typeof value === 'bigint' ? value.toString() : value);

export function createArgonClient(client: PolkadotArgonClient): ArgonClient {
  return runtimeClient(client);
}

interface ILastErrorInfo {
  errors: Error[];
  lastErrorTime: number;
}

interface IDisconnectLogInfo {
  message: string;
  time: number;
}

interface IPrunedCandidate {
  url: string;
  connection: Promise<ArgonClient>;
  ready: IDeferred<ArgonClient>;
}

type IClientType = 'archive' | 'pruned';
type IClientConnectionState = 'connected' | 'disconnected';

export class MainchainClients {
  private static readonly prunedStateProbeTimeoutMs = 60e3;
  private static readonly prunedStateProbeRetryMs = 5e3;

  public events = createTypedEventEmitter<{
    'connection-state-changed': (hasConnectedClient: boolean) => void;
    degraded: (error: Error | undefined, clientType: 'archive' | 'pruned') => void;
    working: (apiPath: string, clientType: 'archive' | 'pruned') => void;
    'on-pruned-client': (client: ArgonClient, url: string) => void;
  }>();
  public get prunedClientOrArchivePromise(): Promise<ArgonClient> {
    return this.prunedClientPromise ?? this.archiveClientPromise;
  }
  public get prunedUrl(): string | undefined {
    return this.prunedCandidate?.url;
  }

  archiveUrl: string;
  archiveClientPromise: Promise<ArgonClient>;

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
  private prunedCandidate?: IPrunedCandidate;
  private prunedStateProbePromise?: Promise<void>;
  private prunedStateProbeTimer?: ReturnType<typeof setTimeout>;
  private isShuttingDown = false;

  constructor(
    archiveUrl: string,
    private enableApiLogging = () => true,
    connectedArchiveClient?: PolkadotArgonClient | ArgonClient,
  ) {
    this.archiveUrl = archiveUrl;
    if (connectedArchiveClient && isRuntimeClient<PolkadotArgonClient, CurrentRuntimeQueries>(connectedArchiveClient)) {
      this.archiveClientPromise = Promise.resolve(connectedArchiveClient);
    } else {
      this.archiveClientPromise = (
        connectedArchiveClient ? Promise.resolve(connectedArchiveClient) : getMainchainClientOrThrow(archiveUrl)
      ).then(client => this.wrapClient(client, 'archive'));
    }
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

  public setPrunedClient(url: string): Promise<ArgonClient> {
    const previousCandidate = this.prunedCandidate;
    if (previousCandidate?.url === url && !previousCandidate.ready.isRejected) {
      return previousCandidate.ready.promise;
    }

    const wasPreferred = !!this.prunedClientPromise;
    this.prunedClientPromise = undefined;
    this.currentClientByType.pruned = undefined;
    this.setConnectionState('pruned', 'disconnected');
    this.stopPrunedStateProbe();
    const ready = createDeferred<ArgonClient>(false);
    void ready.promise.catch(() => undefined);
    const connection = getMainchainClientOrThrow(url).then(async client => {
      if (this.prunedCandidate?.ready !== ready) {
        await client.disconnect();
        throw new Error('Pruned client was replaced before it connected');
      }
      return this.wrapClient(client, 'pruned');
    });
    const candidate = { url, connection, ready };
    this.prunedCandidate = candidate;
    void previousCandidate?.connection.then(previousClient => previousClient.disconnect()).catch(() => undefined);
    previousCandidate?.ready.reject(new Error('Pruned client was replaced'));

    if (wasPreferred) {
      this.events.emit('degraded', undefined, 'pruned');
    }

    void candidate.connection
      .then(client => {
        this.schedulePrunedStateProbe(client);
      })
      .catch(error => {
        if (this.prunedCandidate !== candidate) {
          return;
        }
        this.currentClientByType.pruned = undefined;
        this.setConnectionState('pruned', 'disconnected');
        candidate.ready.reject(error);
      });

    return candidate.ready.promise;
  }

  public clearPrunedClient(): void {
    const previousCandidate = this.prunedCandidate;
    if (!previousCandidate) return;

    const shouldNotifyDegraded = !!this.prunedClientPromise;
    this.prunedCandidate = undefined;
    this.prunedClientPromise = undefined;
    previousCandidate.ready.reject(new Error('Pruned client was cleared'));
    this.currentClientByType.pruned = undefined;
    this.stopPrunedStateProbe();
    this.setConnectionState('pruned', 'disconnected');
    if (shouldNotifyDegraded) {
      this.events.emit('degraded', undefined, 'pruned');
    }
    void previousCandidate.connection.then(previousClient => previousClient.disconnect()).catch(() => undefined);
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
    this.prunedCandidate?.ready.reject(new Error('Mainchain clients disconnected'));
    this.stopPrunedStateProbe();
    await Promise.allSettled([
      this.archiveClientPromise.then(client => client.disconnect()),
      this.prunedCandidate?.connection.then(client => client.disconnect()),
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

  private wrapClient(client: PolkadotArgonClient, clientType: IClientType): ArgonClient {
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
        if (errorTracker.errors.length > 6) {
          errorTracker.errors.shift();
        }
        errorTracker.lastErrorTime = Date.now();
        const isStateDiscarded = String(error).toLowerCase().includes('state already discarded');
        if (clientType === 'pruned' && isStateDiscarded) {
          this.schedulePrunedStateProbe(api);
        } else if (errorTracker.errors.length > 5 && clientType === 'pruned') {
          if (this.demotePrunedClient(api, error)) {
            this.schedulePrunedStateProbe(api, MainchainClients.prunedStateProbeRetryMs);
          }
        } else if (errorTracker.errors.length > 5) {
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
    }) as unknown as ArgonClient;
    this.currentClientByType[clientType] = api;
    this.setConnectionState(clientType, 'connected');
    api.on('disconnected', () => {
      if (this.currentClientByType[clientType] !== api) {
        return;
      }

      this.setConnectionState(clientType, 'disconnected');
      if (clientType === 'pruned') {
        this.stopPrunedStateProbe();
        this.demotePrunedClient(api);
      } else {
        this.events.emit('degraded', undefined, clientType);
      }
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
      if (clientType === 'pruned') {
        this.schedulePrunedStateProbe(api);
      }
      if (!apiError) this.events.emit('working', '', clientType);
    });
    return api;
  }

  private schedulePrunedStateProbe(client: ArgonClient, delayMs = 0): void {
    if (
      this.isShuttingDown ||
      this.currentClientByType.pruned !== client ||
      this.connectionStateByClient.pruned !== 'connected' ||
      this.prunedStateProbePromise ||
      this.prunedStateProbeTimer
    ) {
      return;
    }

    if (delayMs > 0) {
      this.prunedStateProbeTimer = setTimeout(() => {
        this.prunedStateProbeTimer = undefined;
        this.schedulePrunedStateProbe(client);
      }, delayMs);
      return;
    }

    const probePromise = raceWithTimeout(
      (async () => {
        const finalizedHash = await client.rpc.chain.getFinalizedHead();
        const finalizedClient = await client.at(finalizedHash);
        await finalizedClient.query.system.number();
      })(),
      MainchainClients.prunedStateProbeTimeoutMs,
      () => {
        throw new Error('Pruned client state probe timed out');
      },
    );
    this.prunedStateProbePromise = probePromise;
    let shouldRetry = false;

    void probePromise
      .then(() => {
        if (
          this.prunedStateProbePromise !== probePromise ||
          this.currentClientByType.pruned !== client ||
          this.connectionStateByClient.pruned !== 'connected' ||
          this.prunedClientPromise
        ) {
          return;
        }

        const hadConnectedClient = this.hasConnectedClient();
        this.prunedClientPromise = Promise.resolve(client);
        this.prunedCandidate?.ready.resolve(client);
        const hasConnectedClient = this.hasConnectedClient();
        if (hadConnectedClient !== hasConnectedClient) {
          this.events.emit('connection-state-changed', hasConnectedClient);
        }
        this.events.emit('on-pruned-client', client, this.prunedUrl!);
      })
      .catch(error => {
        if (
          this.prunedStateProbePromise !== probePromise ||
          this.isShuttingDown ||
          this.currentClientByType.pruned !== client
        ) {
          return;
        }
        this.demotePrunedClient(client, error as Error);
        shouldRetry = this.connectionStateByClient.pruned === 'connected';
      })
      .finally(() => {
        if (this.prunedStateProbePromise !== probePromise) {
          return;
        }

        this.prunedStateProbePromise = undefined;
        if (shouldRetry) {
          this.schedulePrunedStateProbe(client, MainchainClients.prunedStateProbeRetryMs);
        }
      });
  }

  private stopPrunedStateProbe(): void {
    if (this.prunedStateProbeTimer) {
      clearTimeout(this.prunedStateProbeTimer);
      this.prunedStateProbeTimer = undefined;
    }
    this.prunedStateProbePromise = undefined;
  }

  private demotePrunedClient(client: ArgonClient, error?: Error): boolean {
    const candidate = this.prunedCandidate;
    if (this.currentClientByType.pruned !== client || !this.prunedClientPromise || !candidate) {
      return false;
    }

    const hadConnectedClient = this.hasConnectedClient();
    this.prunedClientPromise = undefined;
    const readiness = createDeferred<ArgonClient>(false);
    void readiness.promise.catch(() => undefined);
    candidate.ready = readiness;
    const hasConnectedClient = this.hasConnectedClient();
    if (hadConnectedClient !== hasConnectedClient) {
      this.events.emit('connection-state-changed', hasConnectedClient);
    }
    this.events.emit('degraded', error, 'pruned');
    return true;
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

async function getMainchainClientOrThrow(host: string): Promise<PolkadotArgonClient> {
  return getClient(host, { throwOnConnect: true });
}
