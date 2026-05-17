import {
  getObjectStringProperty,
  JsonExt,
  NetworkConfig,
  type IEthereumInboundRelayRequest,
  type IEthereumInboundRelayResponse,
} from '@argonprotocol/apps-core';
import type { IRouterErrorResponse } from '@argonprotocol/apps-router';

export class PublicRelayerClient {
  public async relayEthereumProof(payload: IEthereumInboundRelayRequest): Promise<IEthereumInboundRelayResponse> {
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), 30e3);

    try {
      const response = await fetch(`${NetworkConfig.get().defaultRelayerHost}/ethereum-proof-relay`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JsonExt.stringify(payload),
        signal: abortController.signal,
      });
      const rawBody = await response.text();
      let body: IEthereumInboundRelayResponse | IRouterErrorResponse | string | undefined;

      if (rawBody) {
        try {
          body = JsonExt.parse<IEthereumInboundRelayResponse | IRouterErrorResponse>(rawBody);
        } catch (error) {
          if (response.ok) throw error;
          body = rawBody;
        }
      }

      let error = getObjectStringProperty(body, 'error');
      if (!error && !response.ok && typeof body === 'string') {
        error = body;
      }

      if (!response.ok) {
        throw new Error(error ?? `Public relayer request failed (${response.status}).`);
      }
      if (error) {
        throw new Error(error);
      }

      return body as IEthereumInboundRelayResponse;
    } finally {
      clearTimeout(timeout);
    }
  }
}
