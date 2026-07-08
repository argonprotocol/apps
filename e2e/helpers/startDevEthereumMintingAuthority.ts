import { MainchainClients, minimumVaultDelegateBalance, NetworkConfig } from '@argonprotocol/apps-core';
import { waitFor } from '@argonprotocol/apps-core/__test__/helpers/waitFor.ts';
import type { ArgonClient } from '@argonprotocol/mainchain';
import { MICROGONS_PER_ARGON } from '@argonprotocol/mainchain';
import { createPublicClient, getAddress, http } from 'viem';
import { sudoSubmitAndFinalize } from '../../core/__test__/helpers/mainchain.ts';
import { AppVaultOperator, type IEthereumMintingAuthorityStatus } from '../actors/AppVaultOperator.ts';
import { readDevEthereumRuntimeState, resolveDevEthereumRpcUrl, writeDevEthereumRuntimeState } from '../devEthereum.ts';
import {
  collectVaultOperatorsByEffectiveCouncilSigner,
  forceUpdateGlobalIssuanceCouncil,
} from '../scripts/forceUpdateGlobalIssuanceCouncil.ts';
import { fundArgonAccount } from '../scripts/fundArgonAccount.ts';
import { fundDevEthereumAccount } from '../scripts/fundDevEthereumAccount.ts';
import { MemoryWalletKeys } from 'src-vue/lib/MemoryWalletKeys.ts';

const DEV_ETHEREUM_BACKEND_MINTING_AUTHORITY_MNEMONIC =
  'legal winner thank year wave sausage worth useful legal winner thank yellow';

export type IDevEthereumMintingAuthorityRuntime = {
  actor: AppVaultOperator;
  shutdown(): Promise<void>;
};

export async function startDevEthereumMintingAuthority(args: {
  archiveUrl: string;
  logPrefix?: string;
  executionRpcUrl?: string;
  virtualEnv?: {
    appInstance?: string;
    network?: string;
    serverEnvVars?: NodeJS.ProcessEnv;
  };
}): Promise<IDevEthereumMintingAuthorityRuntime> {
  const executionRpcUrl = await resolveDevEthereumRpcUrl({
    rpcUrl: args.executionRpcUrl,
    logPrefix: args.logPrefix,
  });
  const logPrefix = args.logPrefix ?? 'dev-ethereum-minting-authority';
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
  await updateMintingAuthorityRuntimeState(executionRpcUrl, 'starting');
  const clients = new MainchainClients(args.archiveUrl, () => false);
  const actor = await AppVaultOperator.load({
    clients,
    walletKeys: new MemoryWalletKeys({
      substrateSuri: DEV_ETHEREUM_BACKEND_MINTING_AUTHORITY_MNEMONIC,
      masterMnemonic: DEV_ETHEREUM_BACKEND_MINTING_AUTHORITY_MNEMONIC,
    }),
  });
  const getClient = async () => await clients.get(false);

  let isShutdown = false;
  let shouldStopAuthorizing = false;
  let authorizeTransfersPromise: Promise<void> | undefined;
  let lastActivationProgressLogAt = 0;
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
    let activationStatus = await activateDevEthereumMintingAuthority({
      actor,
      archiveUrl: args.archiveUrl,
      client: await getClient(),
      executionRpcUrl,
      logPrefix,
    });
    await updateMintingAuthorityRuntimeState(executionRpcUrl, 'ready');

    authorizeTransfersPromise = (async () => {
      while (!shouldStopAuthorizing) {
        try {
          const client = await getClient();
          if (!activationStatus.authorityActive) {
            activationStatus = await refreshMintingAuthorityActivation({
              actor,
              client,
              logPrefix,
            });
            if (activationStatus.authorityActive) {
              console.info(`[${logPrefix}] minting authority activation is finalized`);
            } else if (Date.now() - lastActivationProgressLogAt >= 10_000) {
              lastActivationProgressLogAt = Date.now();
              console.info(
                `[${logPrefix}] minting authority still waiting active=${String(activationStatus.authorityActive)} pending=${String(activationStatus.authorityPendingActivation)} approvals=${activationStatus.pendingApprovals}`,
              );
            }
            await new Promise(resolve => setTimeout(resolve, 1_000));
            continue;
          }

          const didAuthorize = await actor.authorizeNextPendingTransfer(client);
          if (!didAuthorize) {
            await new Promise(resolve => setTimeout(resolve, 1_000));
          }
        } catch (error) {
          console.warn(`[${logPrefix}] Unable to progress Ethereum minting authority`, error);
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
  actor: AppVaultOperator;
  archiveUrl: string;
  client: ArgonClient;
  executionRpcUrl: string;
  logPrefix: string;
}): Promise<IEthereumMintingAuthorityStatus> {
  const { actor, archiveUrl, client, executionRpcUrl, logPrefix } = args;
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
    return status;
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
  await actor.myVault.subscribe();

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

  const relaySignerAddress = getAddress(actor.walletKeys.ethereumAddress);
  const relaySignerBalance = await createPublicClient({
    transport: http(executionRpcUrl, { retryCount: 1, timeout: 15_000 }),
  }).getBalance({
    address: relaySignerAddress,
  });
  const minimumRelayBalanceWei = 10n ** 17n;
  if (relaySignerBalance < minimumRelayBalanceWei) {
    console.info(`[${logPrefix}] funding gateway relay signer ETH`);
    await fundDevEthereumAccount({
      to: relaySignerAddress,
      rpcUrl: executionRpcUrl,
      amountBaseUnits: minimumRelayBalanceWei - relaySignerBalance,
    });
  }

  status = await refreshMintingAuthorityActivation({
    actor,
    client,
    logPrefix,
  });
  if (status.authorityActive) {
    console.info(`[${logPrefix}] minting authority activation is finalized`);
  } else {
    console.info(`[${logPrefix}] minting authority activation is continuing in the background`);
  }
  return status;
}

async function updateMintingAuthorityRuntimeState(
  executionRpcUrl: string,
  mintingAuthorityStatus: 'starting' | 'ready',
): Promise<void> {
  const runtimeState = await readDevEthereumRuntimeState(executionRpcUrl);
  if (!runtimeState || runtimeState.executionRpcUrl !== executionRpcUrl) {
    return;
  }

  await writeDevEthereumRuntimeState({
    ...runtimeState,
    mintingAuthorityStatus,
  });
}

async function refreshMintingAuthorityActivation(args: {
  actor: AppVaultOperator;
  client: ArgonClient;
  logPrefix: string;
}): Promise<IEthereumMintingAuthorityStatus> {
  let status = await args.actor.getEthereumMintingAuthorityStatus({
    client: args.client,
  });
  if (status.gatewayPauseReason) {
    throw new Error(status.gatewayPauseReason);
  }
  if (status.authorityActive) {
    return status;
  }

  if (status.pendingApprovals > 0) {
    console.info(`[${args.logPrefix}] approving pending council updates`);
    await args.actor.approvePendingGatewayUpdates({
      client: args.client,
    });
    status = await args.actor.getEthereumMintingAuthorityStatus({
      client: args.client,
      priorStatus: status,
    });
  }

  const finalizedClient = await args.client.at(await args.client.rpc.chain.getFinalizedHead());
  await args.actor.globalCouncil.refresh(finalizedClient);
  if (status.authorityPendingActivation && status.pendingApprovals === 0) {
    const preview = await args.actor.globalCouncil.getReadyGatewayRelayPreview();
    if (preview.canRelay && preview.activationCount > 0) {
      console.info(`[${args.logPrefix}] relaying approved gateway updates`);
      await args.actor.relayApprovedGatewayUpdates();
    }
  }

  return await args.actor.getEthereumMintingAuthorityStatus({
    client: args.client,
    priorStatus: status,
  });
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
  appInstance?: string;
  network?: string;
  serverEnvVars?: NodeJS.ProcessEnv;
}) {
  const appId = `com.argon.desktop`;
  const appName = 'Argon Desktop';
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
