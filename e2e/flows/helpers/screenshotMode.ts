import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import Path from 'node:path';
import process from 'node:process';
import type { IE2EFlowRuntime } from '../types.ts';

export type E2EScreenshotMode = 'off' | 'on';
export type E2EScreenshotScope = 'operation' | 'interaction' | 'phase';
export type E2EScreenshotPhase = 'start' | 'end' | 'failure' | 'change';

export interface IE2EScreenshotCaptureInput {
  scope: E2EScreenshotScope;
  phase: E2EScreenshotPhase;
  flowName: string;
  name: string;
  timeoutMs?: number;
}

const DEFAULT_SCREENSHOT_DIR = Path.join(os.tmpdir(), 'e2e-screenshots');
const DEFAULT_SCREENSHOT_TIMEOUT_MS = 60_000;

let screenshotRunDir: string | null = null;
const screenshotSequenceByFlow: Record<string, number> = {};
let loggedScreenshotDirectory = false;

export function resolveE2EScreenshotMode(value: string | undefined): E2EScreenshotMode {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || ['0', 'false', 'off', 'none'].includes(normalized)) {
    return 'off';
  }
  return 'on';
}

export function getE2EScreenshotMode(): E2EScreenshotMode {
  return resolveE2EScreenshotMode(process.env.E2E_SCREENSHOT_MODE);
}

export function shouldCaptureE2EScreenshot(
  scope: E2EScreenshotScope,
  phase: E2EScreenshotPhase,
  mode: E2EScreenshotMode = getE2EScreenshotMode(),
): boolean {
  if (mode === 'off') {
    return false;
  }
  if (scope === 'interaction') {
    return phase === 'start' || phase === 'failure';
  }
  return true;
}

export async function captureE2EScreenshot(
  runtime: IE2EFlowRuntime,
  input: IE2EScreenshotCaptureInput,
): Promise<string | null> {
  const mode = getE2EScreenshotMode();
  if (!shouldCaptureE2EScreenshot(input.scope, input.phase, mode)) {
    return null;
  }

  const outputPath = getNextScreenshotPath(input);
  if (!loggedScreenshotDirectory) {
    console.info(`[E2E] Screenshot mode '${mode}' writing to ${Path.dirname(Path.dirname(outputPath))}`);
    loggedScreenshotDirectory = true;
  }

  try {
    return await runtime.captureScreenshot({
      outputPath,
      name: `${input.flowName}-${input.scope}-${input.name}-${input.phase}`,
      timeoutMs: input.timeoutMs ?? DEFAULT_SCREENSHOT_TIMEOUT_MS,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[E2E] Screenshot capture failed (${input.scope}:${input.phase} ${input.name}): ${message}`);
    return null;
  }
}

function getNextScreenshotPath(input: IE2EScreenshotCaptureInput): string {
  const flowLabel = sanitizePathToken(input.flowName);
  const flowSequence = (screenshotSequenceByFlow[flowLabel] ?? 0) + 1;
  screenshotSequenceByFlow[flowLabel] = flowSequence;
  const sequence = flowSequence.toString().padStart(4, '0');
  const scopeLabel = sanitizePathToken(input.scope);
  const nameLabel = sanitizePathToken(input.name);
  const phaseLabel = sanitizePathToken(input.phase);
  const fileName = `${sequence}-${scopeLabel}-${nameLabel}-${phaseLabel}.png`;

  const flowDir = Path.join(getScreenshotRunDir(), flowLabel);
  mkdirSync(flowDir, { recursive: true });
  return Path.join(flowDir, fileName);
}

function getScreenshotRunDir(): string {
  if (screenshotRunDir) {
    return screenshotRunDir;
  }
  const configuredDir = process.env.E2E_SCREENSHOT_DIR?.trim() || DEFAULT_SCREENSHOT_DIR;
  const baseDir = Path.resolve(configuredDir);
  const configuredSession = process.env.E2E_SCREENSHOT_SESSION?.trim();
  const sessionLabel = configuredSession
    ? sanitizePathToken(configuredSession)
    : `session-pid${process.pid}-${randomUUID().slice(0, 8)}`;
  screenshotRunDir = Path.join(baseDir, sessionLabel);
  mkdirSync(screenshotRunDir, { recursive: true });
  return screenshotRunDir;
}

function sanitizePathToken(value: string): string {
  const normalized = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!normalized) {
    return 'unknown';
  }
  return normalized.slice(0, 96);
}
