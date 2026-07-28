import { ETHEREUM_EXECUTION_RPC_TRANSPORT, logEthereumExecutionRpcFallback } from '@argonprotocol/apps-core';
import { createPublicClient, fallback, http, shouldThrow } from 'viem';

export function createEthereumExecutionClient(executionRpcUrls: string[]) {
  const transports = executionRpcUrls.map(url =>
    http(url, {
      retryCount: ETHEREUM_EXECUTION_RPC_TRANSPORT.requestRetryCount,
      timeout: ETHEREUM_EXECUTION_RPC_TRANSPORT.timeoutMs,
    }),
  );
  if (!transports.length) {
    throw new Error('Ethereum execution RPC is not configured on this network.');
  }

  const fallbackTransport = fallback(transports, {
    retryCount: ETHEREUM_EXECUTION_RPC_TRANSPORT.fallbackRetryCount,
  });
  const client = createPublicClient({ transport: fallbackTransport });
  client.transport.onResponse(({ error, method, status, transport }) => {
    if (status !== 'error' || shouldThrow(error)) {
      return;
    }

    logEthereumExecutionRpcFallback({
      executionRpcUrls,
      failedRpcUrl: transport.value?.url,
      method,
    });
  });

  return client;
}
