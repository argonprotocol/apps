import { NetworkConfig, NetworkConfigSettings } from '@argonprotocol/apps-core';
import { getClient } from '@argonprotocol/mainchain';

export async function configureNetwork(archiveUrl?: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
  let networkName: keyof typeof NetworkConfigSettings & string = (process.env.ARGON_CHAIN as any) ?? 'mainnet';
  if ((networkName as any) === 'local') {
    networkName = 'localnet';
  }
  if (!(networkName in NetworkConfigSettings)) {
    throw new Error(`${networkName} is not a valid Network chain name`);
  }

  if (archiveUrl) {
    NetworkConfigSettings[networkName].archiveUrl = archiveUrl;
  }
  NetworkConfig.setNetwork(networkName);

  if (networkName === 'localnet' || networkName === 'dev-docker') {
    const client = await getClient(archiveUrl ?? NetworkConfigSettings[networkName].archiveUrl);
    await NetworkConfig.updateConfig(client);
    await client.disconnect();
  }
}
