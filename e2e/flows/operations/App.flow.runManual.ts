import fs from 'node:fs';
import Path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { BITCOIN_FLOW_INPUT_DEFINITIONS, createBitcoinFlowContext } from '../contexts/bitcoinContext.ts';
import { MINING_FLOW_INPUT_DEFINITIONS, createMiningFlowContext } from '../contexts/miningContext.ts';
import { VAULTING_FLOW_INPUT_DEFINITIONS, createVaultingFlowContext } from '../contexts/vaultingContext.ts';
import type { E2ECommandArgs, IE2EFlowRuntime, IE2EOperationInspectState } from '../types.ts';
import { inspectOperation, OperationalFlow, type AnyOperation, type IOperationInputDefinition } from './index.ts';

type OperationContextName = 'app' | 'bitcoin' | 'mining' | 'vaulting';
type OperationRunMode = 'run' | 'inspect';

interface IRunOperationsContext {
  flow: IE2EFlowRuntime;
  flowName: string;
}

interface IRunOperationsUiState {
  operationContext: OperationContextName;
  operationNames: string[];
  operationFlowName: string;
  operationTimeoutMs?: number;
  operationMode: OperationRunMode;
}

interface IRunOperationsState extends IE2EOperationInspectState<Record<string, never>, IRunOperationsUiState> {
  operationContext: OperationContextName;
  operationNames: string[];
  operationFlowName: string;
  operationTimeoutMs?: number;
  operationMode: OperationRunMode;
}

interface IOperationContextDefinition {
  createContext: (flow: IE2EFlowRuntime, flowName: string) => unknown;
  inputDefinitions: ReadonlyArray<IOperationInputDefinition>;
  operationsByName: ReadonlyMap<string, AnyOperation<unknown>>;
}

interface IOperationInputSummary {
  key: string;
  required: boolean;
  description?: string;
  operations: string[];
}

interface IDiscoveredOperation {
  fileName: string;
  context: OperationContextName;
  operation: AnyOperation<unknown>;
}

export default new OperationalFlow<IRunOperationsContext, IRunOperationsState>(import.meta, {
  description: 'Run selected operations sequentially against the current runtime state.',
  defaultTimeoutMs: 20_000,
  createContext: (flow, flowName) => ({ flow, flowName }),
  async inspect({ flow, flowName }) {
    const parsedState = parseRunOperationsState(flow.input, flowName);
    return {
      chainState: {},
      uiState: {
        operationContext: parsedState.operationContext,
        operationNames: parsedState.operationNames,
        operationFlowName: parsedState.operationFlowName,
        operationTimeoutMs: parsedState.operationTimeoutMs,
        operationMode: parsedState.operationMode,
      },
      state: 'runnable',
      blockers: [],
      ...parsedState,
    };
  },
  async run({ flow }, state) {
    if (state.operationTimeoutMs) {
      flow.defaultTimeoutMs = state.operationTimeoutMs;
      console.info(`[E2E] Operation command timeout set to ${state.operationTimeoutMs}ms`);
    }
    const readinessTimeoutMs = state.operationTimeoutMs ?? Math.max(flow.defaultTimeoutMs, 45_000);
    await flow.command('app.waitForReady', { timeoutMs: readinessTimeoutMs });
    const definition = OPERATION_CONTEXTS[state.operationContext];
    const unknownOperations = state.operationNames.filter(name => !definition.operationsByName.has(name));
    if (unknownOperations.length > 0) {
      const availableNames = [...definition.operationsByName.keys()].sort((left, right) => left.localeCompare(right));
      throw new Error(
        `[E2E] Unknown ${state.operationContext} operation(s): ${unknownOperations.join(', ')}. ` +
          `Available: ${availableNames.join(', ')}`,
      );
    }

    const operationContext = definition.createContext(flow, state.operationFlowName);
    const operations = state.operationNames.map(name => definition.operationsByName.get(name) as AnyOperation<unknown>);
    const contextInputs = readContextInputs(operationContext);
    const inputSummary = summarizeOperationInputs(operations, definition.inputDefinitions);
    const missingRequiredInputs = collectMissingRequiredInputs(operations, definition.inputDefinitions, contextInputs);
    const missingRequiredInputsByOperation = distributeMissingRequiredInputs(
      operations,
      definition.inputDefinitions,
      contextInputs,
    );
    if (state.operationMode === 'inspect') {
      console.info(
        `[E2E] Inspecting ${operations.length} ${state.operationContext} operation(s): ${state.operationNames.join(', ')}`,
      );
      const operationInspections: Record<string, unknown> = {};
      const runnableOperations: string[] = [];
      const blockedOperations: string[] = [];
      const unknownRunnableOperations: string[] = [];
      const blockedOperationReasons: Record<string, string[]> = {};
      for (const operation of operations) {
        flow.setActiveOperation(operation.name);
        try {
          const inspection = await inspectOperation(operationContext, operation);
          operationInspections[operation.name] = inspection;
          const inspectionBlockers = extractBlockersFromInspection(inspection);
          const requiredInputBlockers = formatMissingRequiredInputs(
            missingRequiredInputsByOperation[operation.name] ?? [],
          );
          const blockers = uniqueSorted([...inspectionBlockers, ...requiredInputBlockers]);
          const runnable = inferRunnableFromInspection(inspection);
          if (runnable === true && blockers.length === 0) {
            runnableOperations.push(operation.name);
          } else if (runnable === false || blockers.length > 0) {
            blockedOperations.push(operation.name);
            blockedOperationReasons[operation.name] = blockers;
          } else {
            unknownRunnableOperations.push(operation.name);
          }
          console.info(`[E2E] inspect ${operation.name}: ${safeSerialize(inspection)}`);
        } finally {
          flow.setActiveOperation('');
        }
      }
      flow.setData('operationInspections', operationInspections);
      flow.setData(
        'inspectedOperations',
        operations.map(operation => operation.name),
      );
      flow.setData('runnableOperations', runnableOperations);
      flow.setData('blockedOperations', blockedOperations);
      flow.setData('unknownRunnableOperations', unknownRunnableOperations);
      flow.setData('blockedOperationReasons', blockedOperationReasons);
      flow.setData('operationInputsByOperation', inputSummary.byOperation);
      flow.setData('operationInputDefinitions', inputSummary.definitions);
      flow.setData('requiredInputs', inputSummary.requiredInputKeys);
      flow.setData('missingRequiredInputs', missingRequiredInputs);
      flow.setData('missingRequiredInputsByOperation', missingRequiredInputsByOperation);
      return;
    }

    if (missingRequiredInputs.length > 0) {
      throw new Error(
        `[E2E] Missing required input(s): ${missingRequiredInputs.join(', ')}. ` +
          'Run inspect to view required inputs by operation.',
      );
    }

    console.info(
      `[E2E] Running ${operations.length} ${state.operationContext} operation(s): ${state.operationNames.join(', ')}`,
    );
    for (const operation of operations) {
      await flow.run(operationContext, operation, {
        timeoutMs: state.operationTimeoutMs,
      });
    }
  },
});

const OPERATION_FILE_PATTERN = /^[A-Z][A-Za-z0-9]*\.(op|flow)\.[A-Za-z0-9_]+\.(ts|js)$/;
const OPERATIONS_DIR = resolveOperationsDir();
const requireOperationModule = createRequire(Path.join(OPERATIONS_DIR, 'index.ts'));
const DISCOVERED_OPERATIONS = discoverOperations();

const OPERATION_CONTEXTS: Record<OperationContextName, IOperationContextDefinition> = {
  app: {
    createContext: flow => ({ flow }),
    inputDefinitions: [],
    operationsByName: createDiscoveredOperationMap('app'),
  },
  bitcoin: {
    createContext: createBitcoinFlowContext,
    inputDefinitions: BITCOIN_FLOW_INPUT_DEFINITIONS,
    operationsByName: createDiscoveredOperationMap('bitcoin'),
  },
  mining: {
    createContext: createMiningFlowContext,
    inputDefinitions: MINING_FLOW_INPUT_DEFINITIONS,
    operationsByName: createDiscoveredOperationMap('mining'),
  },
  vaulting: {
    createContext: createVaultingFlowContext,
    inputDefinitions: VAULTING_FLOW_INPUT_DEFINITIONS,
    operationsByName: createDiscoveredOperationMap('vaulting'),
  },
};

function parseRunOperationsState(
  input: E2ECommandArgs,
  flowName: string,
): Pick<
  IRunOperationsState,
  'operationContext' | 'operationNames' | 'operationFlowName' | 'operationTimeoutMs' | 'operationMode'
> {
  const operationContext = parseOperationContextName(
    input.operationContext ?? input.context ?? process.env.E2E_OPERATION_CONTEXT,
    flowName,
  );
  const operationNamesForContext = [...OPERATION_CONTEXTS[operationContext].operationsByName.keys()];
  const operationNames = parseOperationNames(
    input.operations ?? input.operationNames ?? input.operation ?? process.env.E2E_OPERATIONS,
    flowName,
    operationNamesForContext,
  );
  const operationFlowName =
    parseOptionalString(input.operationFlowName) ??
    parseOptionalString(input.flowNameOverride) ??
    parseOptionalString(process.env.E2E_OPERATION_FLOW_NAME) ??
    `${flowName}.${operationContext}`;
  const operationTimeoutMs = parsePositiveInteger(
    input.operationTimeoutMs ?? input.timeoutMs ?? process.env.E2E_OPERATION_TIMEOUT_MS,
    `${flowName}.timeoutMs`,
  );
  const operationMode = parseRunMode(input.operationMode ?? process.env.E2E_OPERATION_MODE, flowName);
  return {
    operationContext,
    operationNames,
    operationFlowName,
    operationTimeoutMs,
    operationMode,
  };
}

function parseOperationContextName(value: unknown, flowName: string): OperationContextName {
  const normalized = parseOptionalString(value)?.toLowerCase();
  if (normalized === 'app' || normalized === 'bitcoin' || normalized === 'mining' || normalized === 'vaulting') {
    return normalized;
  }
  throw new Error(
    `[E2E] ${flowName} requires operationContext (app|bitcoin|mining|vaulting). ` +
      `Set E2E_OPERATION_CONTEXT when using App.flow.runManual.`,
  );
}

function parseOperationNames(value: unknown, flowName: string, availableOperationNames: string[]): string[] {
  const allNames = [...availableOperationNames].sort((left, right) => left.localeCompare(right));
  const isWildcard = (entry: string): boolean => entry === '*' || entry.toLowerCase() === 'all';

  if (Array.isArray(value)) {
    const names = value
      .filter((entry): entry is string => typeof entry === 'string')
      .map(entry => entry.trim())
      .filter(Boolean);
    if (names.length === 1 && isWildcard(names[0])) {
      return allNames;
    }
    if (names.length > 0) return names;
  }
  if (typeof value === 'string') {
    const normalized = value.trim();
    if (isWildcard(normalized)) {
      return allNames;
    }
    const names = normalized
      .split(',')
      .map(part => part.trim())
      .filter(Boolean);
    if (names.length === 1 && isWildcard(names[0])) {
      return allNames;
    }
    if (names.length > 0) return names;
  }
  throw new Error(`[E2E] ${flowName} requires operations (comma-separated operation names).`);
}

function parseOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized ? normalized : undefined;
}

function parsePositiveInteger(value: unknown, fieldName: string): number | undefined {
  if (value == null) return undefined;
  if (typeof value === 'string') {
    const normalized = value.trim();
    if (normalized === '') return undefined;
    const parsed = Number.parseInt(normalized, 10);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error(`[E2E] ${fieldName} must be a positive integer.`);
    }
    return parsed;
  }
  if (typeof value !== 'number') {
    throw new Error(`[E2E] ${fieldName} must be a positive integer.`);
  }
  const parsed = value;
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`[E2E] ${fieldName} must be a positive integer.`);
  }
  return parsed;
}

function toOperationMap(operations: ReadonlyArray<AnyOperation<any>>): ReadonlyMap<string, AnyOperation<unknown>> {
  const entries = operations.map(operation => [operation.name, operation as AnyOperation<unknown>] as const);
  return new Map(entries);
}

function createDiscoveredOperationMap(context: OperationContextName): ReadonlyMap<string, AnyOperation<unknown>> {
  const operations = DISCOVERED_OPERATIONS.filter(entry => entry.context === context)
    .sort((left, right) => left.operation.name.localeCompare(right.operation.name))
    .map(entry => entry.operation);
  return toOperationMap(operations);
}

function parseRunMode(value: unknown, flowName: string): OperationRunMode {
  const normalized = parseOptionalString(value)?.toLowerCase();
  if (!normalized || normalized === 'run') return 'run';
  if (normalized === 'inspect') return 'inspect';
  if (normalized === 'wait-run' || normalized === 'waitrun' || normalized === 'wait') return 'run';
  throw new Error(`[E2E] ${flowName}.operationMode must be "run" or "inspect".`);
}

function safeSerialize(value: unknown): string {
  return JSON.stringify(value, replaceBigInt);
}

function replaceBigInt(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return `${value.toString()}n`;
  return value;
}

function inferRunnableFromInspection(inspection: unknown): boolean | null {
  if (!inspection || typeof inspection !== 'object') {
    return null;
  }

  const record = inspection as Record<string, unknown>;
  if (record.state === 'runnable') {
    return true;
  }
  if (record.state === 'complete' || record.state === 'processing' || record.state === 'uiStateMismatch') {
    return false;
  }
  return null;
}

function extractBlockersFromInspection(inspection: unknown): string[] {
  if (!inspection || typeof inspection !== 'object') {
    return [];
  }
  const blockers = (inspection as Record<string, unknown>).blockers;
  if (!Array.isArray(blockers)) {
    return [];
  }
  return blockers.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

function summarizeOperationInputs(
  operations: ReadonlyArray<AnyOperation<unknown>>,
  inputDefinitions: ReadonlyArray<IOperationInputDefinition>,
): {
  byOperation: Record<string, IOperationInputDefinition[]>;
  definitions: IOperationInputSummary[];
  requiredInputKeys: string[];
} {
  const byOperation: Record<string, IOperationInputDefinition[]> = {};
  const definitionsByKey = new Map<string, IOperationInputSummary>();
  for (const operation of operations) {
    const operationDefinitions = getOperationInputDefinitions(operation, inputDefinitions);
    byOperation[operation.name] = operationDefinitions;
    for (const definition of operationDefinitions) {
      const existing = definitionsByKey.get(definition.key);
      if (existing) {
        existing.required ||= definition.required ?? false;
        existing.description ??= definition.description;
        if (!existing.operations.includes(operation.name)) {
          existing.operations.push(operation.name);
        }
        continue;
      }
      definitionsByKey.set(definition.key, {
        key: definition.key,
        required: definition.required ?? false,
        description: definition.description,
        operations: [operation.name],
      });
    }
  }

  const definitions = [...definitionsByKey.values()].sort((left, right) => left.key.localeCompare(right.key));
  const requiredInputKeys = definitions.filter(definition => definition.required).map(definition => definition.key);
  return {
    byOperation,
    definitions,
    requiredInputKeys,
  };
}

function collectMissingRequiredInputs(
  operations: ReadonlyArray<AnyOperation<unknown>>,
  inputDefinitions: ReadonlyArray<IOperationInputDefinition>,
  contextInputs: Record<string, unknown>,
): string[] {
  return uniqueSorted(
    operations.flatMap(operation =>
      getOperationInputDefinitions(operation, inputDefinitions)
        .filter(input => input.required === true && isInputValueMissing(contextInputs[input.key]))
        .map(input => input.key),
    ),
  );
}

function distributeMissingRequiredInputs(
  operations: ReadonlyArray<AnyOperation<unknown>>,
  inputDefinitions: ReadonlyArray<IOperationInputDefinition>,
  contextInputs: Record<string, unknown>,
): Record<string, string[]> {
  const missingByOperation: Record<string, string[]> = {};
  for (const operation of operations) {
    const missingInputs = getOperationInputDefinitions(operation, inputDefinitions)
      .filter(input => input.required === true && isInputValueMissing(contextInputs[input.key]))
      .map(input => input.key);
    if (missingInputs.length > 0) {
      missingByOperation[operation.name] = uniqueSorted(missingInputs);
    }
  }
  return missingByOperation;
}

function getOperationInputDefinitions(
  operation: AnyOperation<unknown>,
  sharedInputDefinitions: ReadonlyArray<IOperationInputDefinition>,
): IOperationInputDefinition[] {
  const definitionsByKey = new Map<string, IOperationInputDefinition>();
  for (const definition of [...sharedInputDefinitions, ...operation.inputs]) {
    const existing = definitionsByKey.get(definition.key);
    if (existing) {
      existing.required ||= definition.required;
      existing.description ??= definition.description;
      continue;
    }
    definitionsByKey.set(definition.key, { ...definition });
  }
  return [...definitionsByKey.values()].sort((left, right) => left.key.localeCompare(right.key));
}

function readContextInputs(context: unknown): Record<string, unknown> {
  if (!context || typeof context !== 'object' || Array.isArray(context)) {
    return {};
  }
  const input = (context as { input?: unknown }).input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {};
  }
  return input as Record<string, unknown>;
}

function isInputValueMissing(value: unknown): boolean {
  if (value == null) return true;
  if (typeof value === 'string') {
    return value.trim().length === 0;
  }
  return false;
}

function formatMissingRequiredInputs(missingInputs: string[]): string[] {
  if (missingInputs.length === 0) return [];
  return [`Missing required input(s): ${missingInputs.join(', ')}`];
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function discoverOperations(): IDiscoveredOperation[] {
  const currentFileName = resolveCurrentOperationFileName();
  const moduleFiles = fs
    .readdirSync(OPERATIONS_DIR, { withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => entry.name)
    .filter(name => name !== 'index.ts' && name !== 'index.js')
    .filter(name => name !== currentFileName)
    .filter(name => OPERATION_FILE_PATTERN.test(name))
    .sort((left, right) => left.localeCompare(right));

  const operations: IDiscoveredOperation[] = [];
  for (const fileName of moduleFiles) {
    const modulePath = Path.join(OPERATIONS_DIR, fileName);
    const moduleExports = requireOperationModule(modulePath) as Record<string, unknown>;
    const operation = moduleExports.default;
    if (!isOperationExport(operation)) {
      throw new Error(`[E2E] ${fileName} must default-export an Operation or OperationalFlow`);
    }
    operations.push({
      fileName,
      context: parseContextFromFileName(fileName),
      operation: operation,
    });
  }

  return assertUniqueOperationNames(operations);
}

function assertUniqueOperationNames(operations: IDiscoveredOperation[]): IDiscoveredOperation[] {
  const seenByContext = new Map<OperationContextName, Set<string>>();
  for (const entry of operations) {
    const contextNames = seenByContext.get(entry.context) ?? new Set<string>();
    if (contextNames.has(entry.operation.name)) {
      throw new Error(
        `[E2E] Duplicate ${entry.context} operation name '${entry.operation.name}' discovered from ${entry.fileName}`,
      );
    }
    contextNames.add(entry.operation.name);
    seenByContext.set(entry.context, contextNames);
  }
  return operations;
}

function parseContextFromFileName(fileName: string): OperationContextName {
  const normalized = fileName.split('.', 1)[0]?.toLowerCase();
  if (normalized === 'app' || normalized === 'bitcoin' || normalized === 'mining' || normalized === 'vaulting') {
    return normalized;
  }
  throw new Error(`[E2E] ${fileName} uses an unknown operation context prefix.`);
}

function isOperationExport(value: unknown): value is AnyOperation<unknown> {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as { name?: unknown; inspect?: unknown; run?: unknown };
  return (
    typeof candidate.name === 'string' && typeof candidate.inspect === 'function' && typeof candidate.run === 'function'
  );
}

function resolveCurrentOperationFileName(): string {
  const metaUrl = (import.meta as { url?: unknown }).url;
  if (typeof metaUrl !== 'string' || metaUrl.length === 0) {
    throw new Error('Unable to resolve current operation file.');
  }
  return Path.basename(fileURLToPath(metaUrl));
}

function resolveOperationsDir(): string {
  const metaUrl = (import.meta as { url?: unknown }).url;
  if (typeof metaUrl === 'string' && metaUrl.length > 0) {
    return fileURLToPath(new URL('.', metaUrl));
  }

  const candidates = [
    Path.resolve(process.cwd(), 'e2e/flows/operations'),
    Path.resolve(process.cwd(), 'flows/operations'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error('Unable to resolve e2e operation directory.');
}
