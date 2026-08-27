import { fn } from 'storybook/test';

type EthereumClientModule = typeof import('../EthereumClient.ts');

export class EthereumTransactionRevertedError extends Error {}

export class EthereumClient {
  constructor(..._args: unknown[]) {}
}

export const loadEthereumChainConfig = fn<EthereumClientModule['loadEthereumChainConfig']>();
export const createEthereumPublicClient = fn<EthereumClientModule['createEthereumPublicClient']>();
export const getDefaultEthereumExecutionRpcUrl = fn<EthereumClientModule['getDefaultEthereumExecutionRpcUrl']>(
  () => undefined,
);
export const getEthereumExecutionRpcUrl = fn<EthereumClientModule['getEthereumExecutionRpcUrl']>(
  configuredExecutionRpcUrl => configuredExecutionRpcUrl,
);
export const getDefaultEthereumBeaconApiUrl = fn<EthereumClientModule['getDefaultEthereumBeaconApiUrl']>(
  () => undefined,
);
export const getEthereumBeaconApiUrl = fn<EthereumClientModule['getEthereumBeaconApiUrl']>(
  configuredBeaconApiUrl => configuredBeaconApiUrl,
);
export const hasGatewayApprovalQuorum = fn<EthereumClientModule['hasGatewayApprovalQuorum']>(() => false);
export const toHexValue = fn<EthereumClientModule['toHexValue']>(value => value as `0x${string}`);
export const toArgonAccountIdHex = fn<EthereumClientModule['toArgonAccountIdHex']>();
export const toEvmRecoverableSignature = fn<EthereumClientModule['toEvmRecoverableSignature']>(signature => signature);
export const getEthereumFinalityMillis = fn<EthereumClientModule['getEthereumFinalityMillis']>(() => 60_000);
export const getTransferToArgonWaitEstimateMs = fn<EthereumClientModule['getTransferToArgonWaitEstimateMs']>(
  () => 300_000,
);
export const getGatewayActivityWaitEstimateMs = fn<EthereumClientModule['getGatewayActivityWaitEstimateMs']>(
  () => 3_600_000,
);
export const getEthereumUserErrorMessage = fn<EthereumClientModule['getEthereumUserErrorMessage']>(
  (_error, fallback) => fallback,
);
export const submitEthereumTransaction = fn<EthereumClientModule['submitEthereumTransaction']>();
