import { NetworkConfig, NetworkConfigSettings, type INetworkConfigOverride } from '@argonprotocol/apps-core';
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

  const runtimeOverride = readRuntimeOverride(networkName);
  if (runtimeOverride) {
    NetworkConfig.setRuntimeOverride(networkName, runtimeOverride);
  }
}

function readRuntimeOverride(networkName: keyof typeof NetworkConfigSettings): INetworkConfigOverride | undefined {
  const rawOverride = process.env.ARGON_NETWORK_CONFIG_OVERRIDE?.trim();
  const envExecutionRpcUrl = process.env.ETHEREUM_EXECUTION_RPC_URL?.trim();
  const parsedOverride = rawOverride ? (JSON.parse(rawOverride) as INetworkConfigOverride) : undefined;

  if (!parsedOverride && !envExecutionRpcUrl) {
    return;
  }

  const baseOverride = parsedOverride ?? {};
  return {
    ...baseOverride,
    ...(envExecutionRpcUrl
      ? {
          ethereumNetwork: {
            ...baseOverride.ethereumNetwork,
            executionRpcUrl: envExecutionRpcUrl,
          },
        }
      : {}),
    archiveUrl: baseOverride.archiveUrl ?? NetworkConfigSettings[networkName].archiveUrl,
  };
}
