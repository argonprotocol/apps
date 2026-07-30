import { UpstreamOperatorClient } from '../lib/UpstreamOperatorClient.ts';
import { enrollUpstreamRecovery, recoverUpstreamHost } from './bootstrapRecovery.ts';
import { getConfig } from './config.ts';
import { getUpstreamOperatorAuthClient } from './server.ts';

let upstreamOperatorClient: UpstreamOperatorClient | undefined;

export function getUpstreamOperatorClient(): UpstreamOperatorClient {
  if (!upstreamOperatorClient) {
    const config = getConfig();
    upstreamOperatorClient = new UpstreamOperatorClient(
      getUpstreamOperatorAuthClient(),
      () => UpstreamOperatorClient.getBootstrapHost(config.bootstrapDetails),
      recoverUpstreamHost,
    );
    void config.isLoadedPromise.then(() => {
      if (!config.upstreamOperator?.encryptedBootstrapRecovery) return;

      return enrollUpstreamRecovery().catch(error => {
        console.warn('Unable to enroll upstream endpoint recovery', error);
      });
    });
  }

  return upstreamOperatorClient;
}
