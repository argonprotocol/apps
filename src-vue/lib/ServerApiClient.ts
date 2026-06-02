import {
  getObjectStringProperty,
  JsonExt,
  type IEthereumGatewayCatchUpRequest,
  type IEthereumGatewayCatchUpResponse,
  type IEthereumGatewayRelayStatus,
} from '@argonprotocol/apps-core';
import type {
  ICreateOperationalInviteResponse,
  ICreateTreasuryInviteResponse,
  IListOperationalInvitesResponse,
  IOperationalUserInvite,
  IOperationalUserInviteCreateRequest,
  IOperationalUserInviteRegenerateRequest,
  IListTreasuryInvitesResponse,
  IRouterErrorResponse,
  ITreasuryUserInvite,
  ITreasuryUserInviteCreateRequest,
} from '@argonprotocol/apps-router';
import { type IConfigServerDetails, ServerType } from '../interfaces/IConfig.ts';
import {
  RequestStatusError,
  isUnauthenticatedServerAuthError,
  type ServerAuthClient,
  type ServerAuthOptions,
} from './ServerAuthClient.ts';
import type { UpstreamOperatorClient } from './UpstreamOperatorClient.ts';

export type ServerGatewayDetails = Pick<IConfigServerDetails, 'ipAddress' | 'gatewayPort' | 'type'>;

export interface IBitcoinBlockChainInfo {
  chain: string;
  blocks: number;
  headers: number;
  bestBlockHash: string;
  difficulty: number;
  time: number;
  medianTime: number;
  verificationProgress: number;
  initialBlockDownload: boolean;
  chainwork: string;
  sizeOnDisk: number;
  pruned: boolean;
  warnings: string[];
  localNodeBlockNumber: number;
  mainNodeBlockNumber: number;
}

export interface IArgonBlockChainInfo {
  localNodeBlockNumber: number;
  mainNodeBlockNumber: number;
  isComplete: boolean;
}

interface ISyncStatus {
  mainNodeBlockNumber: number;
  localNodeBlockNumber: number;
  syncPercent: number;
}

interface ILatestBlocks {
  mainNodeBlockNumber: number;
  localNodeBlockNumber: number;
}

interface IBitcoinLatestBlocks extends ILatestBlocks {
  localNodeBlockTime: number;
}

type RequestOptions = {
  init?: RequestInit;
  timeoutMs?: number;
  sessionId?: string;
};

type ClientRequestOptions = Omit<RequestOptions, 'sessionId'> & {
  adminOperatorAuth?: boolean;
};

type AdminOperatorServerAuthClient = Pick<
  ServerAuthClient,
  'getAdminOperatorSessionId' | 'invalidateAdminOperatorSessionId'
>;

export class ServerApiClient {
  constructor(
    private readonly getServerDetails: () => ServerGatewayDetails,
    private readonly serverAuthClient: AdminOperatorServerAuthClient,
  ) {}

  public getGatewayHttpUrl(path = '', sessionId?: string): string {
    return ServerApiClient.getGatewayHttpUrl(this.getServerDetails(), path, sessionId);
  }

  public getGatewayWebsocketUrl(path: string, sessionId?: string): string {
    return ServerApiClient.getGatewayWebsocketUrl(this.getServerDetails(), path, sessionId);
  }

  public async getAdminOperatorSessionId(options: ServerAuthOptions = {}): Promise<string> {
    return await this.serverAuthClient.getAdminOperatorSessionId(this.getGatewayHttpUrl(), options);
  }

  public async isGatewayReady(): Promise<boolean> {
    return await this.request<{ status?: string }>('/', { timeoutMs: 5e3 })
      .then(body => body.status === 'ok')
      .catch(() => false);
  }

  public async getTreasuryAppInvites(): Promise<ITreasuryUserInvite[]> {
    const body = await this.request<IListTreasuryInvitesResponse>('/treasury-users/invites', {
      timeoutMs: 10e3,
      adminOperatorAuth: true,
    });
    return body.invites;
  }

  public async getOperationalInvites(): Promise<IOperationalUserInvite[]> {
    const body = await this.request<IListOperationalInvitesResponse>('/operational-users/invites', {
      timeoutMs: 10e3,
      adminOperatorAuth: true,
    });
    return body.invites;
  }

  public async createTreasuryAppInvite(payload: ITreasuryUserInviteCreateRequest): Promise<ITreasuryUserInvite> {
    const body = await this.postJson<ICreateTreasuryInviteResponse>('/treasury-users/create', payload, {
      timeoutMs: 10e3,
      adminOperatorAuth: true,
    });
    return body.invite;
  }

  public async createOperationalInvite(payload: IOperationalUserInviteCreateRequest): Promise<IOperationalUserInvite> {
    const body = await this.postJson<ICreateOperationalInviteResponse>('/operational-users/create', payload, {
      timeoutMs: 10e3,
      adminOperatorAuth: true,
    });
    return body.invite;
  }

  public async requestEthereumGatewayCatchUp(
    payload: IEthereumGatewayCatchUpRequest,
  ): Promise<IEthereumGatewayCatchUpResponse> {
    return await this.postJson<IEthereumGatewayCatchUpResponse>('/ethereum-relay-request', payload, {
      timeoutMs: 30e3,
      adminOperatorAuth: true,
    });
  }

  public async getEthereumRelayStatus(): Promise<IEthereumGatewayRelayStatus> {
    return await this.request<IEthereumGatewayRelayStatus>('/ethereum-relay-status', {
      timeoutMs: 10e3,
      adminOperatorAuth: true,
    });
  }

  public async regenerateOperationalInvite(
    inviteCode: string,
    payload: IOperationalUserInviteRegenerateRequest,
  ): Promise<IOperationalUserInvite> {
    const body = await this.postJson<ICreateOperationalInviteResponse>(
      `/operational-users/${encodeURIComponent(inviteCode)}/regenerate`,
      payload,
      {
        timeoutMs: 10e3,
        adminOperatorAuth: true,
      },
    );
    return body.invite;
  }

  private async request<T>(path: string, options: ClientRequestOptions = {}): Promise<T> {
    const { adminOperatorAuth, ...requestOptions } = options;
    if (!adminOperatorAuth) {
      return await ServerApiClient.request<T>(this.getServerDetails(), path, requestOptions);
    }

    let sessionId = await this.getAdminOperatorSessionId();

    try {
      return await ServerApiClient.request<T>(this.getServerDetails(), path, {
        ...requestOptions,
        sessionId,
      });
    } catch (error) {
      if (!isUnauthenticatedServerAuthError(error)) {
        throw error;
      }

      this.serverAuthClient.invalidateAdminOperatorSessionId(this.getGatewayHttpUrl());
      sessionId = await this.getAdminOperatorSessionId();

      return await ServerApiClient.request<T>(this.getServerDetails(), path, {
        ...requestOptions,
        sessionId,
      });
    }
  }

  private postJson<T>(path: string, payload: unknown, options: ClientRequestOptions = {}): Promise<T> {
    return this.request<T>(path, {
      ...options,
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JsonExt.stringify(payload),
      },
    });
  }

  public static getGatewayHttpUrl(serverDetails: ServerGatewayDetails, path = '', sessionId?: string): string {
    if (!serverDetails.ipAddress) {
      throw new Error('No server IP address configured');
    }

    const host = getGatewayHost(serverDetails);
    const port = serverDetails.gatewayPort && serverDetails.gatewayPort !== 443 ? `:${serverDetails.gatewayPort}` : '';
    const normalizedPath = path ? (path.startsWith('/') ? path : `/${path}`) : '';
    const url = `https://${host}${port}${normalizedPath}`;
    if (!sessionId) {
      return url;
    }

    const authenticatedUrl = new URL(url);
    authenticatedUrl.searchParams.set('sessionId', sessionId);
    return authenticatedUrl.toString();
  }

  public static getGatewayWebsocketUrl(serverDetails: ServerGatewayDetails, path: string, sessionId?: string): string {
    return this.getGatewayHttpUrl(serverDetails, path, sessionId).replace(/^http/i, 'ws');
  }

  public static async isGatewayReady(serverDetails: ServerGatewayDetails): Promise<boolean> {
    return await this.request<{ status?: string }>(serverDetails, '/', { timeoutMs: 5e3 })
      .then(body => body.status === 'ok')
      .catch(() => false);
  }

  public static async getBitcoinInstallProgress(serverDetails: ServerGatewayDetails): Promise<number> {
    const result = await this.request<ISyncStatus>(serverDetails, '/bitcoin/syncstatus', { timeoutMs: 30e3 }).catch(
      () => null,
    );
    return result?.syncPercent ?? 0;
  }

  public static async getBitcoinBlockChainInfo(serverDetails: ServerGatewayDetails): Promise<IBitcoinBlockChainInfo> {
    const blocks = await this.request<IBitcoinLatestBlocks>(serverDetails, '/bitcoin/latestblocks', {
      timeoutMs: 30e3,
    });
    const info = await this.request<{
      chain: string;
      blocks: number;
      headers: number;
      bestblockhash: string;
      difficulty: number;
      time: number;
      mediantime: number;
      verificationprogress: number;
      initialblockdownload: boolean;
      chainwork: string;
      size_on_disk: number;
      pruned: boolean;
      warnings: string[];
    }>(serverDetails, '/bitcoin/getblockchaininfo', { timeoutMs: 30e3 });

    return {
      chain: info.chain,
      blocks: info.blocks,
      headers: info.headers,
      bestBlockHash: info.bestblockhash,
      difficulty: info.difficulty,
      time: info.time,
      medianTime: info.mediantime,
      verificationProgress: info.verificationprogress,
      initialBlockDownload: info.initialblockdownload,
      chainwork: info.chainwork,
      sizeOnDisk: info.size_on_disk,
      pruned: info.pruned,
      warnings: info.warnings,
      localNodeBlockNumber: blocks.localNodeBlockNumber,
      mainNodeBlockNumber: blocks.mainNodeBlockNumber,
    };
  }

  public static async getArgonBlockChainInfo(serverDetails: ServerGatewayDetails): Promise<IArgonBlockChainInfo> {
    const { localNodeBlockNumber, mainNodeBlockNumber } = await this.request<ILatestBlocks>(
      serverDetails,
      '/argon/latestblocks',
      { timeoutMs: 10e3 },
    );
    const completeResponse = await this.request<boolean | object>(serverDetails, '/argon/iscomplete', {
      timeoutMs: 10e3,
    });

    return {
      localNodeBlockNumber,
      mainNodeBlockNumber,
      isComplete: completeResponse === true,
    };
  }

  public static async getArgonInstallProgress(serverDetails: ServerGatewayDetails): Promise<number> {
    const result = await this.request<ISyncStatus>(serverDetails, '/argon/syncstatus', { timeoutMs: 30e3 });
    return result?.syncPercent ?? 0;
  }

  private static async request<T>(
    serverDetails: ServerGatewayDetails,
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const abortController = new AbortController();
    const timeoutMs = options.timeoutMs ?? 10e3;
    const timeout = setTimeout(() => abortController.abort(), timeoutMs);

    try {
      const response = await fetch(this.getGatewayHttpUrl(serverDetails, path, options.sessionId), {
        ...options.init,
        headers: {
          ...(options.init?.headers as Record<string, string> | undefined),
        },
        signal: options.init?.signal ?? abortController.signal,
      });
      const rawBody = await response.text();
      let body: T | IRouterErrorResponse | string | undefined;
      if (rawBody) {
        try {
          body = JsonExt.parse<T | IRouterErrorResponse>(rawBody);
        } catch (error) {
          if (response.ok) throw error;
          body = rawBody;
        }
      }

      let error = getObjectStringProperty(body, 'error');
      if (!error && !response.ok && typeof body === 'string') {
        error = body;
      }

      if (!response.ok) {
        throw new RequestStatusError(error ?? `Server API request failed (${response.status}).`, response.status);
      }
      if (error) {
        throw new Error(error);
      }

      return body as T;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function getGatewayHost(serverDetails: ServerGatewayDetails): string {
  if (serverDetails.type === ServerType.LocalComputer && isLoopbackIp(serverDetails.ipAddress)) {
    return 'localhost';
  }

  return serverDetails.ipAddress;
}

function isLoopbackIp(ipAddress: string): boolean {
  return ipAddress === '127.0.0.1' || ipAddress === '::1';
}

export async function requestEthereumGatewayCatchUpThroughOperator(args: {
  throughGatewayActivityNonce: bigint;
  serverApiClient?: Pick<ServerApiClient, 'getEthereumRelayStatus' | 'requestEthereumGatewayCatchUp'>;
  upstreamOperatorClient?: Pick<UpstreamOperatorClient, 'operatorHost' | 'requestEthereumGatewayCatchUp'>;
}): Promise<string | undefined> {
  const { throughGatewayActivityNonce, serverApiClient, upstreamOperatorClient } = args;
  let localRelayError = '';

  if (serverApiClient) {
    try {
      const relayStatus = await serverApiClient.getEthereumRelayStatus();
      if (relayStatus.isReady) {
        const response = await serverApiClient.requestEthereumGatewayCatchUp({
          sourceChain: 'Ethereum',
          throughGatewayActivityNonce,
        });
        if (response.outcome !== 'Rejected') {
          return;
        }

        localRelayError = response.reason;
      } else {
        localRelayError = relayStatus.reason ?? '';
      }
    } catch (error) {
      localRelayError = error instanceof Error ? error.message : String(error);
    }

    if (!upstreamOperatorClient?.operatorHost) {
      return localRelayError;
    }
  }

  if (!upstreamOperatorClient?.operatorHost) {
    return;
  }

  try {
    const response = await upstreamOperatorClient.requestEthereumGatewayCatchUp({
      sourceChain: 'Ethereum',
      throughGatewayActivityNonce,
    });
    return response.outcome === 'Rejected' ? response.reason : undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
