import process from 'node:process';
import { type ArgonApi, createArgonClient, NetworkConfigSettings, TxSubmitter } from '@argonprotocol/apps-core';
import { EvmContracts, getClient, Keyring } from '@argonprotocol/mainchain';
import { createPublicClient, encodeFunctionData, getAddress, http } from 'viem';
import { resolveDevEthereumRpcUrl, sendDevEthereumAdminTransaction } from '../e2e/devEthereum.ts';
import { syncEthereumGatewayActiveCouncilToArgon } from '../e2e/devEthereumRuntimeSetup.ts';

type ForceUpdateGlobalIssuanceCouncilArgs = {
  archiveUrl?: string;
  executionRpcUrl?: string;
  vaultAddresses?: string[];
};

export async function forceUpdateGlobalIssuanceCouncil(args: ForceUpdateGlobalIssuanceCouncilArgs) {
  const archiveUrl = resolveArchiveUrl(args.archiveUrl);
  const executionRpcUrl = await resolveDevEthereumRpcUrl({
    rpcUrl: args.executionRpcUrl,
    logPrefix: 'force-update-global-issuance-council',
  });
  const client = createArgonClient(await getClient(archiveUrl));

  try {
    const finalizedClient = await client.at(await client.rpc.chain.getFinalizedHead());
    const vaultAddresses = args.vaultAddresses?.length
      ? args.vaultAddresses
      : [...(await collectVaultOperatorsByEffectiveCouncilSigner(finalizedClient)).values()].map(x => x.accountId);
    if (!vaultAddresses.length) {
      throw new Error(
        'No vault operators with a registered effective Ethereum council signer were found on this runtime.',
      );
    }

    const chainConfig = await finalizedClient.query.crosschainTransfer.chainConfigBySourceChain('Ethereum');
    if (chainConfig?.type !== 'Evm') {
      throw new Error('Ethereum transfer gateway is not configured on this network.');
    }

    const gatewayState = await finalizedClient.query.crosschainTransfer.gatewayStateBySourceChain('Ethereum');
    const afterNonce = gatewayState?.argonApprovalsNonce ?? 0n;
    const sudoKeypair = new Keyring({ type: 'sr25519' }).createFromUri('//Alice');
    const txResult = await new TxSubmitter(
      client,
      client.tx.sudo.sudo(
        client.tx.crosschainTransfer.forceSetGlobalIssuanceCouncil('Ethereum', afterNonce, vaultAddresses),
      ),
      sudoKeypair,
    ).submit({
      useLatestNonce: true,
    });
    await txResult.waitForInFirstBlock;

    const sudoResultEvent = txResult.events.find(event => event.section === 'sudo' && event.method === 'Sudid');
    if (!sudoResultEvent || sudoResultEvent.section !== 'sudo' || sudoResultEvent.method !== 'Sudid') {
      throw new Error('Force-set Ethereum council transaction did not emit sudo.Sudid.');
    }
    if (sudoResultEvent.data.sudoResult.type === 'Err') {
      throw new Error(`Force-set Ethereum council failed: ${JSON.stringify(sudoResultEvent.data.sudoResult.value)}`);
    }

    await txResult.waitForFinalizedBlock;
    const publicClient = createPublicClient({
      transport: http(executionRpcUrl, { retryCount: 1, timeout: 15_000 }),
    });
    const gatewayAddress = getAddress(chainConfig.value.gateway);
    const syncResult = await syncEthereumGatewayActiveCouncilToArgon({
      finalizedClient: await client.at(await client.rpc.chain.getFinalizedHead()),
      gatewayAddress,
      publicClient,
      sendCurrentCouncil: async (currentCouncil, nextMicrogonsPerArgonot) => {
        const { hash } = await sendDevEthereumAdminTransaction({
          rpcUrl: executionRpcUrl,
          to: gatewayAddress,
          data: encodeFunctionData({
            abi: EvmContracts.mintingGatewayAbi,
            functionName: 'forceUpdateActiveCouncil',
            args: [currentCouncil, nextMicrogonsPerArgonot],
          }),
        });
        return hash;
      },
    });

    return {
      vaultAddresses,
      archiveUrl,
      executionRpcUrl,
      afterNonce,
      argonTxHash: txResult.extrinsic.signedHash,
      gatewayTxHash: syncResult.hash,
    };
  } finally {
    await client.disconnect();
  }
}

function resolveArchiveUrl(archiveUrl?: string): string {
  if (archiveUrl?.trim()) {
    return archiveUrl.trim();
  }

  if (!process.env.ARGON_ARCHIVE_URL?.trim() && !process.env.ARGON_NETWORK_CONFIG_OVERRIDE?.trim()) {
    return 'ws://127.0.0.1:9944';
  }

  const runtimeOverride = readRuntimeArchiveUrl();
  if (runtimeOverride) {
    return runtimeOverride;
  }

  const configuredArchiveUrl = process.env.ARGON_ARCHIVE_URL?.trim();
  if (configuredArchiveUrl) {
    return configuredArchiveUrl;
  }

  const networkName = process.env.ARGON_NETWORK_NAME ?? 'dev-docker';
  const config = NetworkConfigSettings[networkName as keyof typeof NetworkConfigSettings];
  if (config?.archiveUrl) {
    return config.archiveUrl;
  }

  throw new Error(
    `force-update-global-issuance-council: unable to resolve archive URL for network "${networkName}". Set ARGON_ARCHIVE_URL, ARGON_NETWORK_CONFIG_OVERRIDE, or provide --archive.`,
  );
}

function readRuntimeArchiveUrl(): string | null {
  const raw = process.env.ARGON_NETWORK_CONFIG_OVERRIDE?.trim();
  if (!raw) return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const candidate = (parsed as { archiveUrl?: unknown }).archiveUrl;
    return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : null;
  } catch {
    return null;
  }
}

export async function collectVaultOperatorsByEffectiveCouncilSigner(finalizedClient: ArgonApi) {
  const activeEntries =
    (await finalizedClient.query.crosschainTransfer.councilSignerByDestinationChainAndAccountId.entries('Ethereum')) ??
    [];
  const pendingEntries =
    (await finalizedClient.query.crosschainTransfer.pendingCouncilSignerByDestinationChainAndAccountId.entries(
      'Ethereum',
    )) ?? [];
  const activeByAccountId = new Map<string, string>();
  const pendingByAccountId = new Map<string, string>();

  for (const [key, signer] of activeEntries) {
    if (!signer) continue;
    activeByAccountId.set(getStorageEntryAccountId(key), signer);
  }

  for (const [key, signer] of pendingEntries) {
    if (!signer) continue;
    pendingByAccountId.set(getStorageEntryAccountId(key), signer);
  }

  const accountsByEffectiveSigner = new Map<string, { accountId: string; signer: string }>();
  for (const accountId of new Set([...activeByAccountId.keys(), ...pendingByAccountId.keys()])) {
    const effectiveSigner = pendingByAccountId.get(accountId) ?? activeByAccountId.get(accountId);
    if (!effectiveSigner) continue;

    const vaultId = await finalizedClient.query.vaults.vaultIdByOperator(accountId);
    if (vaultId === null) continue;

    const signer = getAddress(effectiveSigner);
    const signerKey = signer.toLowerCase();
    const existing = accountsByEffectiveSigner.get(signerKey);
    if (existing && existing.accountId !== accountId) {
      throw new Error(
        `Multiple vault operators have the same effective council signer ${signer}: ${existing.accountId}, ${accountId}`,
      );
    }

    accountsByEffectiveSigner.set(signerKey, { accountId, signer });
  }

  return new Map(
    [...accountsByEffectiveSigner.entries()].sort((left, right) => left[1].signer.localeCompare(right[1].signer)),
  );
}

function getStorageEntryAccountId(key: { readonly args: readonly unknown[] }) {
  const accountId = key.args.at(-1);
  if (typeof accountId !== 'string') {
    throw new Error('Unable to read council signer registration account id from storage entry key');
  }

  return accountId;
}
