import type { ApiDecoration, ArgonClient } from '@argonprotocol/mainchain';

export function isSimplifiedBondsModel(client: ArgonClient | ApiDecoration<'promise'>): boolean {
  return typeof (client.query.treasury as any).pendingUnlocksByFrame === 'function';
}
