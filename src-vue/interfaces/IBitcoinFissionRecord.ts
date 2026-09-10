import type { IBitcoinFission } from '@argonprotocol/apps-core';

export type { IBitcoinFissionRatchet as IBitcoinFissionRatchetRecord } from '@argonprotocol/apps-core';

export type IBitcoinFissionRecord = IBitcoinFission &
  Required<Pick<IBitcoinFission, 'origin' | 'ratchets' | 'createdAt' | 'updatedAt'>>;
