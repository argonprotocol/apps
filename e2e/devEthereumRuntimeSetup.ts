import {
  dispatchErrorToString,
  type ArgonClient,
  EvmContracts,
  getEthereumBeaconSyncBootstrapTx,
  getEthereumBeaconSyncState,
  type IArgonQueryable,
  type KeyringPair,
  MICROGONS_PER_ARGON,
  TxSubmitter,
} from '@argonprotocol/mainchain';
import { createPublicClient, getAddress, http, type Address, type Hex, type PublicClient } from 'viem';
import { waitForFinalizedBeaconExecutionAtOrAbove } from '../bot/src/EthereumBeaconSyncService.ts';

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

export async function ensureDevEthereumBeaconBootstrapped(
  client: ArgonClient,
  beaconApiUrl: string,
  sudoKeypair: KeyringPair,
  options: {
    timeoutMs?: number;
    pollMs?: number;
    minimumExecutionBlockNumber?: bigint;
    minimumFinalizedSlot?: bigint;
  } = {},
): Promise<void> {
  const startedAt = Date.now();
  console.log('[dev-ethereum] Checking beacon bootstrap state');
  const state = await getEthereumBeaconSyncState(client);
  if (state.isBootstrapped) {
    console.log(`[dev-ethereum] Beacon bootstrap already present after ${Date.now() - startedAt}ms`);
    return;
  }

  const timeoutMs = options.timeoutMs ?? 5 * 60_000;
  const pollMs = options.pollMs ?? 1_000;
  const minimumExecutionBlockNumber = options.minimumExecutionBlockNumber ?? 1n;
  const minimumFinalizedSlot = options.minimumFinalizedSlot ?? 0n;

  console.log(
    `[dev-ethereum] Waiting for finalized beacon execution block >= ${minimumExecutionBlockNumber} and slot >= ${minimumFinalizedSlot}`,
  );
  await waitForFinalizedBeaconExecutionAtOrAbove(beaconApiUrl, minimumExecutionBlockNumber, {
    timeoutMs,
    pollMs,
    minimumFinalizedSlot,
  });
  console.log(`[dev-ethereum] Finalized beacon execution is ready after ${Date.now() - startedAt}ms`);

  const bootstrapTxStartedAt = Date.now();
  let bootstrapTx;
  let lastBootstrapError: Error | undefined;

  while (Date.now() - bootstrapTxStartedAt < timeoutMs) {
    try {
      bootstrapTx = await getEthereumBeaconSyncBootstrapTx(client, beaconApiUrl);
      console.log(`[dev-ethereum] Built beacon bootstrap transaction after ${Date.now() - bootstrapTxStartedAt}ms`);
      break;
    } catch (error) {
      if (!(error instanceof Error)) {
        throw error;
      }

      lastBootstrapError = error;
      if (!error.message.includes('/eth/v1/beacon/light_client/bootstrap/') || !error.message.includes('404')) {
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, pollMs));
    }
  }

  if (!bootstrapTx) {
    const lastErrorSuffix = lastBootstrapError ? ` Last error: ${lastBootstrapError.message}` : '';
    throw new Error(
      `Ethereum beacon light-client bootstrap endpoint did not become ready within ${Math.floor(timeoutMs / 1000)}s.${lastErrorSuffix}`,
    );
  }

  console.log('[dev-ethereum] Submitting beacon bootstrap sudo transaction');
  await submitDevSudoTransaction({
    client,
    tx: bootstrapTx,
    sudoKeypair,
    isApplied: async () => (await getEthereumBeaconSyncState(client)).isBootstrapped,
    description: 'Bootstrap',
  });

  console.log(`[dev-ethereum] Beacon bootstrap completed successfully in ${Date.now() - startedAt}ms`);
}

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

export async function submitDevAdminTransaction(args: {
  isApplied: () => Promise<boolean>;
  submit: () => Promise<void>;
}): Promise<void> {
  let relocationError: unknown;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (await args.isApplied()) {
      return;
    }

    try {
      await args.submit();
      return;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.message !== 'Cannot publish transaction block state before extrinsic index is known'
      ) {
        throw error;
      }
      relocationError = error;
    }
  }

  if (await args.isApplied()) {
    return;
  }

  throw relocationError;
}

export async function submitDevSudoTransaction(args: {
  client: ArgonClient;
  tx: ConstructorParameters<typeof TxSubmitter>[1];
  sudoKeypair: KeyringPair;
  isApplied: () => Promise<boolean>;
  description: string;
}): Promise<void> {
  const { client, tx, sudoKeypair, isApplied, description } = args;

  await submitDevAdminTransaction({
    isApplied,
    submit: async () => {
      const result = await new TxSubmitter(client, client.tx.sudo.sudo(tx), sudoKeypair).submit({
        useLatestNonce: true,
      });
      await result.waitForInFirstBlock;

      const sudoResultEvent = result.events.find(event => client.events.sudo.Sudid.is(event));
      if (!sudoResultEvent || !client.events.sudo.Sudid.is(sudoResultEvent)) {
        throw new Error(`${description} transaction did not emit sudo.Sudid.`);
      }
      if (sudoResultEvent.data.sudoResult.isErr) {
        throw new Error(
          `${description} failed: ${dispatchErrorToString(client, sudoResultEvent.data.sudoResult.asErr)}`,
        );
      }
    },
  });
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
