import { UpstreamOperatorClient } from '../lib/UpstreamOperatorClient.ts';
import { getConfig } from './config.ts';
import { getServerAuthClient } from './server.ts';

let upstreamOperatorClient: UpstreamOperatorClient | undefined;

export function getUpstreamOperatorClient(): UpstreamOperatorClient {
  upstreamOperatorClient ??= new UpstreamOperatorClient(getServerAuthClient(), () => {
    return UpstreamOperatorClient.getBootstrapHost(getConfig().bootstrapDetails);
  });
  return upstreamOperatorClient;
}
