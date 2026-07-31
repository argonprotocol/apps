import { UpstreamOperatorClient } from '../lib/UpstreamOperatorClient.ts';
import { enrollUpstreamRecovery, recoverUpstreamHost } from './bootstrapRecovery.ts';
import { getConfig } from './config.ts';
import { getUpstreamOperatorAuthClient } from './server.ts';
import { BootstrapType } from '../interfaces/IConfig.ts';

let upstreamOperatorClient: UpstreamOperatorClient | undefined;

export function getUpstreamOperatorClient(): UpstreamOperatorClient {
  if (!upstreamOperatorClient) {
    const config = getConfig();
    upstreamOperatorClient = new UpstreamOperatorClient(
      getUpstreamOperatorAuthClient(),
      () => {
        // Legacy public RPC details do not imply upstream membership. Private details can exist
        // briefly before member metadata is restored from the recovered operator.
        if (!config.upstreamOperator && config.bootstrapDetails?.type !== BootstrapType.Private) return;

        return UpstreamOperatorClient.getBootstrapHost(config.bootstrapDetails);
      },
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
