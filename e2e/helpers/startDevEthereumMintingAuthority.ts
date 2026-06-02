import { MainchainClients, minimumVaultDelegateBalance, NetworkConfig } from '@argonprotocol/apps-core';
import { waitFor } from '@argonprotocol/apps-core/__test__/helpers/waitFor.ts';
import type { ArgonClient } from '@argonprotocol/mainchain';
import { EvmContracts, getClient, getEthereumBeaconSyncState, MICROGONS_PER_ARGON } from '@argonprotocol/mainchain';
import { createPublicClient, getAddress, http } from 'viem';
import { sudoSubmitAndFinalize } from '../../core/__test__/helpers/mainchain.ts';
import type { IEthereumMintingAuthorityStatus, VaultActor } from '../actors/VaultActor.ts';
import { readDevEthereumRuntimeState, resolveDevEthereumRpcUrl } from '../devEthereum.ts';
import {
  collectVaultOperatorsByEffectiveCouncilSigner,
  forceUpdateGlobalIssuanceCouncil,
} from '../scripts/forceUpdateGlobalIssuanceCouncil.ts';
import { fundArgonAccount } from '../scripts/fundArgonAccount.ts';
import { fundDevEthereumAccount } from '../scripts/fundDevEthereumAccount.ts';

const DEV_ETHEREUM_MINTING_AUTHORITY_MNEMONIC = 'test test test test test test test test test test test junk';

export type IDevEthereumMintingAuthorityRuntime = {
  actor: VaultActor;
  shutdown(): Promise<void>;
};

export async function startDevEthereumMintingAuthority(args: {
  archiveUrl: string;
  logPrefix?: string;
  executionRpcUrl?: string;
  virtualEnv?: {
    app?: string;
    appInstance?: string;
    network?: string;
    serverEnvVars?: NodeJS.ProcessEnv;
  };
}): Promise<IDevEthereumMintingAuthorityRuntime> {
  const executionRpcUrl = await resolveDevEthereumRpcUrl({
    rpcUrl: args.executionRpcUrl,
    logPrefix: args.logPrefix,
  });
  NetworkConfig.setNetwork('dev-docker');
  NetworkConfig.setRuntimeOverride('dev-docker', {
    ethereumNetwork: {
      executionRpcUrl,
      finalityBlocks: 16,
    },
  });
  seedVirtualFrontendGlobals({
    ...args.virtualEnv,
    network: args.virtualEnv?.network ?? 'dev-docker',
  });
  await waitForDevEthereumGatewayReady({
    archiveUrl: args.archiveUrl,
    executionRpcUrl,
    logPrefix: args.logPrefix ?? 'dev-ethereum-minting-authority',
  });
  const { VaultActor } = await import('../actors/VaultActor.ts');
  const clients = new MainchainClients(args.archiveUrl, () => false);
  const actor = await VaultActor.load({
    clients,
    mnemonic: DEV_ETHEREUM_MINTING_AUTHORITY_MNEMONIC,
  });
  const getClient = async () => await clients.get(false);

  let isShutdown = false;
  let shouldStopAuthorizing = false;
  let authorizeTransfersPromise: Promise<void> | undefined;
  const shutdown = async () => {
    if (isShutdown) {
      return;
    }
    isShutdown = true;
    shouldStopAuthorizing = true;
    await authorizeTransfersPromise?.catch(() => undefined);
    await actor.dispose();
    await clients.disconnect();
  };

  try {
    await activateDevEthereumMintingAuthority({
      actor,
      archiveUrl: args.archiveUrl,
      client: await getClient(),
      executionRpcUrl,
      logPrefix: args.logPrefix ?? 'dev-ethereum-minting-authority',
    });

    authorizeTransfersPromise = (async () => {
      while (!shouldStopAuthorizing) {
        try {
          const client = await getClient();
          const didAuthorize = await actor.authorizeNextPendingTransfer(client);
          if (!didAuthorize) {
            await new Promise(resolve => setTimeout(resolve, 1_000));
          }
        } catch (error) {
          console.warn(
            `[${args.logPrefix ?? 'dev-ethereum-minting-authority'}] Unable to authorize pending Ethereum transfer`,
            error,
          );
          await new Promise(resolve => setTimeout(resolve, 1_000));
        }
      }
    })();

    return {
      actor,
      shutdown,
    };
  } catch (error) {
    await shutdown();
    throw error;
  }
}

async function activateDevEthereumMintingAuthority(args: {
  actor: VaultActor;
  archiveUrl: string;
  client: ArgonClient;
  executionRpcUrl: string;
  logPrefix: string;
}) {
  const { actor, archiveUrl, client, executionRpcUrl, logPrefix } = args;
  const ethereumClient = createPublicClient({
    transport: http(executionRpcUrl, { retryCount: 1, timeout: 15_000 }),
  });
  const initialCommittedMicronots = 1n * BigInt(MICROGONS_PER_ARGON);
  const mintingAuthorityRegistrationMicrogonCollateral = 2000n * BigInt(MICROGONS_PER_ARGON);
  const requiredVaultingBalance = actor.config.vaultingRules.baseMicrogonCommitment + 2n * BigInt(MICROGONS_PER_ARGON);

  NetworkConfig.setRuntimeOverride('dev-docker', {
    ethereumNetwork: {
      executionRpcUrl,
      finalityBlocks: 16,
    },
  });

  let status = await actor.getEthereumMintingAuthorityStatus({
    client,
  });
  if (status.authorityActive) {
    return;
  }

  const getFinalizedClient = async () => await client.at(await client.rpc.chain.getFinalizedHead());

  const refreshStatus = async () =>
    (status = await actor.getEthereumMintingAuthorityStatus({
      client,
      priorStatus: status,
    }));

  const waitForStatus = async (args: {
    label: string;
    timeoutMs: number;
    timeoutMessage: string;
    isReady: (status: IEthereumMintingAuthorityStatus) => boolean;
    stopOnPause?: boolean;
  }) => {
    console.info(`[${logPrefix}] waiting for ${args.label}`);
    await waitFor(
      args.timeoutMs,
      `${logPrefix}: ${args.label}`,
      async () => {
        const nextStatus = await refreshStatus();
        if (args.stopOnPause && nextStatus.gatewayPauseReason) {
          throw new Error(nextStatus.gatewayPauseReason);
        }
        if (args.isReady(nextStatus)) {
          return nextStatus;
        }
      },
      {
        pollMs: 1_000,
        timeoutMessage: args.timeoutMessage,
      },
    );
  };

  console.info(`[${logPrefix}] funding vaulting and delegate balances`);
  await ensureArgonBalance({
    address: status.vaultingAddress,
    archiveUrl,
    client,
    microgons: requiredVaultingBalance,
    micronots: initialCommittedMicronots,
  });
  await ensureArgonBalance({
    address: status.delegateAddress,
    archiveUrl,
    client,
    microgons: minimumVaultDelegateBalance * 2n,
    micronots: 0n,
  });
  await ensureMinimumMintingAuthorityValue(client);

  await waitForStatus({
    label: 'Ethereum runtime setup',
    timeoutMs: 2 * 60_000,
    timeoutMessage: `${logPrefix}: Ethereum transfer gateway setup was not fully visible within 120000ms.`,
    isReady: nextStatus => nextStatus.hasEthereumChainConfig && nextStatus.hasActivationRepaymentPricing,
  });
  console.info(`[${logPrefix}] Ethereum runtime setup is visible`);

  console.info(`[${logPrefix}] ensuring vault readiness`);
  await actor.ensureVaultReady();

  console.info(`[${logPrefix}] ensuring council signer registration`);
  await actor.ensureCouncilSignerRegistered({ client });

  console.info(`[${logPrefix}] setting initial committed Argonots for council weight`);
  await actor.setCommittedArgonots({
    amount: initialCommittedMicronots,
  });

  console.info(`[${logPrefix}] waiting for the council signer to become effective`);
  await waitFor(
    60_000,
    `${logPrefix}: effective Ethereum council signer visibility`,
    async () => {
      const finalizedClient = await getFinalizedClient();
      const effectiveSigners = await collectVaultOperatorsByEffectiveCouncilSigner(finalizedClient);
      const effectiveSigner = effectiveSigners.get(status.councilSigner.toLowerCase());

      if (effectiveSigner?.accountId === status.vaultingAddress) {
        console.info(
          `[${logPrefix}] effective council signer ${effectiveSigner.signer} is now assigned to ${effectiveSigner.accountId}`,
        );
        return effectiveSigner;
      }
    },
    {
      pollMs: 1_000,
      timeoutMessage: `${logPrefix}: vault ${status.vaultingAddress} never became an effective Ethereum council signer before the force update.`,
    },
  );

  console.info(`[${logPrefix}] forcing global issuance council`);
  await forceUpdateGlobalIssuanceCouncil({
    archiveUrl,
    executionRpcUrl,
    vaultAddresses: [status.vaultingAddress],
  });

  await waitForStatus({
    label: 'active Ethereum council',
    timeoutMs: 60_000,
    timeoutMessage: `${logPrefix}: active Ethereum council did not become visible after the force update.`,
    isReady: nextStatus => nextStatus.hasActiveCouncil,
  });
  console.info(`[${logPrefix}] active Ethereum council is visible`);

  const registrationMicronotCollateral = await actor.getRequiredMintingAuthorityMicronotCollateral({
    finalizedClient: await getFinalizedClient(),
    microgonCollateral: mintingAuthorityRegistrationMicrogonCollateral,
  });
  await ensureArgonBalance({
    address: status.vaultingAddress,
    archiveUrl,
    client,
    microgons: requiredVaultingBalance,
    micronots: registrationMicronotCollateral,
  });

  console.info(`[${logPrefix}] setting committed Argonots`);
  await actor.setCommittedArgonots({
    amount: registrationMicronotCollateral,
  });

  console.info(`[${logPrefix}] registering minting authority`);
  const registerTxInfo = await actor.registerMintingAuthority({
    microgonCollateral: 0n,
    micronotCollateral: registrationMicronotCollateral,
  });
  await registerTxInfo.waitForPostProcessing;
  status = {
    ...status,
    mintingAuthoritySigner: registerTxInfo.tx.metadataJson.destinationSigningKey,
  };

  console.info(`[${logPrefix}] waiting for minting authority registration`);
  await actor.waitForMintingAuthorityRegistration({
    client,
    signingKey: status.mintingAuthoritySigner,
  });

  await waitForStatus({
    label: 'pending council approval',
    timeoutMs: 60_000,
    timeoutMessage: `${logPrefix}: minting authority activation approval never appeared in the council queue.`,
    stopOnPause: true,
    isReady: nextStatus => nextStatus.pendingApprovals > 0,
  });

  console.info(`[${logPrefix}] approving pending council updates`);
  if (!(await actor.approvePendingGatewayUpdates({ client }))) {
    throw new Error(`${logPrefix}: minting authority activation approval disappeared before it could be signed.`);
  }

  const relaySignerBalance = await ethereumClient.getBalance({
    address: getAddress(status.councilSigner),
  });
  const minimumRelayBalanceWei = 10n ** 17n;

  if (relaySignerBalance < minimumRelayBalanceWei) {
    console.info(`[${logPrefix}] funding council signer ETH for gateway relay`);
    await fundDevEthereumAccount({
      to: status.councilSigner,
      rpcUrl: executionRpcUrl,
      amountBaseUnits: minimumRelayBalanceWei - relaySignerBalance,
    });
  }

  console.info(`[${logPrefix}] relaying approved gateway updates`);
  const relayPreview = await actor.globalCouncil.getReadyGatewayRelayPreview();
  if (!relayPreview.canRelay) {
    throw new Error(`${logPrefix}: Ethereum gateway relay is not ready (${relayPreview.reason ?? 'unknown'})`);
  }
  const relayApprovalsReceipt = await actor.relayApprovedGatewayUpdates();
  if (!relayApprovalsReceipt) {
    throw new Error(`${logPrefix}: no approved Ethereum gateway updates were available to relay.`);
  }

  console.info(`[${logPrefix}] waiting for minting authority activation`);
  let lastActivationProgressLogAt = 0;
  try {
    await waitFor(
      60_000,
      `${logPrefix}: minting authority activation`,
      async () => {
        const nextStatus = await refreshStatus();
        if (nextStatus.gatewayPauseReason) {
          throw new Error(nextStatus.gatewayPauseReason);
        }
        if (nextStatus.authorityActive) {
          return nextStatus;
        }
        if (Date.now() - lastActivationProgressLogAt >= 10_000) {
          lastActivationProgressLogAt = Date.now();
          console.info(
            `[${logPrefix}] minting authority still waiting active=${String(nextStatus.authorityActive)} pending=${String(nextStatus.authorityPendingActivation)} approvals=${nextStatus.pendingApprovals}`,
          );
        }
      },
      {
        pollMs: 1_000,
        timeoutMessage: `${logPrefix}: minting authority did not become active on Argon in time.`,
      },
    );
    console.info(`[${logPrefix}] minting authority activation is finalized`);
  } catch (error) {
    const finalizedClient = await getFinalizedClient();
    const [authorityOption, gatewayStateOption, beaconSyncState] = await Promise.all([
      finalizedClient.query.crosschainTransfer.mintingAuthoritiesBySigner(status.mintingAuthoritySigner),
      finalizedClient.query.crosschainTransfer.gatewayStateBySourceChain('Ethereum'),
      getEthereumBeaconSyncState(client),
    ]);

    const authority = authorityOption.isSome ? authorityOption.unwrap() : undefined;
    const gatewayState = gatewayStateOption.isSome ? gatewayStateOption.unwrap() : undefined;

    console.error(`[${logPrefix}] activation timeout diagnostics`, {
      status: {
        active: status.authorityActive,
        pending: status.authorityPendingActivation,
        approvals: status.pendingApprovals,
        pause: status.gatewayPauseReason || 'none',
      },
      authority: authority
        ? {
            active: authority.state.isActive,
            pending: authority.state.isPendingActivation,
            activationQueueNonce: authority.activationApprovalQueueNonce.toBigInt().toString(),
            remainingMicrogons: authority.gatewayRemainingMicrogonCollateral.toBigInt().toString(),
            remainingMicronots: authority.gatewayRemainingMicronotCollateral.toBigInt().toString(),
          }
        : 'missing',
      gatewayState: gatewayState
        ? {
            argonApprovalsNonce: gatewayState.argonApprovalsNonce.toBigInt().toString(),
            gatewayActivityNonce: gatewayState.gatewayActivityNonce.toBigInt().toString(),
          }
        : 'missing',
      beacon: {
        isBootstrapped: beaconSyncState.isBootstrapped,
        slot: beaconSyncState.isBootstrapped ? beaconSyncState.latestFinalizedSlot.toString() : 'none',
      },
    });
    throw error;
  }
}

async function ensureArgonBalance(args: {
  address: string;
  archiveUrl: string;
  client: ArgonClient;
  microgons: bigint;
  micronots: bigint;
}) {
  const [microgonBalance, micronotBalance] = await Promise.all([
    args.client.query.system.account(args.address).then(x => x.data.free.toBigInt()),
    args.client.query.ownership.account(args.address).then(x => x.free.toBigInt()),
  ]);
  const neededMicrogons = args.microgons > microgonBalance ? args.microgons - microgonBalance : 0n;
  const neededMicronots = args.micronots > micronotBalance ? args.micronots - micronotBalance : 0n;
  if (!neededMicrogons && !neededMicronots) {
    return;
  }

  await fundArgonAccount({
    to: args.address,
    archiveUrl: args.archiveUrl,
    microgons: neededMicrogons || undefined,
    micronots: neededMicronots || undefined,
  });
}

async function ensureMinimumMintingAuthorityValue(client: ArgonClient) {
  const currentMinimum =
    await client.query.crosschainTransfer.minimumMintingAuthorityValueByDestinationChain('Ethereum');
  if (currentMinimum.toBigInt() === 1n) {
    return;
  }

  await sudoSubmitAndFinalize(client, client.tx.crosschainTransfer.setMinimumMintingAuthorityValue('Ethereum', 1));
}

function seedVirtualFrontendGlobals(args?: {
  app?: string;
  appInstance?: string;
  network?: string;
  serverEnvVars?: NodeJS.ProcessEnv;
}) {
  const app = args?.app ?? process.env.ARGON_APP ?? 'operations';
  const appId = `com.argon.${app}`;
  const appName = app === 'treasury' ? 'Argon Treasury' : 'Argon Operations';
  const globals = {
    __ARGON_APP_ID__: appId,
    __ARGON_APP_INSTANCE__: args?.appInstance ?? process.env.ARGON_APP_INSTANCE ?? '',
    __ARGON_NETWORK_NAME__: args?.network ?? process.env.ARGON_NETWORK_NAME ?? 'testnet',
    __ARGON_APP_NAME__: appName,
    __ARGON_NETWORK_CONFIG_OVERRIDE__: undefined,
    __ARGON_APP_ENABLE_AUTOUPDATE__: false,
    __SERVER_ENV_VARS__: args?.serverEnvVars ?? process.env,
    __ARGON_APP_SECURITY__: undefined,
    __ARGON_DRIVER_WS__: '',
    __IS_TEST__: false,
    __LOG_DEBUG__: false,
  };
  const virtualWindow = ((globalThis as Record<string, unknown>).window ??= {} as Record<string, unknown>) as Record<
    string,
    unknown
  >;

  Object.assign(virtualWindow, globals);
  Object.assign(globalThis as Record<string, unknown>, globals);
}

async function waitForDevEthereumGatewayReady(args: {
  archiveUrl: string;
  executionRpcUrl: string;
  logPrefix: string;
}) {
  const publicClient = createPublicClient({
    transport: http(args.executionRpcUrl, { retryCount: 1, timeout: 15_000 }),
  });
  const client = await getClient(args.archiveUrl);

  try {
    await waitFor(
      2 * 60_000,
      `${args.logPrefix}: dev Ethereum gateway readiness`,
      async () => {
        const runtimeState = await readDevEthereumRuntimeState(args.executionRpcUrl);
        if (runtimeState?.setupStatus !== 'ready' || runtimeState.executionRpcUrl !== args.executionRpcUrl) {
          return;
        }

        const finalizedClient = await client.at(await client.rpc.chain.getFinalizedHead());
        const [beaconSyncState, chainConfig] = await Promise.all([
          getEthereumBeaconSyncState(client),
          finalizedClient.query.crosschainTransfer.chainConfigBySourceChain('Ethereum'),
        ]);
        if (!beaconSyncState.isBootstrapped || chainConfig.isNone || !chainConfig.unwrap().isEvm) {
          return;
        }

        const ethereumConfig = chainConfig.unwrap().asEvm;
        const gatewayAddress = getAddress(ethereumConfig.gateway.toHex());
        if ((await publicClient.getChainId()) !== Number(ethereumConfig.chainId.toString())) {
          return;
        }

        try {
          await publicClient.readContract({
            address: gatewayAddress,
            abi: EvmContracts.mintingGatewayAbi,
            functionName: 'argonApprovalsNonce',
          });
          return gatewayAddress;
        } catch {
          return;
        }
      },
      {
        pollMs: 1_000,
        timeoutMessage: `${args.logPrefix}: local Ethereum gateway never became readable on ${args.executionRpcUrl}.`,
      },
    );
  } finally {
    await client.disconnect().catch(() => undefined);
  }
}
