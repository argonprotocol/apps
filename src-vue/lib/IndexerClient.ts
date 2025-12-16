import { IIndexerSpec, NetworkConfig } from '@argonprotocol/apps-core';
import { fetch } from '@tauri-apps/plugin-http';

export async function findAddressTransferBlocks(
  address: string,
): Promise<IIndexerSpec['/transfer/:address']['responseType']> {
  const api = NetworkConfig.get().indexerHost;
  const response = await fetch(`${api}/transfers/${address}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch transfers for address ${address}: ${response.status} ${response.statusText}`);
  }

  const responseJson = await response.json();
  console.info(`['${api}/transfers/${address}'] response: `, responseJson);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return responseJson;
}

export async function findAddressVaultCollects(
  address: string,
): Promise<IIndexerSpec['/vault-collects/:address']['responseType']> {
  const api = NetworkConfig.get().indexerHost;
  const response = await fetch(`${api}/vault-collects/${address}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch vault collects for address ${address}: ${response.status} ${response.statusText}`);
  }

  const responseJson = await response.json();
  console.info(`['${api}/vault-collects/${address}'] response: `, responseJson);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return responseJson;
}
