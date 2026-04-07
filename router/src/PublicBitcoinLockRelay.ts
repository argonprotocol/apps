import type { IBitcoinLockRelay, IBitcoinLockRelayRecord } from './interfaces/index.ts';

export function toPublicBitcoinLockRelay(relay: IBitcoinLockRelayRecord): IBitcoinLockRelay {
  return {
    id: relay.id,
    status: relay.status,
    queueReason: relay.queueReason,
    error: relay.error,
    delegateAddress: relay.delegateAddress,
    extrinsicHash: relay.extrinsicHash,
    extrinsicMethodJson: relay.extrinsicMethodJson,
    nonce: relay.nonce,
    submittedAtBlockHeight: relay.submittedAtBlockHeight,
    submittedAtTime: relay.submittedAtTime,
    finalizedHeight: relay.finalizedHeight,
    txFeePlusTip: relay.txFeePlusTip,
    utxoId: relay.utxoId,
    createdLock: relay.createdLock,
  };
}
