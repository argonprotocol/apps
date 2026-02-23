#!/usr/bin/env tsx

import { execFileSync } from 'node:child_process';
import Path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { resolveTestSessionCommandEnv } from '@argonprotocol/apps-core/__test__/startArgonTestNetwork.ts';
import { getFlow, listFlows } from './flows/index.ts';
import { createFlowSession, resolveFlowSessionMode, type IFlowSession } from './flows/session.ts';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = Path.resolve(__dirname, '..');
const DISCOVERED_FLOW_NAMES = listFlows().map(flow => flow.name);
const DEFAULT_FLOWS = DISCOVERED_FLOW_NAMES.filter(name => name !== 'App.flow.runManual');
const DEFAULT_APP_PORT = 1420;
let shutdownRequested = false;
let shutdownExitCode = 130;

function parseNonEmptyCsv(value: string | undefined, fallback: string[]): string[] {
  if (!value) return fallback;
  const entries = value
    .split(',')
    .map(part => part.trim())
    .filter(Boolean);
  return entries.length > 0 ? entries : fallback;
}

const ALL_FLOW_NAMES = DISCOVERED_FLOW_NAMES.join(', ');

async function main(): Promise<void> {
  const flowNames = parseNonEmptyCsv(process.env.E2E_FLOWS, DEFAULT_FLOWS);
  const sessionMode = resolveFlowSessionMode(process.env.E2E_SESSION_MODE);
  const useTestNetwork = (process.env.E2E_USE_TEST_NETWORK ?? (sessionMode === 'stateful' ? '0' : '1')).trim() === '1';
  if (sessionMode === 'stateful' && useTestNetwork) {
    throw new Error('[E2E] E2E_SESSION_MODE=stateful requires E2E_USE_TEST_NETWORK=0.');
  }
  const flowDefaultSessionName = useTestNetwork
    ? flowNames.length === 1
      ? flowNames[0]
      : `flows-${flowNames.join('-')}`
    : undefined;
  const { sessionName, composeProjectName, appEnv } = resolveTestSessionCommandEnv({
    appPort: DEFAULT_APP_PORT,
    fallbackSessionName: flowDefaultSessionName,
  });

  let session: IFlowSession | null = null;
  let isClosing = false;

  const closeSession = async (): Promise<void> => {
    if (isClosing) return;
    isClosing = true;
    try {
      await session?.close();
    } catch (error) {
      console.error('[E2E] Failed to close flow session cleanly', error);
    }
  };

  const cleanupTestNetworkArtifacts = (): void => {
    if (!useTestNetwork || sessionMode === 'stateful') return;
    const cleanupEnv: NodeJS.ProcessEnv = { ...appEnv };
    try {
      execFileSync('yarn', ['clean:dev:docker'], {
        cwd: REPO_ROOT,
        env: cleanupEnv,
        shell: true,
        stdio: 'inherit',
      });
    } catch (error) {
      console.error(`[E2E] Failed to clean test network project "${composeProjectName}" on shutdown`, error);
    }
  };

  const onSignal = (signal: NodeJS.Signals, exitCode: number): void => {
    shutdownRequested = true;
    shutdownExitCode = exitCode;
    console.warn(`[E2E] Received ${signal}. Shutting down flow session...`);
    void closeSession().finally(() => {
      if (!session) {
        cleanupTestNetworkArtifacts();
      }
      process.exit(exitCode);
    });
  };

  const sigintHandler = (): void => onSignal('SIGINT', 130);
  const sigtermHandler = (): void => onSignal('SIGTERM', 143);

  process.once('SIGINT', sigintHandler);
  process.once('SIGTERM', sigtermHandler);

  for (const name of flowNames) {
    if (!getFlow(name)) {
      throw new Error(`Unknown flow '${name}'. Available flows: ${ALL_FLOW_NAMES}`);
    }
  }

  session = await createFlowSession({ useTestNetwork, sessionName, sessionMode });

  try {
    for (const name of flowNames) {
      if (shutdownRequested) break;
      const startedAt = Date.now();
      console.log(`[E2E] Running flow '${name}'`);
      try {
        await session.run(name);
      } catch (error) {
        if (shutdownRequested && isDriverDisconnectError(error)) {
          console.warn(`[E2E] Flow '${name}' interrupted during shutdown.`);
          break;
        }
        if (isDriverDisconnectError(error)) {
          throw new Error(
            `[E2E] Driver disconnected while running flow '${name}'. App or backend likely stopped unexpectedly.`,
          );
        }
        throw error;
      }
      const elapsedMs = Date.now() - startedAt;
      console.log(`[E2E] Flow '${name}' passed in ${(elapsedMs / 1000).toFixed(1)}s`);
    }
  } finally {
    process.off('SIGINT', sigintHandler);
    process.off('SIGTERM', sigtermHandler);
    await closeSession();
  }
}

void main().catch(error => {
  if (shutdownRequested && isDriverDisconnectError(error)) {
    console.warn('[E2E] Driver disconnected during shutdown; exiting cleanly.');
    process.exit(shutdownExitCode);
  }
  console.error(error);
  process.exit(1);
});

function isDriverDisconnectError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes('driver not connected') ||
    message.includes('driver client closed') ||
    message.includes('driver socket closed') ||
    message.includes('app is not connected to the driver')
  );
}
