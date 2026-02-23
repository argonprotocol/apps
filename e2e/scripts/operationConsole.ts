#!/usr/bin/env tsx

import readline from 'node:readline/promises';
import process from 'node:process';
import type { E2EFlowAppLogsMode, E2ESessionMode, IFlowSession } from '../flows/session.ts';

type OperationContextName = 'app' | 'bitcoin' | 'mining' | 'vaulting';
type OperationMode = 'run' | 'inspect';

interface IInputDefinitionSummary {
  key: string;
  required: boolean;
  description?: string;
  operations: string[];
}

interface IConsoleState {
  context: OperationContextName;
  mode: OperationMode;
  timeoutMs?: number;
  inputs: Record<string, unknown>;
}

interface IRunStepInput {
  operationContext: OperationContextName;
  operationNames: string[];
  operationMode: OperationMode;
  timeoutMs?: number;
  operationInputs?: Record<string, unknown>;
  printInspectSummary?: boolean;
}

interface IFlowSessionRunner {
  run: IFlowSession['run'];
  close: IFlowSession['close'];
}

interface IRunStepResult {
  ok: boolean;
  data: Record<string, unknown>;
  error?: string;
}

const RESERVED_OPERATION_INPUT_KEYS = new Set([
  'operationContext',
  'context',
  'operations',
  'operationNames',
  'operation',
  'operationFlowName',
  'flowNameOverride',
  'operationTimeoutMs',
  'timeoutMs',
  'operationMode',
]);

process.env.E2E_DRIVER_TRACE ??= process.env.E2E_CONSOLE_DRIVER_TRACE?.trim() || '0';
const suppressPolkadotWarnings = (process.env.E2E_CONSOLE_SUPPRESS_POLKADOT_WARNINGS ?? '1').trim() !== '0';
if (suppressPolkadotWarnings) {
  const originalWarn = console.warn.bind(console);
  console.warn = (...args: unknown[]) => {
    const firstArg = args[0];
    const message = typeof firstArg === 'string' ? firstArg : '';
    if (message.includes('has multiple versions, ensure that there is only one installed.')) {
      return;
    }
    originalWarn(...args);
  };
}

async function main(): Promise<void> {
  const { createFlowSession, resolveFlowSessionMode, resolveFlowSessionAppLogsMode } = await import(
    '../flows/session.js'
  );
  const sessionMode = resolveFlowSessionMode(process.env.E2E_SESSION_MODE);
  const useTestNetwork = (process.env.E2E_USE_TEST_NETWORK ?? (sessionMode === 'stateful' ? '0' : '1')).trim() === '1';
  const appLogsMode = resolveFlowSessionAppLogsMode(process.env.E2E_CONSOLE_APP_LOGS ?? 'quiet');
  if (sessionMode === 'stateful' && useTestNetwork) {
    throw new Error('[E2E] E2E_SESSION_MODE=stateful requires E2E_USE_TEST_NETWORK=0.');
  }

  const state: IConsoleState = {
    context: parseContext(process.env.E2E_OPERATION_CONTEXT) ?? 'bitcoin',
    mode: parseMode(process.env.E2E_OPERATION_MODE) ?? 'run',
    timeoutMs: parseTimeout(process.env.E2E_OPERATION_TIMEOUT_MS),
    inputs: parseConsoleInputOverrides(process.env.E2E_OPERATION_INPUTS),
  };

  const session = await createFlowSession({ sessionMode, useTestNetwork, appLogsMode });
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  printHeader(sessionMode, useTestNetwork, appLogsMode);
  printStatus(state);
  printHelp();

  try {
    while (true) {
      const line = (await rl.question('ops> ')).trim();
      if (!line) continue;
      if (line === 'exit' || line === 'quit') {
        return;
      }
      if (line === 'help') {
        printHelp();
        continue;
      }
      if (line === 'status') {
        printStatus(state);
        continue;
      }
      if (line === 'inputs') {
        printInputs(state.inputs);
        continue;
      }
      if (line.startsWith('set ')) {
        const parsed = parseSetCommand(line);
        if (!parsed) {
          console.error('[E2E] usage: set <key> <value>');
          continue;
        }
        const keyError = validateInputKey(parsed.key);
        if (keyError) {
          console.error(`[E2E] ${keyError}`);
          continue;
        }
        state.inputs[parsed.key] = parseInputValue(parsed.rawValue);
        console.info(`[E2E] set input.${parsed.key}=${safeSerialize(state.inputs[parsed.key])}`);
        continue;
      }
      if (line.startsWith('unset ')) {
        const key = line.slice('unset '.length).trim();
        if (!key) {
          console.error('[E2E] usage: unset <key|*>');
          continue;
        }
        if (key === '*') {
          state.inputs = {};
          console.info('[E2E] cleared all inputs');
          continue;
        }
        if (!(key in state.inputs)) {
          console.warn(`[E2E] input.${key} is not set`);
          continue;
        }
        delete state.inputs[key];
        console.info(`[E2E] unset input.${key}`);
        continue;
      }
      if (line === 'runnable') {
        await runOperationsStep(session, {
          operationContext: state.context,
          operationNames: ['*'],
          operationMode: 'inspect',
          timeoutMs: state.timeoutMs,
          operationInputs: state.inputs,
        });
        continue;
      }
      if (line.startsWith('context ')) {
        const parsed = parseContext(line.slice('context '.length).trim());
        if (!parsed) {
          console.error('[E2E] context must be one of: app, bitcoin, mining, vaulting');
          continue;
        }
        state.context = parsed;
        printStatus(state);
        continue;
      }
      if (line.startsWith('mode ')) {
        const parsed = parseMode(line.slice('mode '.length).trim());
        if (!parsed) {
          console.error('[E2E] mode must be one of: run, inspect');
          continue;
        }
        state.mode = parsed;
        printStatus(state);
        continue;
      }
      if (line.startsWith('timeout ')) {
        const raw = line.slice('timeout '.length).trim();
        if (raw === 'off') {
          state.timeoutMs = undefined;
          printStatus(state);
          continue;
        }
        const parsed = parseTimeout(raw);
        if (parsed == null) {
          console.error('[E2E] timeout must be a positive integer in ms, or "off".');
          continue;
        }
        state.timeoutMs = parsed;
        printStatus(state);
        continue;
      }

      const explicitMode = line.startsWith('run ') ? 'run' : line.startsWith('inspect ') ? 'inspect' : undefined;
      const operationInput = explicitMode ? line.slice(explicitMode.length).trim() : line;
      const operations = parseOperationNames(operationInput);
      if (operations.length === 0) {
        console.error('[E2E] Provide operation names (comma-separated). Use "help" for examples.');
        continue;
      }

      const selectedMode = explicitMode ?? state.mode;
      if (selectedMode === 'run') {
        const preflight = await runOperationsStep(session, {
          operationContext: state.context,
          operationNames: operations,
          operationMode: 'inspect',
          timeoutMs: state.timeoutMs,
          operationInputs: state.inputs,
          printInspectSummary: false,
        });
        if (!preflight.ok) {
          continue;
        }

        const missingRequiredInputs = toStringArray(preflight.data.missingRequiredInputs);
        if (missingRequiredInputs.length > 0) {
          const hasInputs = await promptForMissingRequiredInputs(rl, state, missingRequiredInputs, preflight.data);
          if (!hasInputs) {
            continue;
          }
        }
      }

      await runOperationsStep(session, {
        operationContext: state.context,
        operationNames: operations,
        operationMode: selectedMode,
        timeoutMs: state.timeoutMs,
        operationInputs: state.inputs,
      });
    }
  } finally {
    rl.close();
    await session.close();
  }
}

async function runOperationsStep(session: IFlowSessionRunner, input: IRunStepInput): Promise<IRunStepResult> {
  const startedAt = Date.now();
  const operationsLabel = input.operationNames.join(', ');
  try {
    const result = await session.run('App.flow.runManual', {
      operationContext: input.operationContext,
      operations: input.operationNames,
      operationMode: input.operationMode,
      operationTimeoutMs: input.timeoutMs,
      ...(input.operationInputs ?? {}),
    });
    const elapsedMs = Date.now() - startedAt;
    console.info(`[E2E] step ok mode=${input.operationMode} operations=${operationsLabel} elapsedMs=${elapsedMs}`);
    if (input.operationMode === 'inspect' && input.printInspectSummary !== false) {
      printInspectSummary(result.data);
    }
    return {
      ok: true,
      data: result.data,
    };
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[E2E] step failed mode=${input.operationMode} operations=${operationsLabel} elapsedMs=${elapsedMs}`);
    console.error(`[E2E] ${message}`);
    return {
      ok: false,
      data: {},
      error: message,
    };
  }
}

async function promptForMissingRequiredInputs(
  rl: readline.Interface,
  state: IConsoleState,
  missingRequiredInputs: string[],
  inspectData: Record<string, unknown>,
): Promise<boolean> {
  const missingKeys = uniqueSorted(missingRequiredInputs);
  if (missingKeys.length === 0) {
    return true;
  }

  const definitionsByKey = new Map<string, IInputDefinitionSummary>();
  for (const definition of toInputDefinitions(inspectData.operationInputDefinitions)) {
    definitionsByKey.set(definition.key, definition);
  }

  for (const key of missingKeys) {
    const definition = definitionsByKey.get(key);
    const label = definition?.description ? `${key} (${definition.description})` : key;
    const answer = (await rl.question(`[E2E] required input ${label}: `)).trim();
    if (!answer) {
      console.error(`[E2E] Input '${key}' is required.`);
      return false;
    }
    state.inputs[key] = parseInputValue(answer);
    console.info(`[E2E] set input.${key}=${safeSerialize(state.inputs[key])}`);
  }

  return true;
}

function parseOperationNames(raw: string): string[] {
  const names = raw
    .split(',')
    .map(part => part.trim())
    .filter(Boolean);
  if (names.length === 1 && names[0].toLowerCase() === 'all') {
    return ['*'];
  }
  return names;
}

function parseContext(value: string | undefined): OperationContextName | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'app' || normalized === 'bitcoin' || normalized === 'mining' || normalized === 'vaulting') {
    return normalized;
  }
  return undefined;
}

function parseMode(value: string | undefined): OperationMode | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'run' || normalized === 'inspect') {
    return normalized;
  }
  return undefined;
}

function parseTimeout(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return undefined;
  return parsed;
}

function parseConsoleInputOverrides(value: string | undefined): Record<string, unknown> {
  if (!value) return {};

  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.warn('[E2E] E2E_OPERATION_INPUTS must be a JSON object; ignoring value.');
      return {};
    }

    const inputs: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(parsed as Record<string, unknown>)) {
      const keyError = validateInputKey(key);
      if (keyError) {
        console.warn(`[E2E] ignoring input key '${key}': ${keyError}`);
        continue;
      }
      inputs[key] = entry;
    }
    return inputs;
  } catch (error) {
    console.warn(
      `[E2E] could not parse E2E_OPERATION_INPUTS JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
    return {};
  }
}

function parseSetCommand(line: string): { key: string; rawValue: string } | null {
  const body = line.slice('set '.length).trim();
  if (!body) return null;
  const match = body.match(/^([A-Za-z_][A-Za-z0-9_]*)(?:\s*=\s*|\s+)(.+)$/);
  if (!match) return null;
  const key = match[1]?.trim();
  const rawValue = match[2]?.trim();
  if (!key || !rawValue) return null;
  return { key, rawValue };
}

function parseInputValue(rawValue: string): unknown {
  const normalized = rawValue.trim();
  if (normalized === '') return '';
  const lower = normalized.toLowerCase();
  if (lower === 'true') return true;
  if (lower === 'false') return false;
  if (lower === 'null') return null;

  const looksLikeJsonLiteral =
    (normalized.startsWith('{') && normalized.endsWith('}')) ||
    (normalized.startsWith('[') && normalized.endsWith(']')) ||
    (normalized.startsWith('"') && normalized.endsWith('"'));
  if (looksLikeJsonLiteral) {
    try {
      return JSON.parse(normalized);
    } catch {
      return normalized;
    }
  }

  return normalized;
}

function validateInputKey(key: string): string | null {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    return 'input key must match [A-Za-z_][A-Za-z0-9_]*';
  }
  if (RESERVED_OPERATION_INPUT_KEYS.has(key)) {
    return `input key '${key}' is reserved`;
  }
  return null;
}

function printHeader(sessionMode: E2ESessionMode, useTestNetwork: boolean, appLogsMode: E2EFlowAppLogsMode): void {
  console.info(
    `[E2E] Operation console started (sessionMode=${sessionMode}, useTestNetwork=${String(useTestNetwork)}, appLogsMode=${appLogsMode}).`,
  );
  if (appLogsMode === 'quiet') {
    console.info('[E2E] app logs are suppressed. Set E2E_CONSOLE_APP_LOGS=inherit for full runtime output.');
  }
  if ((process.env.E2E_DRIVER_TRACE ?? '1') === '0') {
    console.info('[E2E] driver command trace is suppressed. Set E2E_CONSOLE_DRIVER_TRACE=1 for verbose trace logs.');
  }
  if (suppressPolkadotWarnings) {
    console.info(
      '[E2E] polkadot dedupe warnings are suppressed in console mode. Set E2E_CONSOLE_SUPPRESS_POLKADOT_WARNINGS=0 to show them.',
    );
  }
}

function printStatus(state: IConsoleState): void {
  console.info(
    `[E2E] status context=${state.context} mode=${state.mode} timeoutMs=${state.timeoutMs ?? 'default (flow)'} inputs=${Object.keys(state.inputs).length}`,
  );
}

function printHelp(): void {
  console.info('[E2E] commands:');
  console.info('[E2E]   status');
  console.info('[E2E]   runnable  # inspect all operations for this context and show runnable/blocked');
  console.info('[E2E]   inputs    # show current console input overrides');
  console.info('[E2E]   set <key> <value>');
  console.info('[E2E]   unset <key|*>');
  console.info('[E2E]   help');
  console.info('[E2E]   context <app|bitcoin|mining|vaulting>');
  console.info('[E2E]   mode <run|inspect>');
  console.info('[E2E]   timeout <milliseconds|off>');
  console.info('[E2E]   run <Operation.one,Operation.two>');
  console.info('[E2E]   inspect <Operation.one,Operation.two>');
  console.info('[E2E]   inspect *  # same as runnable');
  console.info('[E2E]   <Operation.one,Operation.two>  # uses current mode');
  console.info('[E2E]   exit');
}

function printInputs(inputs: Record<string, unknown>): void {
  const entries = Object.entries(inputs).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) {
    console.info('[E2E] inputs: (none)');
    return;
  }
  for (const [key, value] of entries) {
    console.info(`[E2E] input.${key}=${safeSerialize(value)}`);
  }
}

function printInspectSummary(data: Record<string, unknown>): void {
  const runnable = toStringArray(data.runnableOperations);
  const blocked = toStringArray(data.blockedOperations);
  const unknown = toStringArray(data.unknownRunnableOperations);
  const blockedReasons = toStringArrayMap(data.blockedOperationReasons);
  const requiredInputs = toStringArray(data.requiredInputs);
  const missingRequiredInputs = toStringArray(data.missingRequiredInputs);
  const inputDefinitions = toInputDefinitions(data.operationInputDefinitions);

  if (runnable.length === 0 && blocked.length === 0 && unknown.length === 0) {
    return;
  }

  console.info(`[E2E] runnable: ${runnable.length > 0 ? runnable.join(', ') : '(none)'}`);
  console.info(`[E2E] blocked: ${blocked.length > 0 ? blocked.join(', ') : '(none)'}`);
  for (const name of blocked) {
    const reasons = blockedReasons[name];
    if (!reasons || reasons.length === 0) continue;
    console.info(`[E2E] blocked:${name}: ${reasons.join(' | ')}`);
  }
  console.info(`[E2E] unknown: ${unknown.length > 0 ? unknown.join(', ') : '(none)'}`);

  if (inputDefinitions.length > 0) {
    const labels = inputDefinitions.map(definition => `${definition.key}${definition.required ? '*' : ''}`);
    console.info(`[E2E] inputs available: ${labels.join(', ')}`);
  }

  if (requiredInputs.length > 0) {
    console.info(`[E2E] required inputs: ${requiredInputs.join(', ')}`);
  }

  if (missingRequiredInputs.length > 0) {
    console.info(`[E2E] missing required inputs: ${missingRequiredInputs.join(', ')}`);
    for (const key of missingRequiredInputs) {
      const definition = inputDefinitions.find(entry => entry.key === key);
      if (!definition?.description) continue;
      console.info(`[E2E] missing:${key}: ${definition.description}`);
    }
  }
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

function toStringArrayMap(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== 'object') return {};
  const map: Record<string, string[]> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(entry)) continue;
    const reasons = entry.filter((part): part is string => typeof part === 'string' && part.length > 0);
    if (reasons.length > 0) map[key] = reasons;
  }
  return map;
}

function toInputDefinitions(value: unknown): IInputDefinitionSummary[] {
  if (!Array.isArray(value)) return [];
  const definitions: IInputDefinitionSummary[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.key !== 'string' || record.key.length === 0) continue;
    definitions.push({
      key: record.key,
      required: record.required === true,
      description:
        typeof record.description === 'string' && record.description.length > 0 ? record.description : undefined,
      operations: toStringArray(record.operations),
    });
  }
  definitions.sort((left, right) => left.key.localeCompare(right.key));
  return definitions;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function safeSerialize(value: unknown): string {
  try {
    const replacer = (_key: string, entry: unknown): unknown =>
      typeof entry === 'bigint' ? `${entry.toString()}n` : entry;
    return JSON.stringify(value, replacer) ?? 'null';
  } catch {
    return String(value);
  }
}

void main().catch(error => {
  console.error(error);
  process.exit(1);
});
