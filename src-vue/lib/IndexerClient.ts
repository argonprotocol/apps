import { AccountActivityKind, fetch, type IIndexerSpec, NetworkConfig } from '@argonprotocol/apps-core';
import { LOG_DEBUG } from './Env.ts';

const financialHistoryMask =
  AccountActivityKind.VaultPosition |
  AccountActivityKind.VaultRevenue |
  AccountActivityKind.BondPosition |
  AccountActivityKind.BitcoinLock |
  AccountActivityKind.BitcoinMint;
type IActivityRequest = {
  api: string;
  address: string;
  afterBlock: number;
  toBlock: number;
  activityMask: number;
  expiresAt?: number;
  response: Promise<IIndexerSpec['/v2/activity/:address']['responseType']>;
};
const activityRequests = new Map<string, IActivityRequest>();

export async function findAddressActivity(
  address: string,
  filters: IIndexerSpec['/v2/activity/:address']['requestQuery'] = {},
): Promise<IIndexerSpec['/v2/activity/:address']['responseType']> {
  const api = NetworkConfig.get().indexerHost;
  const requestedMask = filters.activityMask ?? 0x7fffffff;
  const canShareHistoryRequest = filters.toBlock !== undefined;
  const queryMask = requestedMask | (requestedMask & AccountActivityKind.AccountBalance ? financialHistoryMask : 0);
  const queryFilters = {
    ...filters,
    activityMask: queryMask,
  };
  const cacheKey = canShareHistoryRequest
    ? `${api}:${address}:${filters.afterBlock ?? 0}:${filters.toBlock}:${queryMask}`
    : undefined;
  const now = Date.now();

  for (const [key, request] of activityRequests) {
    if (request.expiresAt !== undefined && request.expiresAt <= now) activityRequests.delete(key);
  }

  let request = cacheKey ? activityRequests.get(cacheKey) : undefined;
  if (!request && canShareHistoryRequest) {
    request = [...activityRequests.values()].find(candidate => {
      return (
        candidate.api === api &&
        candidate.address === address &&
        candidate.afterBlock === (filters.afterBlock ?? 0) &&
        candidate.toBlock === filters.toBlock &&
        (candidate.activityMask & queryMask) === queryMask
      );
    });
  }
  if (!request) {
    const createdRequest: IActivityRequest = {
      api,
      address,
      afterBlock: filters.afterBlock ?? 0,
      toBlock: filters.toBlock ?? Number.MAX_SAFE_INTEGER,
      activityMask: queryMask,
      response: fetchAddressActivity(api, address, queryFilters),
    };
    request = createdRequest;
    if (cacheKey) {
      activityRequests.set(cacheKey, createdRequest);
      void createdRequest.response.then(
        () => {
          createdRequest.expiresAt = Date.now() + 5_000;
        },
        () => {
          if (activityRequests.get(cacheKey) === createdRequest) activityRequests.delete(cacheKey);
        },
      );
    }
  }

  const activity = await request.response;

  return {
    ...activity,
    blocks: activity.blocks.filter(block => (block.activityMask & requestedMask) !== 0),
  };
}

async function fetchAddressActivity(
  api: string,
  address: string,
  filters: IIndexerSpec['/v2/activity/:address']['requestQuery'],
): Promise<IIndexerSpec['/v2/activity/:address']['responseType']> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined) query.set(key, String(value));
  }

  const queryString = query.toString();
  const url = `${api}/v2/activity/${address}${queryString ? `?${queryString}` : ''}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) {
    throw new Error(`Failed to fetch activity for address ${address}: ${response.status} ${response.statusText}`);
  }

  const responseJson = (await response.json()) as IIndexerSpec['/v2/activity/:address']['responseType'];
  const logValue = !import.meta.env.PROD || LOG_DEBUG ? responseJson : { blockCount: responseJson.blocks.length };
  console.info(`['${url}'] response`, logValue);
  return responseJson;
}
