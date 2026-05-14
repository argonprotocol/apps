import process from 'node:process';

const defaultExecutionPortStart = 32_000;
const executionPortRangeSize = 32;

export async function resolveDevEthereumRpcUrl(args: { rpcUrl?: string; logPrefix?: string }): Promise<string> {
  const { rpcUrl, logPrefix = 'dev-ethereum' } = args;
  const envRpc = process.env.ETH_RPC?.trim();
  if (rpcUrl?.trim()) return rpcUrl.trim();
  if (envRpc) return envRpc;

  const candidates = await detectExecutionRpcUrls();
  if (!candidates.length) {
    throw new Error(
      'Unable to detect a local Ethereum execution RPC. Pass --rpc http://127.0.0.1:<port> or set ETH_RPC.',
    );
  }

  if (candidates.length > 1) {
    const selected = candidates.at(-1)!;
    console.warn(
      `[${logPrefix}] Multiple execution RPC endpoints detected (${candidates.join(', ')}). Using newest ${selected}. Override with --rpc if needed.`,
    );
    return selected;
  }

  return candidates[0];
}

async function detectExecutionRpcUrls(): Promise<string[]> {
  const candidates: string[] = [];

  for (let port = defaultExecutionPortStart; port < defaultExecutionPortStart + executionPortRangeSize; port += 1) {
    const rpcUrl = `http://127.0.0.1:${port}`;
    try {
      const chainId = await rpcCall<string>(rpcUrl, 'eth_chainId', []);
      if (typeof chainId === 'string') {
        candidates.push(rpcUrl);
      }
    } catch {
      continue;
    }
  }

  return candidates;
}

async function rpcCall<TResult>(rpcUrl: string, method: string, params: unknown[]): Promise<TResult> {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params,
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(`RPC request failed for ${method}: ${response.status} ${response.statusText}`);
  }

  const body = (await response.json()) as {
    result?: TResult;
    error?: {
      code?: number;
      message?: string;
    };
  };

  if (body.error) {
    throw new Error(body.error.message ?? `${method} failed`);
  }

  return body.result as TResult;
}
