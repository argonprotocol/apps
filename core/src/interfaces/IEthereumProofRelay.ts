import type { ArgonClient } from '@argonprotocol/mainchain';

export type IEthereumTransferProof = Parameters<ArgonClient['tx']['crosschainTransfer']['proveTransfer']>[0];

export interface IEthereumInboundRelayRequest {
  transferProof: IEthereumTransferProof;
}

export type IEthereumInboundRelayResponse =
  | {
      outcome: 'Rejected';
      reason: string;
      estimatedFee?: bigint;
      estimatedRecoveredFee?: bigint;
    }
  | {
      outcome: 'Submitted';
      delegateAddress: string;
      argonTxHash: string;
      argonTxId?: number;
      extrinsicMethodJson: any;
      txNonce: number;
      txSubmittedAtBlockHeight: number;
      txSubmittedAtTime: Date;
      estimatedFee: bigint;
      estimatedRecoveredFee?: bigint;
      auditId?: string;
    };
