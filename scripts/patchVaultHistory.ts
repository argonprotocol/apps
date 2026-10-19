import { readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  type IAllVaultStats,
  JsonExt,
  MainchainClients,
  MiningFrames,
  NetworkConfig,
  Vaults,
} from '@argonprotocol/apps-core';

import { readVaultNetworkPool } from '../src-vue/lib/recovery/MyVault.ts';

/** One-time enrichment of an existing history file. Never imported by the app. */
export async function patchVaultHistory(stats: IAllVaultStats, miningFrames: MiningFrames): Promise<void> {
  const frameIds = new Set<number>();
  for (const vault of Object.values(stats.vaultsById)) {
    for (const frame of vault.changesByFrame) {
      if (frame.frameId <= stats.synchedToFrame) frameIds.add(frame.frameId);
    }
  }

  for (const payout of stats.argonBondsByFrame ?? []) {
    if (payout.frameId <= stats.synchedToFrame) frameIds.add(payout.frameId);
  }

  for (const frameId of [...frameIds].sort((a, b) => a - b)) {
    const { frame: nextFrame, api } = await miningFrames.getFrameStart(frameId + 1);
    const missing = Object.entries(stats.vaultsById).flatMap(([vaultId, vault]) => {
      const frame = vault.changesByFrame.find(change => change.frameId === frameId);
      if (!frame) return [];
      if (frame.argonotSecuritizationMicronots !== undefined && frame.upstreamParticipation !== undefined) return [];
      return [{ vaultId: Number(vaultId), frame }];
    });
    const flexibleFrames = Object.entries(stats.vaultsById).flatMap(([vaultId, vault]) => {
      const frame = vault.changesByFrame.find(change => change.frameId === frameId);
      if (!frame?.treasuryPool.vaultCapital) return [];
      return [{ vaultId: Number(vaultId), frame }];
    });
    const bondPayout = stats.argonBondsByFrame?.find(payout => payout.frameId === frameId);
    const needsBondCapital = bondPayout !== undefined && bondPayout.participatingBonds === undefined;
    const needsHoldings =
      missing.some(({ frame }) => frame.argonotSecuritizationMicronots === undefined) &&
      'argonotSecuritizationByVaultId' in api.query.vaults;
    const needsParticipation = missing.some(({ frame }) => frame.upstreamParticipation === undefined);
    const needsPool = !stats.networkPoolsByFrame?.[frameId];
    if (!needsHoldings && !needsParticipation && !needsPool && !flexibleFrames.length && !needsBondCapital) continue;

    // The payout block resets capital; its parent retains the completed frame's holdings and auction pool.
    const parent = await miningFrames.blockWatch.getHeader(nextFrame.firstBlockNumber! - 1);
    const parentApi = await miningFrames.blockWatch.getApi(parent);
    if (flexibleFrames.length || needsBondCapital || needsParticipation) {
      const capital = await parentApi.query.treasury.currentFrameVaultCapital();
      if (capital?.frameId === frameId && 'vaultSecuritizationPositions' in capital) {
        for (const { vaultId } of missing) {
          const participation = capital.vaultSecuritizationPositions?.[vaultId]?.upstreamParticipation;
          if (participation === undefined) continue;
          const vault = stats.vaultsById[vaultId];
          stats.vaultsById[vaultId] = {
            ...vault,
            changesByFrame: vault.changesByFrame.map(change => {
              if (change.frameId !== frameId || change.upstreamParticipation !== undefined) return change;
              return { ...change, upstreamParticipation: participation };
            }),
          };
        }
      }
      if (needsBondCapital && capital?.frameId === frameId && 'totalActiveBonds' in capital) {
        stats.argonBondsByFrame = stats.argonBondsByFrame!.map(payout => {
          if (payout.frameId !== frameId) return payout;
          return { ...payout, participatingBonds: capital.totalActiveBonds };
        });
      }
    }
    if (flexibleFrames.length) {
      const { api: participationApi } = await miningFrames.getFrameStart(frameId);
      await Vaults.loadFlexibleBondEarnings(stats, frameId, participationApi);
    }
    if (needsPool) {
      const pool = await readVaultNetworkPool({ frameId, api, parentApi });
      stats.networkPoolsByFrame = { ...stats.networkPoolsByFrame, [frameId]: pool };
    }

    if (needsHoldings) {
      const commitments = await parentApi.query.vaults.argonotSecuritizationByVaultId.entries();
      if (commitments) {
        const heldByVault = new Map(commitments.map(([key, value]) => [key.args[0], value?.heldMicronots ?? 0n]));
        for (const { vaultId } of missing) {
          const vault = stats.vaultsById[vaultId];
          stats.vaultsById[vaultId] = {
            ...vault,
            changesByFrame: vault.changesByFrame.map(change => {
              if (change.frameId !== frameId) return change;
              return {
                ...change,
                argonotSecuritizationMicronots: change.argonotSecuritizationMicronots ?? heldByVault.get(vaultId) ?? 0n,
              };
            }),
          };
        }
      }
    }
    console.log(`Patched vault history for frame ${frameId}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({
    options: {
      network: { type: 'string' },
      input: { type: 'string' },
      output: { type: 'string' },
      'archive-url': { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(
      'Usage: yarn tsx scripts/patchVaultHistory.ts --network <mainnet|testnet|dev-docker> --input <history.json> [--output <patched.json>] [--archive-url <wss://...>]',
    );
  } else {
    if (!values.network || !values.input) throw new Error('--network and --input are required. Use --help for usage.');
    NetworkConfig.setNetwork(values.network as Parameters<typeof NetworkConfig.setNetwork>[0]);
    const inputPath = resolve(values.input);
    const outputPath = resolve(values.output ?? `${values.input}.patched.json`);
    const stats = JsonExt.parse<IAllVaultStats>(await readFile(inputPath, 'utf8'));
    const clients = new MainchainClients(values['archive-url'] ?? NetworkConfig.get().archiveUrl, () => false);
    const miningFrames = new MiningFrames(clients);
    try {
      await miningFrames.load();
      await patchVaultHistory(stats, miningFrames);
      await writeFile(`${outputPath}.tmp`, JsonExt.stringify(stats, 2, { sortKeys: true }) + '\n');
      await rename(`${outputPath}.tmp`, outputPath);
      console.log(`Saved patched vault history to ${outputPath}`);
    } finally {
      await miningFrames.stop();
      await clients.disconnect();
    }
  }
}
