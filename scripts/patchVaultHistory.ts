import { readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import BigNumber from 'bignumber.js';
import {
  bigIntMax,
  bigNumberToBigInt,
  type IAllVaultStats,
  JsonExt,
  MainchainClients,
  MiningFrames,
  NetworkConfig,
  TreasuryBonds,
} from '@argonprotocol/apps-core';

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
      if (!frame || frame.argonotSecuritizationMicronots !== undefined) return [];
      return [{ vaultId: Number(vaultId), frame }];
    });
    const flexibleFrames = Object.entries(stats.vaultsById).flatMap(([vaultId, vault]) => {
      const frame = vault.changesByFrame.find(change => change.frameId === frameId);
      if (!frame?.treasuryPool.vaultCapital || frame.treasuryPool.flexibleBondEarnings !== undefined) return [];
      return [{ vaultId: Number(vaultId), frame }];
    });
    const bondPayout = stats.argonBondsByFrame?.find(payout => payout.frameId === frameId);
    const needsBondCapital = bondPayout !== undefined && bondPayout.participatingBonds === undefined;
    const needsHoldings = missing.length > 0 && 'argonotSecuritizationByVaultId' in api.query.vaults;
    const needsPool = !stats.networkPoolsByFrame?.[frameId];
    if (!needsHoldings && !needsPool && !flexibleFrames.length && !needsBondCapital) continue;

    // The payout block resets capital; its parent retains the completed frame's holdings and auction pool.
    const parent = await miningFrames.blockWatch.getHeader(nextFrame.firstBlockNumber! - 1);
    const parentApi = await miningFrames.blockWatch.getApi(parent);
    if (flexibleFrames.length || needsBondCapital) {
      const capital = await parentApi.query.treasury.currentFrameVaultCapital();
      if (needsBondCapital && capital?.frameId === frameId && 'totalActiveBonds' in capital) {
        stats.argonBondsByFrame = stats.argonBondsByFrame!.map(payout => {
          if (payout.frameId !== frameId) return payout;
          return { ...payout, participatingBonds: capital.totalActiveBonds };
        });
      }
      if (capital?.frameId === frameId && 'vaults' in capital) {
        for (const { vaultId, frame } of flexibleFrames) {
          const position = capital.vaults?.[vaultId];
          if (!position || !('flexibleProrata' in position)) continue;
          const flexibleBondEarnings = bigNumberToBigInt(
            position.flexibleProrata.times(frame.treasuryPool.totalEarnings),
          );
          const vault = stats.vaultsById[vaultId];
          stats.vaultsById[vaultId] = {
            ...vault,
            changesByFrame: vault.changesByFrame.map(change =>
              change === frame ? { ...frame, treasuryPool: { ...frame.treasuryPool, flexibleBondEarnings } } : change,
            ),
          };
        }
      }
    }
    if (needsPool) {
      const pool = await parentApi.query.system.account(TreasuryBonds.getBidPoolAccountId(api));
      const auctionPoolMicrogons = pool.data.free;
      const constants = api.consts.treasury;
      let includesBondPayments = true;
      let vaultPoolMicrogons: bigint | undefined;
      if ('percentForVaultPool' in constants) {
        includesBondPayments = false;
        vaultPoolMicrogons = bigNumberToBigInt(BigNumber(auctionPoolMicrogons).times(constants.percentForVaultPool));
      } else if ('percentForTreasuryReserves' in constants) {
        const reserves = bigNumberToBigInt(
          BigNumber(auctionPoolMicrogons).times(constants.percentForTreasuryReserves),
          true,
        );
        vaultPoolMicrogons = auctionPoolMicrogons - reserves;
        const participants = await parentApi.query.treasury.currentFrameArgonotBondParticipants();
        if (participants?.frameId === frameId && participants.totalBonds > 0) {
          const stakePool = bigNumberToBigInt(
            BigNumber(auctionPoolMicrogons).times(constants.percentForArgonotBondPool),
          );
          vaultPoolMicrogons = bigIntMax(0n, vaultPoolMicrogons - stakePool);
        }

        const events = await api.query.system.events();
        const reserveTransferFailed = events.some(
          ({ event }) =>
            event.section === 'treasury' &&
            (event.method === 'CouldNotTransferToTreasuryReserves' || event.method === 'CouldNotFundTreasury') &&
            event.data.frameId === frameId,
        );
        // Earlier runtimes changed the available pool after a reserve-transfer failure.
        if (reserveTransferFailed) vaultPoolMicrogons = undefined;
      }
      stats.networkPoolsByFrame = {
        ...stats.networkPoolsByFrame,
        [frameId]: { auctionPoolMicrogons, vaultPoolMicrogons, includesBondPayments },
      };
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
              return { ...change, argonotSecuritizationMicronots: heldByVault.get(vaultId) ?? 0n };
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
