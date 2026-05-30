import { EvmContracts, MICROGONS_PER_ARGON, type IArgonQueryable } from '@argonprotocol/mainchain';
import { createPublicClient, getAddress, http, type Address, type Hex, type PublicClient } from 'viem';

// Measured in the mainchain deploy gas harness:
// `yarn workspace @argonprotocol/ethereum-deploy gas:measure`
const DEV_ETHEREUM_ACTIVATION_GAS_RECOMMENDATION = {
  activationGasCost: 37_731n,
  signatureGasCost: 9_175n,
} as const;
const MIN_DEV_ETHEREUM_WEI_PER_GAS = 1_000_000_000n;
// Keep isolated e2e deterministic/offline with the same explicit estimate used in
// mainchain's Ethereum proof e2e.
const FALLBACK_DEV_ETHEREUM_ESTIMATED_MICROGONS_PER_ETH = 1_000_000n;

export async function loadDevEthereumActivationRepaymentPricing(args: {
  finalizedClient: IArgonQueryable;
  executionRpcUrl: string;
}) {
  const { finalizedClient, executionRpcUrl } = args;
  const executionClient = createPublicClient({
    transport: http(executionRpcUrl, { retryCount: 1, timeout: 15_000 }),
  });
  const estimatedWeiPerGas = await executionClient.getGasPrice();

  return {
    ...DEV_ETHEREUM_ACTIVATION_GAS_RECOMMENDATION,
    estimatedWeiPerGas:
      estimatedWeiPerGas < MIN_DEV_ETHEREUM_WEI_PER_GAS ? MIN_DEV_ETHEREUM_WEI_PER_GAS : estimatedWeiPerGas,
    estimatedMicrogonsPerEth: await deriveEstimatedMicrogonsPerEth(finalizedClient),
  };
}

export async function syncEthereumGatewayActiveCouncilToArgon(args: {
  finalizedClient: IArgonQueryable;
  gatewayAddress: Address;
  publicClient: Pick<PublicClient, 'readContract' | 'waitForTransactionReceipt'>;
  sendCurrentCouncil: (
    currentCouncil: { signers: Address[]; weights: bigint[] },
    nextMicrogonsPerArgonot: bigint,
  ) => Promise<Hex>;
}): Promise<{
  status: 'no-active-council' | 'missing-active-council' | 'already-matching' | 'synced';
  hash?: Hex;
}> {
  const { finalizedClient, gatewayAddress, publicClient, sendCurrentCouncil } = args;
  const activeCouncilHashOption =
    await finalizedClient.query.crosschainTransfer.activeGlobalIssuanceCouncilByDestinationChain('Ethereum');
  if (activeCouncilHashOption.isNone) {
    return { status: 'no-active-council' };
  }

  const activeCouncilOption = await finalizedClient.query.crosschainTransfer.globalIssuanceCouncilByHash(
    activeCouncilHashOption.unwrap(),
  );
  if (activeCouncilOption.isNone) {
    return { status: 'missing-active-council' };
  }

  const activeCouncil = activeCouncilOption.unwrap();
  const members = [...activeCouncil.members.entries()].sort(([leftSigner], [rightSigner]) =>
    leftSigner.toHex().localeCompare(rightSigner.toHex()),
  );
  const currentCouncil = {
    signers: members.map(([signer]) => getAddress(signer.toHex())),
    weights: members.map(([, member]) => member.weight.toBigInt()),
  };
  const nextMicrogonsPerArgonot = activeCouncil.epochMicrogonsPerArgonot.toBigInt();
  const gatewayCouncil = (await publicClient.readContract({
    address: gatewayAddress,
    abi: EvmContracts.mintingGatewayAbi,
    functionName: 'globalIssuanceCouncil',
  })) as readonly [bigint, bigint, Hex, bigint];
  const expectedGatewayCouncilHash = EvmContracts.hashMintingGatewayGlobalIssuanceCouncil({
    ...currentCouncil,
    epochMicrogonsPerArgonot: nextMicrogonsPerArgonot,
  });

  if (gatewayCouncil[2].toLowerCase() === expectedGatewayCouncilHash.toLowerCase()) {
    return { status: 'already-matching' };
  }

  const hash = await sendCurrentCouncil(currentCouncil, nextMicrogonsPerArgonot);
  await publicClient.waitForTransactionReceipt({ hash });
  return { status: 'synced', hash };
}

async function deriveEstimatedMicrogonsPerEth(finalizedClient: IArgonQueryable) {
  const currentPriceIndex = await finalizedClient.query.priceIndex.current();
  if (currentPriceIndex.isNone) {
    throw new Error('Cannot derive dev Ethereum activation repayment pricing because priceIndex.current is empty.');
  }

  const argonUsdTargetPrice = currentPriceIndex.unwrap().argonUsdTargetPrice.toBigInt();
  if (argonUsdTargetPrice <= 0n) {
    throw new Error('Cannot derive dev Ethereum activation repayment pricing because argonUsdTargetPrice is zero.');
  }

  try {
    const ethUsdPrice = await getCoinbaseSpotPrice('ETH-USD');
    return (ethUsdPrice * BigInt(MICROGONS_PER_ARGON)) / argonUsdTargetPrice;
  } catch (error) {
    console.warn(
      `[dev-ethereum] Falling back to offline estimatedMicrogonsPerEth=${FALLBACK_DEV_ETHEREUM_ESTIMATED_MICROGONS_PER_ETH.toString()} because ETH-USD spot lookup failed: ${(error as Error).message}`,
    );
    return FALLBACK_DEV_ETHEREUM_ESTIMATED_MICROGONS_PER_ETH;
  }
}

async function getCoinbaseSpotPrice(pair: 'ETH-USD') {
  const response = await fetch(`https://api.coinbase.com/v2/prices/${pair}/spot`);
  if (!response.ok) {
    throw new Error(`Coinbase spot price request failed for ${pair}: ${response.status} ${response.statusText}`);
  }

  const json = (await response.json()) as {
    data?: {
      amount?: string;
    };
  };
  const amount = json.data?.amount;
  if (!amount) {
    throw new Error(`Coinbase spot price response did not include an amount for ${pair}.`);
  }

  const [wholePart, fractionPart = ''] = amount.split('.');
  const fraction = `${fractionPart}000000000000000000`.slice(0, 18);
  return BigInt(`${wholePart}${fraction}`);
}
