import os from 'node:os';
import path, * as Path from 'node:path';
import { ChildProcess, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Fs from 'node:fs/promises';
import docker from 'docker-compose';
import { Options } from '@wdio/types';
import { getClient } from '@argonprotocol/mainchain';
import { ARGON_DOCKER_COMPOSE } from './argon';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

// keep track of the `tauri-driver` child process
let tauriDriver: ChildProcess | undefined;
let exit = false;

const ARGON_APP_ROOT = path.resolve(__dirname, process.env.ARGON_APP_ROOT ?? '..');
const DOCKER_LOG = Boolean(JSON.parse(process.env.DOCKER_LOG ?? 'true'));
let ARGON_RPC_URL = 'ws://localhost:9944';
const ARGON_CHAIN = 'dev-docker';
const ARGON_APP_INSTANCE = `e2e`;
const DOCKER_ENV = {
  VERSION: 'dev',
  ARGON_CHAIN,
  RPC_PORT: '9944',
  BITCOIN_BLOCK_SECS: '20',
  COMPOSE_PROJECT_NAME: `${ARGON_CHAIN}-${ARGON_APP_INSTANCE}`,
};
const CONFIG_DIR = Path.join(os.homedir(), '.config', 'com.argon.apps', ARGON_CHAIN, ARGON_APP_INSTANCE);

export function getArchiveUrl() {
  return ARGON_RPC_URL;
}

export const config: Options.Testrunner & { capabilities: any } = {
  hostname: '127.0.0.1',
  port: 4444,
  path: '/',
  specs: ['./tests/**/*.spec.ts'],
  maxInstances: 1,
  runner: 'local',
  capabilities: [
    {
      maxInstances: 1,
      'tauri:options': {
        application: `${ARGON_APP_ROOT}/src-tauri/target/debug/Investor Console`,
      },
    },
  ],
  reporters: ['spec'],
  framework: 'mocha',
  mochaOpts: {
    ui: 'bdd',
    timeout: 60000,
  },

  // ensure the rust project is built since we expect this binary to exist for the webdriver sessions
  async onPrepare() {
    try {
      await import('./argon/download.js');
      await Fs.rm(CONFIG_DIR, {
        recursive: true,
        force: true,
      }).catch(() => null);

      await docker.upAll({
        log: DOCKER_LOG,
        commandOptions: [`--force-recreate`, '--pull=always', '--wait'],
        config: ARGON_DOCKER_COMPOSE,
        env: DOCKER_ENV,
      });
      console.log('Argon started. Waiting for chain to start. Archive RPC URL:', ARGON_RPC_URL);
      const client = await getClient(ARGON_RPC_URL);
      while ((await client.rpc.chain.getHeader().then(x => x.number.toNumber())) === 0) {
        await new Promise(res => setTimeout(res, 100));
      }
      await client.disconnect();
    } catch (error) {
      console.error('Error setting up docker containers:', error);
      await cleanupBeforeExit();
      process.exit(1);
    }
    console.log('Building Tauri app...', ARGON_APP_ROOT, os.homedir());
    const buildResult = spawnSync('yarn', ['tauri', 'build', '--debug', '--no-bundle'], {
      cwd: ARGON_APP_ROOT,
      stdio: 'inherit',
      env: {
        PATH: `${os.homedir()}/.yarn/bin:${os.homedir()}/.cargo/bin:${process.env.PATH}:/usr/local/bin`,
        CI: 'true',
        ARCHIVE_URL: ARGON_RPC_URL,
        ARGON_NETWORK_NAME: ARGON_CHAIN,
      },
      shell: true,
    });
    if (buildResult.status !== 0) {
      console.error('Failed to build Tauri app');
      process.exit(1);
    }
  },

  // ensure we are running `tauri-driver` before the session starts so that we can proxy the webdriver requests
  async beforeSession() {
    tauriDriver = spawn(path.resolve(os.homedir(), '.cargo', 'bin', 'tauri-driver'), [], {
      stdio: [null, process.stdout, process.stderr],
      env: {
        ARGON_APP_INSTANCE,
        ARGON_NETWORK_NAME: ARGON_CHAIN,
        ...process.env,
      },
    });

    tauriDriver.on('error', error => {
      console.error('tauri-driver error:', error);
      process.exit(1);
    });
    tauriDriver.on('exit', code => {
      if (!exit) {
        console.error('tauri-driver exited with code:', code);
        process.exit(1);
      }
    });
  },

  // clean up the `tauri-driver` process we spawned at the start of the session
  // note that afterSession might not run if the session fails to start, so we also run the cleanup on shutdown
  async afterSession() {
    await cleanupBeforeExit();
  },
};

function closeTauriDriver() {
  exit = true;
  tauriDriver?.kill();
}

let cleanupPromise: Promise<void> | null = null;
async function cleanupBeforeExit() {
  cleanupPromise ??= innerCleanupBeforeExit();
  return cleanupPromise;
}
async function innerCleanupBeforeExit() {
  closeTauriDriver();
  console.log('Shutting down argon test network docker containers...');
  const serverDir = Path.join(CONFIG_DIR, 'virtual-machine', 'app', 'server');
  try {
    const result = spawnSync(
      Path.join(serverDir, 'scripts', 'create_troubleshooting_gz.sh'),
      [], // no args
      { stdio: 'inherit' },
    );
    if (result.status !== 0) {
      console.error('Failed to create troubleshooting archive');
    }
  } catch (e) {
    console.error('Failed to create troubleshooting archive', e);
  }

  await docker
    .downAll({
      log: DOCKER_LOG,
      commandOptions: [`--volumes`, '--timeout=0'],
      composeOptions: ['--profile=all'],
      config: serverDir,
      env: DOCKER_ENV,
    })
    .catch(() => null);
  await docker
    .downAll({
      log: DOCKER_LOG,
      commandOptions: [`--volumes`, '--timeout=0', '--remove-orphans'],
      config: ARGON_DOCKER_COMPOSE,
      env: DOCKER_ENV,
    })
    .catch(() => null);
}

function onShutdown(fn: () => Promise<void>) {
  const cleanup = () => {
    fn().finally(process.exit);
  };

  process.on('exit', cleanup);
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('SIGHUP', cleanup);
  process.on('SIGBREAK', cleanup);
}

// ensure tauri-driver is closed when our test process exits
onShutdown(cleanupBeforeExit);
