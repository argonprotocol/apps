export interface IEthereumGatewayCatchUpRequest {
  sourceChain: 'Ethereum';
  throughGatewayActivityNonce: bigint;
}

export type IEthereumGatewayRelayReasonCode = 'gatewayPaused' | 'missingExecutionAnchor' | 'delegateInsufficientFunds';

export interface IEthereumGatewayRelayStatus {
  isReady: boolean;
  reason?: string;
  reasonCode?: IEthereumGatewayRelayReasonCode;
}

export type IEthereumGatewayCatchUpResponse =
  | {
      outcome: 'Noop';
      throughGatewayActivityNonce?: bigint;
    }
  | {
      outcome: 'Rejected';
      reason: string;
      reasonCode?: IEthereumGatewayRelayReasonCode;
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
