import type { IEthereumGatewayRelayReasonCode } from '@argonprotocol/apps-core';
import type { ServerApiClient } from './ServerApiClient.ts';
import type { UpstreamOperatorClient } from './UpstreamOperatorClient.ts';

export type IEthereumGatewayRelaySource = 'localServer' | 'upstreamOperator';

export type IEthereumGatewayCatchupResult = {
  relaySource?: IEthereumGatewayRelaySource;
  relayError: string;
  relayReasonCode?: IEthereumGatewayRelayReasonCode;
  localRelayAttemptOutcome?: 'notReady' | 'requestFailed' | 'rejected';
  localRelayError: string;
  localRelayReasonCode?: IEthereumGatewayRelayReasonCode;
};

export async function requestEthereumGatewayCatchup(args: {
  throughGatewayActivityNonce: bigint;
  serverApiClient?: Pick<ServerApiClient, 'getEthereumRelayStatus' | 'requestEthereumGatewayCatchUp'>;
  upstreamOperatorClient?: Pick<UpstreamOperatorClient, 'operatorHost' | 'requestEthereumGatewayCatchUp'>;
}): Promise<IEthereumGatewayCatchupResult> {
  const { throughGatewayActivityNonce, serverApiClient, upstreamOperatorClient } = args;
  let relaySource: IEthereumGatewayRelaySource | undefined;
  let relayError = '';
  let relayReasonCode: IEthereumGatewayRelayReasonCode | undefined;
  let localRelayAttemptOutcome: 'notReady' | 'requestFailed' | 'rejected' | undefined;
  let localRelayError = '';
  let localRelayReasonCode: IEthereumGatewayRelayReasonCode | undefined;

  if (serverApiClient) {
    try {
      const relayStatus = await serverApiClient.getEthereumRelayStatus();
      if (relayStatus.isReady) {
        const response = await serverApiClient.requestEthereumGatewayCatchUp({
          sourceChain: 'Ethereum',
          throughGatewayActivityNonce,
        });
        if (response.outcome !== 'Rejected') {
          relaySource = 'localServer';

          if (upstreamOperatorClient?.operatorHost) {
            try {
              await upstreamOperatorClient.requestEthereumGatewayCatchUp({
                sourceChain: 'Ethereum',
                throughGatewayActivityNonce,
              });
            } catch {
              // The local relay request already succeeded; the upstream nudge is best-effort.
            }
          }
        } else {
          localRelayAttemptOutcome = 'rejected';
          localRelayError = response.reason;
          localRelayReasonCode = response.reasonCode;
        }
      } else {
        localRelayAttemptOutcome = 'notReady';
        localRelayError = relayStatus.reason ?? '';
        localRelayReasonCode = relayStatus.reasonCode;
      }
    } catch (error) {
      localRelayAttemptOutcome = 'requestFailed';
      localRelayError = error instanceof Error ? error.message : String(error);
    }
  }

  if (!relaySource && upstreamOperatorClient?.operatorHost) {
    try {
      const response = await upstreamOperatorClient.requestEthereumGatewayCatchUp({
        sourceChain: 'Ethereum',
        throughGatewayActivityNonce,
      });
      if (response.outcome === 'Rejected') {
        relayError = response.reason;
        relayReasonCode = response.reasonCode;
      } else {
        relaySource = 'upstreamOperator';
      }
    } catch (error) {
      relayError = error instanceof Error ? error.message : String(error);
    }
  }

  if (!relaySource && !relayError) {
    relayError = localRelayError;
    relayReasonCode = localRelayReasonCode;
  }

  return {
    relaySource,
    relayError,
    relayReasonCode,
    localRelayAttemptOutcome,
    localRelayError,
    localRelayReasonCode,
  };
}
