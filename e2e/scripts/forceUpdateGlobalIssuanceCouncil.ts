#!/usr/bin/env tsx

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { NetworkConfigSettings } from '@argonprotocol/apps-core';
import {
  dispatchErrorToString,
  EvmContracts,
  getClient,
  type IArgonQueryable,
  Keyring,
  TxSubmitter,
} from '@argonprotocol/mainchain';
import { createPublicClient, encodeFunctionData, getAddress, http } from 'viem';
import { resolveDevEthereumRpcUrl, sendDevEthereumAdminTransaction } from '../devEthereum.ts';
import { syncEthereumGatewayActiveCouncilToArgon } from '../devEthereumRuntimeSetup.ts';

type ForceUpdateGlobalIssuanceCouncilArgs = {
  archiveUrl?: string;
  executionRpcUrl?: string;
  vaultAddresses?: string[];
};

const currentFilePath = fileURLToPath(import.meta.url);
const isDirectExecution = !!process.argv[1] && path.resolve(process.argv[1]) === currentFilePath;

if (isDirectExecution) {
  void main().catch(error => {
    console.error(`[force-update-global-issuance-council] ${(error as Error).message}`);
    process.exit(1);
  });
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      archive: { type: 'string' },
      rpc: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: false,
  });

  if (values.help) {
    printUsage();
    return;
  }

  const result = await forceUpdateGlobalIssuanceCouncil({
    archiveUrl: values.archive,
    executionRpcUrl: values.rpc,
  });

  console.info(`[force-update-global-issuance-council] Vaults: ${result.vaultAddresses.join(', ')}`);
  console.info(`[force-update-global-issuance-council] Archive: ${result.archiveUrl}`);
  console.info(`[force-update-global-issuance-council] Ethereum RPC: ${result.executionRpcUrl}`);
  console.info(`[force-update-global-issuance-council] Argon approvals nonce: ${result.afterNonce}`);
  console.info(`[force-update-global-issuance-council] Argon force-set tx: ${result.argonTxHash}`);
  if (result.gatewayTxHash) {
    console.info(`[force-update-global-issuance-council] Ethereum gateway sync tx: ${result.gatewayTxHash}`);
  } else {
    console.info('[force-update-global-issuance-council] Ethereum gateway already matched the Argon council.');
  }
}

export async function forceUpdateGlobalIssuanceCouncil(args: ForceUpdateGlobalIssuanceCouncilArgs) {
  const archiveUrl = resolveArchiveUrl(args.archiveUrl);
  const executionRpcUrl = await resolveDevEthereumRpcUrl({
    rpcUrl: args.executionRpcUrl,
    logPrefix: 'force-update-global-issuance-council',
  });
  const client = await getClient(archiveUrl);

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

    const chainConfigOption = await finalizedClient.query.crosschainTransfer.chainConfigBySourceChain('Ethereum');
    if (chainConfigOption.isNone || !chainConfigOption.unwrap().isEvm) {
      throw new Error('Ethereum transfer gateway is not configured on this network.');
    }

    const afterNonce = await finalizedClient.query.crosschainTransfer
      .gatewayStateBySourceChain('Ethereum')
      .then(x => (x.isSome ? x.unwrap().argonApprovalsNonce.toBigInt() : 0n));
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

    const sudoResultEvent = txResult.events.find(event => client.events.sudo.Sudid.is(event));
    if (!sudoResultEvent || !client.events.sudo.Sudid.is(sudoResultEvent)) {
      throw new Error('Force-set Ethereum council transaction did not emit sudo.Sudid.');
    }
    if (sudoResultEvent.data.sudoResult.isErr) {
      throw new Error(
        `Force-set Ethereum council failed: ${dispatchErrorToString(client, sudoResultEvent.data.sudoResult.asErr as any)}`,
      );
    }

    await txResult.waitForFinalizedBlock;
    const publicClient = createPublicClient({
      transport: http(executionRpcUrl, { retryCount: 1, timeout: 15_000 }),
    });
    const gatewayAddress = getAddress(chainConfigOption.unwrap().asEvm.gateway.toHex());
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

function printUsage(): void {
  console.info(`Usage:
  yarn dev:ethereum:force-update-global-issuance-council
  yarn dev:ethereum:force-update-global-issuance-council --archive ws://127.0.0.1:9944
  yarn dev:ethereum:force-update-global-issuance-council --rpc http://127.0.0.1:32003

Direct:
  yarn exec tsx e2e/scripts/forceUpdateGlobalIssuanceCouncil.ts

Notes:
  - Dev-docker only. Uses //Alice sudo on Argon and the built-in local Ethereum admin account.
  - Reads the currently registered effective Ethereum council signers from runtime state and force-sets that list as the council.
  - Defaults to ws://127.0.0.1:9944 when --archive, ARGON_ARCHIVE_URL, and ARGON_NETWORK_CONFIG_OVERRIDE are all omitted.
  - Uses ETH_RPC or ETHEREUM_EXECUTION_RPC_URL when --rpc is omitted, otherwise probes local dev Ethereum RPC ports.
`);
}

export async function collectVaultOperatorsByEffectiveCouncilSigner(finalizedClient: IArgonQueryable) {
  const activeEntries =
    await finalizedClient.query.crosschainTransfer.councilSignerByDestinationChainAndAccountId.entries('Ethereum');
  const pendingEntries =
    await finalizedClient.query.crosschainTransfer.pendingCouncilSignerByDestinationChainAndAccountId.entries(
      'Ethereum',
    );
  const activeByAccountId = new Map<string, string>();
  const pendingByAccountId = new Map<string, string>();

  for (const [key, signer] of activeEntries) {
    if (!signer.isSome) continue;
    activeByAccountId.set(getStorageEntryAccountId(key), signer.unwrap().toString());
  }

  for (const [key, signer] of pendingEntries) {
    if (!signer.isSome) continue;
    pendingByAccountId.set(getStorageEntryAccountId(key), signer.unwrap().toString());
  }

  const accountsByEffectiveSigner = new Map<string, { accountId: string; signer: string }>();
  for (const accountId of new Set([...activeByAccountId.keys(), ...pendingByAccountId.keys()])) {
    const effectiveSigner = pendingByAccountId.get(accountId) ?? activeByAccountId.get(accountId);
    if (!effectiveSigner) continue;

    const vaultId = await finalizedClient.query.vaults.vaultIdByOperator(accountId);
    if (vaultId.isNone) continue;

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

function getStorageEntryAccountId(key: { args: Array<{ toString(): string }> }) {
  const accountId = key.args.at(-1)?.toString();
  if (!accountId) {
    throw new Error('Unable to read council signer registration account id from storage entry key');
  }

  return accountId;
}
