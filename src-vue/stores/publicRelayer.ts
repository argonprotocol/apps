import { PublicRelayerClient } from '../lib/PublicRelayerClient.ts';

let publicRelayerClient: PublicRelayerClient | undefined;

export function getPublicRelayerClient(): PublicRelayerClient {
  publicRelayerClient ??= new PublicRelayerClient();
  return publicRelayerClient;
}
