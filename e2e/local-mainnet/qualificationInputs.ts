import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, createReadStream, existsSync, readFileSync } from 'node:fs';
import Path from 'node:path';
import { parseArgs } from 'node:util';
import { getClient } from '@argonprotocol/mainchain';
import * as semver from 'semver';
import { loadLocalMainnetManifest } from './manifest.ts';

const { values } = parseArgs({
  options: {
    output: { type: 'string' },
    block: { type: 'string' },
    'verify-baseline': { type: 'string' },
    'seed-date': { type: 'boolean' },
    help: { type: 'boolean' },
  },
  strict: true,
});
if (values.help) {
  console.log('Usage: yarn local-mainnet:qualification-inputs --output <new-directory>');
  console.log('       yarn local-mainnet:qualification-inputs --seed-date --block <finalized-hash>');
  console.log('       yarn local-mainnet:qualification-inputs --verify-baseline <manifest.json>');
  process.exit(0);
}

if (values['verify-baseline']) {
  const manifest = loadLocalMainnetManifest(values['verify-baseline']);
  for (const [path, sha256] of [
    [manifest.archive.chopsticksDatabasePath, manifest.archive.sha256],
    [manifest.indexer.databasePath, manifest.indexer.sha256],
  ]) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    if (hash.digest('hex') !== sha256) {
      throw new Error(`Baseline database checksum mismatch: ${path}`);
    }
  }
  console.log(`Verified baseline at ${manifest.archive.blockNumber} (${manifest.archive.blockHash})`);
} else if (values['seed-date']) {
  if (!values.block) throw new Error('--seed-date requires --block <finalized-hash>');
  const client = await getClient('wss://rpc.argon.network');
  try {
    const atBlock = await client.at(values.block);
    const timestamp = (await atBlock.query.timestamp.now()).toNumber();
    console.log(new Date(timestamp - 24 * 60 * 60_000).toISOString().slice(0, 10).replaceAll('-', ''));
  } finally {
    await client.disconnect();
  }
} else {
  if (!values.output) throw new Error('Usage: yarn local-mainnet:qualification-inputs --output <new-directory>');
  const runDirectory = Path.resolve(values.output);
  const previousAppsDirectory = `${runDirectory}-previous-apps`;
  const mainchainDirectory = `${runDirectory}-mainchain`;
  const seedPath = `${runDirectory}-indexer.db.gz`;
  for (const path of [runDirectory, previousAppsDirectory, mainchainDirectory, seedPath]) {
    if (existsSync(path)) throw new Error(`Qualification requires a fresh output path: ${path}`);
  }
  process.chdir(Path.resolve(import.meta.dirname, '../..'));

  const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
  const { version: releasedVersion } = JSON.parse(readFileSync('release-channels/desktop-stable.json', 'utf8')) as {
    version: string;
  };
  if (!/^\d+\.\d+\.\d+$/.test(releasedVersion) || semver.gt(releasedVersion, version.split('-')[0])) {
    throw new Error(`Published Apps release ${releasedVersion} is newer than candidate ${version}`);
  }
  const previousAppsRef = `v${releasedVersion}`;
  const previousAppsHead = execFileSync('git', ['rev-parse', `refs/tags/${previousAppsRef}^{commit}`], {
    encoding: 'utf8',
  }).trim();
  const mainchainRef = readFileSync('server/.env.mainnet', 'utf8').match(/^ARGON_VERSION=(v[^\s]+)$/m)?.[1];
  if (!mainchainRef) throw new Error('server/.env.mainnet has no pinned Mainchain tag');
  const client = await getClient('wss://rpc.argon.network');
  let blockHash: string;
  let deployedSpecVersion: number;
  try {
    blockHash = values.block ?? (await client.rpc.chain.getFinalizedHead()).toHex();
    deployedSpecVersion = (await client.rpc.state.getRuntimeVersion(blockHash)).specVersion.toNumber();
  } finally {
    await client.disconnect();
  }

  const environment =
    [
      `QUALIFICATION_DIRECTORY=${runDirectory}`,
      `BASELINE_DIRECTORY=${Path.join(runDirectory, 'baseline')}`,
      `PREVIOUS_APPS_DIRECTORY=${previousAppsDirectory}`,
      `PREVIOUS_APPS_REF=${previousAppsRef}`,
      `EXPECTED_PREVIOUS_APPS_HEAD=${previousAppsHead}`,
      `MAINCHAIN_DIRECTORY=${mainchainDirectory}`,
      `MAINCHAIN_REF=${mainchainRef}`,
      `QUALIFICATION_BLOCK_HASH=${blockHash}`,
      `INDEXER_SEED_PATH=${seedPath}`,
      `CI_TEMP_DIR=${runDirectory}`,
    ].join('\n') + '\n';
  if (process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, environment);
  else console.log(environment);
  const summary = `Apps baseline: ${previousAppsRef}\nMainchain pin: ${mainchainRef}\nBaseline runtime: ${deployedSpecVersion} at ${blockHash}\n`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
}
