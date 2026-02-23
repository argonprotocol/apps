import { BITCOIN_FLOW_INPUT_DEFINITIONS, createBitcoinFlowContext } from '../contexts/bitcoinContext.ts';
import { MINING_FLOW_INPUT_DEFINITIONS, createMiningFlowContext } from '../contexts/miningContext.ts';
import { VAULTING_FLOW_INPUT_DEFINITIONS, createVaultingFlowContext } from '../contexts/vaultingContext.ts';
import type { E2ECommandArgs, IE2EFlowRuntime, IE2EOperationInspectState } from '../types.ts';
import appDismissBlockingOverlays from './App.op.dismissBlockingOverlays.ts';
import bitcoinEnsureLockFundingDetails from './Bitcoin.op.ensureLockFundingDetails.ts';
import bitcoinFundLockExact from './Bitcoin.op.fundLockExact.ts';
import bitcoinUnlockBitcoin from './Bitcoin.op.unlockBitcoin.ts';
import bitcoinWaitUnlockReady from './Bitcoin.op.waitUnlockReady.ts';
import miningActivateTab from './Mining.op.activateTab.ts';
import miningCompleteChecklist from './Mining.op.completeChecklist.ts';
import miningConnectServer from './Mining.op.connectServer.ts';
import miningFinalizeSetup from './Mining.op.finalizeSetup.ts';
import miningFundWallet from './Mining.op.fundWallet.ts';
import miningStartRegistration from './Mining.op.startRegistration.ts';
import vaultingActivateTab from './Vaulting.op.activateTab.ts';
import vaultingCompleteChecklist from './Vaulting.op.completeChecklist.ts';
import vaultingEnsureOperational from './Vaulting.op.ensureOperational.ts';
import vaultingFinalizeSetup from './Vaulting.op.finalizeSetup.ts';
import vaultingFundWallet from './Vaulting.op.fundWallet.ts';
import vaultingStartRegistration from './Vaulting.op.startRegistration.ts';
import { OperationalFlow, type AnyOperation, type IOperationApi, type IOperationInputDefinition } from './index.ts';

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
      isRunnable: true,
      isComplete: false,
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
    await flow.run('app.waitForReady', { timeoutMs: readinessTimeoutMs });
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
    const missingRequiredInputs = collectMissingRequiredInputs(definition.inputDefinitions, contextInputs);
    const missingRequiredInputsByOperation = distributeMissingRequiredInputs(operations, missingRequiredInputs);
    if (state.operationMode === 'inspect') {
      console.info(
        `[E2E] Inspecting ${operations.length} ${state.operationContext} operation(s): ${state.operationNames.join(', ')}`,
      );
      const inspectApi = createInspectOnlyApi(operationContext);
      const operationInspections: Record<string, unknown> = {};
      const runnableOperations: string[] = [];
      const blockedOperations: string[] = [];
      const unknownRunnableOperations: string[] = [];
      const blockedOperationReasons: Record<string, string[]> = {};
      for (const operation of operations) {
        flow.setActiveOperation(operation.name);
        try {
          const inspection = await operation.inspect(operationContext, inspectApi);
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
    await flow.runOperations(operationContext, operations);
  },
});

const OPERATION_CONTEXTS: Record<OperationContextName, IOperationContextDefinition> = {
  app: {
    createContext: flow => ({ flow }),
    inputDefinitions: [],
    operationsByName: toOperationMap([appDismissBlockingOverlays]),
  },
  bitcoin: {
    createContext: createBitcoinFlowContext,
    inputDefinitions: BITCOIN_FLOW_INPUT_DEFINITIONS,
    operationsByName: toOperationMap([
      bitcoinEnsureLockFundingDetails,
      bitcoinFundLockExact,
      bitcoinUnlockBitcoin,
      bitcoinWaitUnlockReady,
    ]),
  },
  mining: {
    createContext: createMiningFlowContext,
    inputDefinitions: MINING_FLOW_INPUT_DEFINITIONS,
    operationsByName: toOperationMap([
      miningActivateTab,
      miningCompleteChecklist,
      miningConnectServer,
      miningFinalizeSetup,
      miningFundWallet,
      miningStartRegistration,
    ]),
  },
  vaulting: {
    createContext: createVaultingFlowContext,
    inputDefinitions: VAULTING_FLOW_INPUT_DEFINITIONS,
    operationsByName: toOperationMap([
      vaultingActivateTab,
      vaultingCompleteChecklist,
      vaultingEnsureOperational,
      vaultingFinalizeSetup,
      vaultingFundWallet,
      vaultingStartRegistration,
    ]),
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

function parseRunMode(value: unknown, flowName: string): OperationRunMode {
  const normalized = parseOptionalString(value)?.toLowerCase();
  if (!normalized || normalized === 'run') return 'run';
  if (normalized === 'inspect') return 'inspect';
  throw new Error(`[E2E] ${flowName}.operationMode must be "run" or "inspect".`);
}

function createInspectOnlyApi(context: unknown): IOperationApi<any> {
  const api: IOperationApi<any> = {
    inspect: async operation => {
      return await operation.inspect(context, api);
    },
    run: async operation => {
      await operation.inspect(context, api);
    },
  };
  return api;
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
  if (typeof record.isRunnable === 'boolean') {
    return record.isRunnable;
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
  const mappedDefinitions = inputDefinitions.map(input => ({
    key: input.key,
    required: input.required ?? false,
    description: input.description,
  }));
  const byOperation: Record<string, IOperationInputDefinition[]> = {};
  for (const operation of operations) {
    byOperation[operation.name] = mappedDefinitions;
  }

  const definitions = mappedDefinitions
    .map(definition => ({
      ...definition,
      operations: operations.map(operation => operation.name),
    }))
    .sort((left, right) => left.key.localeCompare(right.key));
  const requiredInputKeys = definitions.filter(definition => definition.required).map(definition => definition.key);
  return {
    byOperation,
    definitions,
    requiredInputKeys,
  };
}

function collectMissingRequiredInputs(
  inputDefinitions: ReadonlyArray<IOperationInputDefinition>,
  contextInputs: Record<string, unknown>,
): string[] {
  return uniqueSorted(
    inputDefinitions
      .filter(input => input.required === true && isInputValueMissing(contextInputs[input.key]))
      .map(input => input.key),
  );
}

function distributeMissingRequiredInputs(
  operations: ReadonlyArray<AnyOperation<unknown>>,
  missingRequiredInputs: string[],
): Record<string, string[]> {
  if (missingRequiredInputs.length === 0) {
    return {};
  }
  const missingByOperation: Record<string, string[]> = {};
  for (const operation of operations) {
    missingByOperation[operation.name] = [...missingRequiredInputs];
  }
  return missingByOperation;
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
