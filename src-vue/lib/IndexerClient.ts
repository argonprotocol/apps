import { IIndexerSpec, NetworkConfig } from '@argonprotocol/apps-core';
import { fetch } from '@tauri-apps/plugin-http';
import { LOG_DEBUG } from './Env.ts';

export async function findAddressTransferBlocks(
  address: string,
): Promise<IIndexerSpec['/transfer/:address']['responseType']> {
  const api = NetworkConfig.get().indexerHost;
  const response = await Promise.race([
    fetch(`${api}/transfers/${address}`),
    new Promise<Response>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout fetching transfers for address ${address}`)), 10e3),
    ),
  ]);
  if (!response.ok) {
    throw new Error(`Failed to fetch transfers for address ${address}: ${response.status} ${response.statusText}`);
  }

  const responseJson = await response.json();
  console.info(`['${api}/transfers/${address}'] response`, formatIndexerResponseForLog(responseJson));
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return responseJson;
}

export async function findAddressVaultCollects(
  address: string,
): Promise<IIndexerSpec['/vault-collects/:address']['responseType']> {
  const api = NetworkConfig.get().indexerHost;
  const response = await Promise.race([
    fetch(`${api}/vault-collects/${address}`),
    new Promise<Response>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout fetching vault collects for address ${address}`)), 10e3),
    ),
  ]);
  if (!response.ok) {
    throw new Error(`Failed to fetch vault collects for address ${address}: ${response.status} ${response.statusText}`);
  }

  const responseJson = await response.json();
  console.info(`['${api}/vault-collects/${address}'] response`, formatIndexerResponseForLog(responseJson));
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return responseJson;
}

function formatIndexerResponseForLog(responseJson: unknown): unknown {
  if (!import.meta.env.PROD || LOG_DEBUG) {
    return responseJson;
  }

  return summarizeIndexerResponse(responseJson);
}

function summarizeIndexerResponse(responseJson: unknown): string | Record<string, unknown> {
  if (Array.isArray(responseJson)) {
    return { count: responseJson.length };
  }

  if (responseJson && typeof responseJson === 'object') {
    return { keys: Object.keys(responseJson).slice(0, 10) };
  }

  return String(responseJson);
}
