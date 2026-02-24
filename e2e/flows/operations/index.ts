import { flowNameFromFile } from '../helpers/flowNameFromFile.ts';
import { logDefaultAppFailureDiagnostics, withStateContext } from '../helpers/operationFailure.ts';
import type { IE2EFlowRuntime } from '../types.ts';

export interface IOperationInputDefinition {
  key: string;
  required?: boolean;
  description?: string;
}

export interface IOperationApi<Context> {
  inspect<State>(operation: Operation<Context, State>): Promise<State>;
  run<State>(operation: Operation<Context, State>): Promise<void>;
}

export interface IOperationImpl<Context, State> {
  inspect: (this: Operation<Context, State>, context: Context, api: IOperationApi<Context>) => Promise<State>;
  run: (this: Operation<Context, State>, context: Context, state: State, api: IOperationApi<Context>) => Promise<void>;
  diagnose?: (
    this: Operation<Context, State>,
    context: Context,
    state: State,
    error: unknown,
    api: IOperationApi<Context>,
  ) => Promise<void>;
  inputs?: ReadonlyArray<IOperationInputDefinition>;
}

export type AnyOperation<Context> = Operation<Context, any>;
export type AnyOperationalFlow = OperationalFlow<any, any>;

export interface IOperationalFlowImpl<Context, State> extends IOperationImpl<Context, State> {
  description: string;
  defaultTimeoutMs: number;
  createContext: (flow: IE2EFlowRuntime, flowName: string) => Context;
}

export class Operation<Context, State = unknown> {
  readonly name: string;
  readonly inputs: ReadonlyArray<IOperationInputDefinition>;
  private readonly impl: IOperationImpl<Context, State>;

  constructor(meta: ImportMeta, impl: IOperationImpl<Context, State>) {
    this.name = flowNameFromFile(meta);
    this.inputs = impl.inputs ?? [];
    this.impl = impl;
  }

  inspect = async (context: Context, api: IOperationApi<Context>): Promise<State> => {
    return await this.impl.inspect.call(this, context, api);
  };

  run = async (context: Context, state: State, api: IOperationApi<Context>): Promise<void> => {
    await this.impl.run.call(this, context, state, api);
  };

  diagnose = async (context: Context, state: State, error: unknown, api: IOperationApi<Context>): Promise<void> => {
    await this.impl.diagnose?.call(this, context, state, error, api);
  };
}

export class OperationalFlow<Context, State = unknown> extends Operation<Context, State> {
  readonly description: string;
  readonly defaultTimeoutMs: number;
  readonly createContext: (flow: IE2EFlowRuntime, flowName: string) => Context;

  constructor(meta: ImportMeta, impl: IOperationalFlowImpl<Context, State>) {
    super(meta, impl);
    this.description = impl.description;
    this.defaultTimeoutMs = impl.defaultTimeoutMs;
    this.createContext = impl.createContext;
  }
}

export async function runOperations<Context>(
  context: Context,
  operations: ReadonlyArray<AnyOperation<Context>>,
): Promise<void> {
  const api = createOperationApi(context);
  for (const operation of operations) {
    await runOperation(context, operation, api);
  }
}

async function runOperation<Context, State>(
  context: Context,
  operation: Operation<Context, State>,
  api: IOperationApi<Context>,
): Promise<void> {
  setActiveOperationLabel(context, operation.name);
  let state = undefined as State;
  let hasState = false;
  console.info(`[E2E] operation:start ${operation.name}`);
  try {
    state = await operation.inspect(context, api);
    hasState = true;
    const lifecycle = readOperationLifecycleState(state);
    console.info(
      `[E2E] operation:inspect ${operation.name} isComplete=${String(lifecycle.isComplete)} isRunnable=${String(
        lifecycle.isRunnable,
      )} blockers=${lifecycle.blockers.join('|')}`,
    );
    if (lifecycle.isComplete === true) {
      console.info(`[E2E] operation:skip-complete ${operation.name}`);
      return;
    }
    if (lifecycle.isRunnable === false) {
      const blockerMessage =
        lifecycle.blockers.length > 0 ? lifecycle.blockers.join(', ') : 'inspect reported not runnable';
      throw new Error(`[E2E] operation '${operation.name}' is not runnable: ${blockerMessage}`);
    }
    console.info(`[E2E] operation:run ${operation.name}`);
    await operation.run(context, state, api);
    console.info(`[E2E] operation:done ${operation.name}`);
  } catch (error) {
    if (!hasState) {
      throw error;
    }
    await logDefaultAppFailureDiagnostics(context, operation.name, state, error).catch(diagnosticsError => {
      console.error(
        `[E2E] operation '${operation.name}' default diagnostics failed: ${
          diagnosticsError instanceof Error ? diagnosticsError.message : String(diagnosticsError)
        }`,
      );
    });
    await operation.diagnose(context, state, error, api).catch(diagnoseError => {
      console.error(
        `[E2E] operation '${operation.name}' diagnose hook failed: ${
          diagnoseError instanceof Error ? diagnoseError.message : String(diagnoseError)
        }`,
      );
    });
    throw withStateContext(error, operation.name, state);
  } finally {
    clearActiveOperationLabel(context);
  }
}

function createOperationApi<Context>(context: Context): IOperationApi<Context> {
  const api: IOperationApi<Context> = {
    inspect: async <State>(operation: Operation<Context, State>): Promise<State> => {
      return await operation.inspect(context, api);
    },
    run: async <State>(operation: Operation<Context, State>): Promise<void> => {
      await runOperation(context, operation, api);
    },
  };
  return api;
}

function setActiveOperationLabel(context: unknown, operationName: string): void {
  const flow = readFlowRuntimeFromContext(context);
  flow?.setActiveOperation?.(operationName);
}

function clearActiveOperationLabel(context: unknown): void {
  const flow = readFlowRuntimeFromContext(context);
  flow?.setActiveOperation?.('');
}

function readFlowRuntimeFromContext(
  context: unknown,
): { setActiveOperation?: (operationName?: string) => void } | null {
  if (!context || typeof context !== 'object' || Array.isArray(context)) return null;
  const flow = (context as { flow?: unknown }).flow;
  if (!flow || typeof flow !== 'object' || Array.isArray(flow)) return null;
  return flow as { setActiveOperation?: (operationName?: string) => void };
}

function readOperationLifecycleState(state: unknown): {
  isRunnable: boolean | undefined;
  isComplete: boolean | undefined;
  blockers: string[];
} {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    return { isRunnable: undefined, isComplete: undefined, blockers: [] };
  }

  const record = state as Record<string, unknown>;
  const isRunnable = typeof record.isRunnable === 'boolean' ? record.isRunnable : undefined;
  const isComplete = typeof record.isComplete === 'boolean' ? record.isComplete : undefined;
  const blockers = Array.isArray(record.blockers)
    ? record.blockers.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    : [];
  return { isRunnable, isComplete, blockers };
}
