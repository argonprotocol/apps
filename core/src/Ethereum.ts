import { decodeAddress, EvmContracts } from '@argonprotocol/mainchain';
import type { LiveQueryRecord } from '@argonprotocol/runtime-client';
import type { Registry } from '@polkadot/types/types';
import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  encodeFunctionData,
  getAddress,
  parseAbi,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import type { ArgonQueryClient } from './MainchainClients.js';

/** Minimum ordinary transfer from Ethereum, in six-decimal runtime units. */
export const ETHEREUM_MIN_TRANSFER_AMOUNT = 10_000n;

// The deployed 1.5.2 gateway predates versioned council snapshots.
export const ethereumGatewayV0Abi = parseAbi([
  'function applyGatewayUpdates((address[] signers, uint256[] weights) currentCouncil, (uint64 queueNonce, uint8 kind, bytes payload, bytes[] signatures)[] updates, bytes32 relayerArgonAccountId)',
  'function forceUpdateActiveCouncil((address[] signers, uint256[] weights) nextCouncil, uint128 nextMicrogonsPerArgonot)',
]);

/** Existing councils retain V0; the new runtime creates versioned councils. */
export function getNewEthereumCouncilVersion(registry: Registry): 0 | 1 {
  const council = registry.createType('PalletCrosschainTransferGlobalIssuanceCouncil');
  return 'version' in council ? 1 : 0;
}

export function toEthereumGatewayCouncil(
  council: NonNullable<LiveQueryRecord<'crosschainTransfer', 'globalIssuanceCouncilByHash'>>,
): EvmContracts.MintingGatewayGlobalIssuanceCouncilHashArgs {
  const members = Object.entries(council.members).sort(([left], [right]) => left.localeCompare(right));
  return {
    signers: members.map(([signer]) => getAddress(signer)),
    weights: members.map(([, member]) => member.weight),
    version: 'version' in council ? council.version : 0,
    epochMicrogonsPerArgonot: council.epochMicrogonsPerArgonot,
    inflationPercentSinceLaunch: 'inflationPercentSinceLaunch' in council ? council.inflationPercentSinceLaunch : 0n,
  };
}

export async function supportsVersionedEthereumCouncils(
  client: Pick<PublicClient, 'readContract'>,
  gatewayAddress: Address,
): Promise<boolean> {
  try {
    await client.readContract({
      address: gatewayAddress,
      abi: EvmContracts.mintingGatewayAbi,
      functionName: 'inflationPercentSinceLaunch',
    });
    return true;
  } catch (error) {
    if (!(error instanceof BaseError)) throw error;
    const cause = error.walk(
      entry => entry instanceof ContractFunctionRevertedError || entry instanceof ContractFunctionZeroDataError,
    );
    if (cause instanceof ContractFunctionZeroDataError) return false;
    if (cause instanceof ContractFunctionRevertedError) {
      if (cause.raw && cause.raw !== '0x') throw error;
      if (cause.reason && cause.reason !== 'execution reverted') throw error;
      return false;
    }
    throw error;
  }
}

export async function encodeEthereumCouncilUpdate({
  client,
  gatewayAddress,
  council,
}: {
  client: Pick<PublicClient, 'readContract'>;
  gatewayAddress: Address;
  council: EvmContracts.MintingGatewayGlobalIssuanceCouncilHashArgs;
}): Promise<Hex> {
  if (await supportsVersionedEthereumCouncils(client, gatewayAddress)) {
    return encodeFunctionData({
      abi: EvmContracts.mintingGatewayAbi,
      functionName: 'forceUpdateActiveCouncil',
      args: [council, council.epochMicrogonsPerArgonot, council.inflationPercentSinceLaunch ?? 0n],
    });
  }
  if (council.version !== 0) {
    throw new Error('Upgrade the Ethereum gateway contract before syncing a versioned council.');
  }
  return encodeFunctionData({
    abi: ethereumGatewayV0Abi,
    functionName: 'forceUpdateActiveCouncil',
    args: [council, council.epochMicrogonsPerArgonot],
  });
}

export async function getLatestArgonFinalizedExecutionHeader(client: ArgonQueryClient): Promise<{
  blockHash: string;
  blockNumber: bigint;
}> {
  const hashQuery = client.query.ethereumVerifier.latestExecutionHeaderAnchorBlockHash();
  if (!hashQuery) throw new Error('Ethereum verifier storage is unavailable');

  const blockHash = await hashQuery;
  if (!blockHash) throw new Error('No Argon finalized execution header is available yet; wait for relayer sync');

  const headerQuery = client.query.ethereumVerifier.executionHeaderAnchors(blockHash);
  if (!headerQuery) throw new Error('Ethereum verifier storage is unavailable');

  const header = await headerQuery;
  if (!header) throw new Error(`Argon finalized execution header ${blockHash} is missing`);
  return { blockHash, blockNumber: header.blockNumber };
}

export function toArgonAccountIdHex(address: string): Hex {
  return toHex(decodeAddress(address), { size: 32 });
}
