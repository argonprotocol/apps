#!/usr/bin/env tsx

import { execFileSync } from 'node:child_process';
import Path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { toComposeProjectName } from '@argonprotocol/apps-core/__test__/startArgonTestNetwork.js';
import { getFlow } from './flows/index.js';
import { createFlowSession, getDefaultFlowInput, type FlowSession } from './flows/session.js';

const DEFAULT_FLOWS = ['miningOnboarding', 'vaultingOnboarding'];
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = Path.resolve(__dirname, '..');
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

async function main(): Promise<void> {
  const flowNames = parseNonEmptyCsv(process.env.E2E_FLOWS, DEFAULT_FLOWS);
  const useTestNetwork = (process.env.E2E_USE_TEST_NETWORK ?? '1').trim() === '1';
  const explicitSessionName = process.env.E2E_SESSION_NAME?.trim();
  const sessionName =
    explicitSessionName ||
    (useTestNetwork ? (flowNames.length === 1 ? flowNames[0] : `flows-${flowNames.join('-')}`) : undefined);

  let session: FlowSession | null = null;
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
    if (!useTestNetwork || !sessionName) return;
    const composeProjectName = toComposeProjectName(sessionName);
    const cleanupEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ARGON_NETWORK_NAME: 'dev-docker',
      ARGON_APP_INSTANCE: sessionName,
      COMPOSE_PROJECT_NAME: composeProjectName,
    };
    try {
      execFileSync('yarn', ['clean:dev:docker'], {
        cwd: REPO_ROOT,
        env: cleanupEnv,
        stdio: 'inherit',
      });
    } catch (error) {
      console.error(
        `[E2E] Failed to clean test network project "${composeProjectName}" on shutdown`,
        error,
      );
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
      throw new Error(`Unknown flow '${name}'. Available flows: ${DEFAULT_FLOWS.join(', ')}`);
    }
  }

  session = await createFlowSession({ useTestNetwork, sessionName });

  try {
    for (const name of flowNames) {
      if (shutdownRequested) break;
      const input = getDefaultFlowInput(name);
      const startedAt = Date.now();
      console.log(`[E2E] Running flow '${name}'`);
      try {
        await session.run(name, input);
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
