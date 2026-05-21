export interface IEthereumGatewayCatchUpRequest {
  sourceChain: 'Ethereum';
  throughGatewayActivityNonce: bigint;
}

export interface IEthereumGatewayRelayStatus {
  isReady: boolean;
  reason?: string;
}

export type IEthereumGatewayCatchUpResponse =
  | {
      outcome: 'Noop';
      throughGatewayActivityNonce?: bigint;
    }
  | {
      outcome: 'Rejected';
      reason: string;
      estimatedFee?: bigint;
      throughGatewayActivityNonce?: bigint;
    }
  | {
      outcome: 'Submitted';
      delegateAddress: string;
      argonTxHash: string;
      extrinsicMethodJson: any;
      txNonce: number;
      txSubmittedAtBlockHeight: number;
      txSubmittedAtTime: Date;
      estimatedFee: bigint;
      throughGatewayActivityNonce?: bigint;
      auditId?: string;
    };
