import type { IEthereumGatewayRelayReasonCode } from '@argonprotocol/apps-core';
import { RequestStatusError } from './ServerAuthClient.ts';
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
  upstreamOperatorClient?: Pick<UpstreamOperatorClient, 'resolveOperatorHost' | 'requestEthereumGatewayCatchUp'>;
  preferLocalRelay?: boolean;
  signal?: AbortSignal;
}): Promise<IEthereumGatewayCatchupResult> {
  const {
    throughGatewayActivityNonce,
    serverApiClient,
    upstreamOperatorClient,
    preferLocalRelay = false,
    signal,
  } = args;
  const requestArgs: Parameters<ServerApiClient['requestEthereumGatewayCatchUp']> = [
    { sourceChain: 'Ethereum', throughGatewayActivityNonce },
  ];
  if (signal) requestArgs.push(signal);

  let canTryUpstream = true;
  let relaySource: IEthereumGatewayRelaySource | undefined;
  let relayError = '';
  let relayReasonCode: IEthereumGatewayRelayReasonCode | undefined;
  let localRelayAttemptOutcome: 'notReady' | 'requestFailed' | 'rejected' | undefined;
  let localRelayError = '';
  let localRelayReasonCode: IEthereumGatewayRelayReasonCode | undefined;

  if (serverApiClient) {
    try {
      signal?.throwIfAborted();
      const relayStatus = await serverApiClient.getEthereumRelayStatus(signal);
      if (relayStatus.isReady && !signal?.aborted) {
        // A lost response can still leave a proof running on the local bot.
        canTryUpstream = !preferLocalRelay;
        const response = await serverApiClient.requestEthereumGatewayCatchUp(...requestArgs);
        if (response.outcome === 'Rejected') {
          canTryUpstream = true;
          localRelayAttemptOutcome = 'rejected';
          localRelayError = response.reason;
          localRelayReasonCode = response.reasonCode;
        } else if (
          response.outcome === 'Noop' &&
          response.throughGatewayActivityNonce !== undefined &&
          response.throughGatewayActivityNonce < throughGatewayActivityNonce
        ) {
          canTryUpstream = true;
          localRelayAttemptOutcome = 'requestFailed';
          localRelayError = 'The local relay has not reached the requested gateway activity.';
        } else {
          relaySource = 'localServer';

          if (upstreamOperatorClient && !preferLocalRelay && !signal?.aborted) {
            try {
              if ((await upstreamOperatorClient.resolveOperatorHost()) && !signal?.aborted) {
                await upstreamOperatorClient.requestEthereumGatewayCatchUp(...requestArgs);
              }
            } catch {
              // The local relay request already succeeded; the upstream nudge is best-effort.
            }
          }
        }
      } else {
        localRelayAttemptOutcome = 'notReady';
        localRelayError = relayStatus.reason ?? '';
        localRelayReasonCode = relayStatus.reasonCode;
      }
    } catch (error) {
      if (error instanceof RequestStatusError) canTryUpstream = true;
      localRelayAttemptOutcome = 'requestFailed';
      localRelayError = error instanceof Error ? error.message : String(error);
    }
  }

  if (!relaySource && canTryUpstream && upstreamOperatorClient && !signal?.aborted) {
    try {
      if ((await upstreamOperatorClient.resolveOperatorHost()) && !signal?.aborted) {
        const response = await upstreamOperatorClient.requestEthereumGatewayCatchUp(...requestArgs);
        if (response.outcome === 'Rejected') {
          relayError = response.reason;
          relayReasonCode = response.reasonCode;
        } else {
          relaySource = 'upstreamOperator';
        }
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
