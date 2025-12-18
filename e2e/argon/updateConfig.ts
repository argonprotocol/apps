import { configDotenv } from 'dotenv';
import Path from 'node:path';
import { execSync } from 'node:child_process';
import { readFileSync } from 'fs';
import { writeFileSync } from 'node:fs';
import { type INetworkConfig } from '@argonprotocol/apps-core';

const __dirname = Path.dirname(new URL(import.meta.url).pathname);

const res = configDotenv({ path: Path.join(__dirname, '.env') });
const networkName = res.parsed.ARGON_CHAIN ?? 'dev-docker';
execSync('yarn build:config', {
  stdio: 'inherit',
  cwd: Path.join(__dirname, '../..'),
  env: { ...process.env, ARGON_NETWORK_NAME: networkName },
});

const esploraPort = execSync('docker compose port bitcoin-electrs 3002', {
  cwd: __dirname,
  encoding: 'utf-8',
})
  .trim()
  .split(':')
  .pop();

const indexerPort = execSync('docker compose port indexer 3262', {
  cwd: __dirname,
  encoding: 'utf-8',
})
  .trim()
  .split(':')
  .pop();

const configPath = Path.join(__dirname, '../../core/network.config.json');
const networkJson = readFileSync(configPath, 'utf-8');
const networkConfig = JSON.parse(networkJson) as INetworkConfig;
networkConfig[networkName].esploraHost = `http://localhost:${esploraPort}`;
networkConfig[networkName].indexerHost = `http://localhost:${indexerPort}`;
writeFileSync(configPath, JSON.stringify(networkConfig, null, 2) + '\n', 'utf-8');

if (networkName === 'dev-docker') {
  // this is because it needs to be on the same network right now to sync properly. we could fix this by
  // modifying the bitcoin-regtest.conf to use an `addnode` with a host-accessible docker port
  console.log('------------ NOTE!!! USING DEV-DOCKER CONFIG ------------');
  console.log('Bitcoin can only sync right now if you set:');
  console.log(' ARGON_APP_INSTANCE=e2e ARGON_NETWORK_NAME=dev-docker');
  console.log('---------------------------------------------------------');
}
