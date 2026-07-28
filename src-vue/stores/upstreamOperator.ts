import { UpstreamOperatorClient } from '../lib/UpstreamOperatorClient.ts';
import { getConfig } from './config.ts';
import { getUpstreamOperatorAuthClient } from './server.ts';

let upstreamOperatorClient: UpstreamOperatorClient | undefined;

export function getUpstreamOperatorClient(): UpstreamOperatorClient {
  upstreamOperatorClient ??= new UpstreamOperatorClient(getUpstreamOperatorAuthClient(), () => {
    const config = getConfig();
    if (!config.upstreamOperator) return;

    return UpstreamOperatorClient.getBootstrapHost(config.bootstrapDetails);
  });
  return upstreamOperatorClient;
}
