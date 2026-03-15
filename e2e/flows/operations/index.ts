import { flowNameFromFile } from '../helpers/flowNameFromFile.ts';
import { logDefaultAppFailureDiagnostics, withStateContext } from '../helpers/operationFailure.ts';
import { captureE2EScreenshot } from '../helpers/screenshotMode.ts';
import type {
  IE2EFlowRuntime,
  IE2EOperationState,
  IE2ERunOperationOptions,
  IE2EWaitUntilRunnableOptions,
} from '../types.ts';
import { waitFor } from '@argonprotocol/apps-core/__test__/helpers/waitFor.ts';

export interface IOperationInputDefinition {
  key: string;
  required?: boolean;
  description?: string;
}

type IFlowWithOperationBindings = IE2EFlowRuntime & {
  inspect: IE2EFlowRuntime['inspect'];
  run: IE2EFlowRuntime['run'];
  waitUntilRunnable: IE2EFlowRuntime['waitUntilRunnable'];
};

export interface IWaitUntilRunnableOptions<Context, State> {
  timeoutMs?: number;
  pollMs?: number;
  timeoutMessage?: string;
  onNotReadyPoll?: (context: Context, state: State) => Promise<void> | void;
}

export interface IOperationImpl<Context, State> {
  inspect: (this: Operation<Context, State>, context: Context) => Promise<State>;
  run: (this: Operation<Context, State>, context: Context, state: State) => Promise<void>;
  diagnose?: (this: Operation<Context, State>, context: Context, state: State, error: unknown) => Promise<void>;
  inputs?: ReadonlyArray<IOperationInputDefinition>;
}

export type AnyOperation<Context, State = unknown> = Operation<Context, State>;
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

  inspect = async (context: Context): Promise<State> => {
    return await this.impl.inspect.call(this, context);
  };

  run = async (context: Context, state: State): Promise<void> => {
    await this.impl.run.call(this, context, state);
  };

  diagnose = async (context: Context, state: State, error: unknown): Promise<void> => {
    await this.impl.diagnose?.call(this, context, state, error);
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

export async function runOperation<Context, State>(
  context: Context,
  operation: Operation<Context, State>,
  options: IE2ERunOperationOptions<Context> = {},
): Promise<void> {
  if (!options.throwIfNotReady) {
    await waitUntilRunnable(context, operation, {
      timeoutMs: options.timeoutMs,
      pollMs: options.pollMs,
      timeoutMessage: options.timeoutMessage,
      onNotReadyPoll: async (waitContext, state) => {
        await options.onNotReadyPoll?.(operation as unknown as AnyOperation<Context>, waitContext, state);
      },
    });
  }
  await runOperationNow(context, operation);
}

async function runOperationNow<Context, State>(context: Context, operation: Operation<Context, State>): Promise<void> {
  setActiveOperationLabel(context, operation.name);
  let state = undefined as State;
  let hasState = false;
  console.info(`[E2E] operation:start ${operation.name}`);
  try {
    state = await inspectOperation(context, operation);
    hasState = true;
    const lifecycle = readOperationLifecycleState(state);
    const phase = readOperationPhase(state);
    console.info(
      `[E2E] operation:inspect ${operation.name} state=${lifecycle.state}${phase ? ` phase=${phase}` : ''} blockers=${lifecycle.blockers.join('|')}`,
    );
    if (lifecycle.state === 'complete') {
      console.info(`[E2E] operation:skip-complete ${operation.name}`);
      return;
    }
    if (lifecycle.state === 'uiStateMismatch') {
      const blockerMessage =
        lifecycle.blockers.length > 0 ? lifecycle.blockers.join(', ') : 'backend/ui state mismatch';
      throw new Error(`[E2E] operation '${operation.name}' UI state mismatch: ${blockerMessage}`);
    }
    if (lifecycle.state !== 'runnable') {
      const blockerMessage =
        lifecycle.blockers.length > 0 ? lifecycle.blockers.join(', ') : 'inspect reported not runnable';
      throw new Error(`[E2E] operation '${operation.name}' is not runnable: ${blockerMessage}`);
    }
    console.info(`[E2E] operation:run ${operation.name}`);
    await withBoundFlowRuntime(context, operation, async () => {
      await operation.run(context, state);
    });
    const postRunState = await inspectOperation(context, operation);
    const postRunLifecycle = readOperationLifecycleState(postRunState);
    if (postRunLifecycle.state !== 'complete') {
      const blockerMessage =
        postRunLifecycle.blockers.length > 0
          ? postRunLifecycle.blockers.join(', ')
          : `post-run state was ${postRunLifecycle.state}`;
      throw new Error(`[E2E] operation '${operation.name}' did not complete after run: ${blockerMessage}`);
    }
    console.info(`[E2E] operation:done ${operation.name}`);
  } catch (error) {
    await captureOperationScreenshot(context, operation.name, 'failure');
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
    await withBoundFlowRuntime(context, operation, async () => {
      await operation.diagnose(context, state, error);
    }).catch(diagnoseError => {
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

export async function inspectOperation<Context, State>(
  context: Context,
  operation: Operation<Context, State>,
): Promise<State> {
  return await withBoundFlowRuntime(context, operation, async () => {
    const state = await operation.inspect(context);
    await captureOperationPhaseScreenshotIfChanged(context, operation.name, state);
    return state;
  });
}

async function withBoundFlowRuntime<Context, State, Result>(
  context: Context,
  currentOperation: Operation<Context, State>,
  callback: () => Promise<Result>,
): Promise<Result> {
  const flow = readFlowRuntimeFromContext(context) as IFlowWithOperationBindings | null;
  if (!flow) {
    return await callback();
  }

  const previousInspect = flow.inspect;
  const previousRun = flow.run;
  const previousWaitUntilRunnable = flow.waitUntilRunnable;

  flow.inspect = async <TargetState = State, TargetContext = Context>(
    operation?: AnyOperation<TargetContext, TargetState>,
  ) => {
    const target = (operation ?? currentOperation) as unknown as Operation<Context, TargetState>;
    return await inspectOperation(context, target);
  };
  flow.run = async (...args: unknown[]) => {
    if (looksLikeOperation(args[0])) {
      const [operation, options] = args;
      await runOperationNowWithOptions(
        context,
        operation as unknown as AnyOperation<Context>,
        options as IE2ERunOperationOptions<Context> | undefined,
      );
      return;
    }
    const [nextContext, operation, options] = args;
    await runOperationNowWithOptions(nextContext as never, operation as never, options as never);
  };
  flow.waitUntilRunnable = async <TargetState = State, TargetContext = Context>(
    operationOrOptions?: AnyOperation<TargetContext, TargetState>,
    maybeOptions?: IE2EWaitUntilRunnableOptions<TargetContext>,
  ) => {
    const target = looksLikeOperation(operationOrOptions)
      ? (operationOrOptions as unknown as Operation<Context, TargetState>)
      : (currentOperation as unknown as Operation<Context, TargetState>);
    const options = (looksLikeOperation(operationOrOptions) ? maybeOptions : undefined) as
      | IE2EWaitUntilRunnableOptions<Context>
      | undefined;
    return await waitUntilRunnable(context, target, {
      timeoutMs: options?.timeoutMs,
      pollMs: options?.pollMs,
      timeoutMessage: options?.timeoutMessage,
      onNotReadyPoll: options?.onNotReadyPoll
        ? async (waitContext: Context, state: TargetState) => {
            await options.onNotReadyPoll?.(waitContext, state);
          }
        : undefined,
    });
  };

  try {
    return await callback();
  } finally {
    flow.inspect = previousInspect;
    flow.run = previousRun;
    flow.waitUntilRunnable = previousWaitUntilRunnable;
  }
}

async function waitUntilRunnable<Context, State>(
  context: Context,
  operation: Operation<Context, State>,
  options: IWaitUntilRunnableOptions<Context, State> = {},
): Promise<State> {
  let latestState = undefined as State;
  await waitFor<void>(
    options.timeoutMs ?? 30_000,
    `${operation.name} runnable`,
    async () => {
      latestState = await inspectOperation(context, operation);
      const lifecycle = readOperationLifecycleState(latestState);
      if (lifecycle.state === 'complete' || lifecycle.state === 'runnable') {
        return true;
      }
      if (lifecycle.state === 'uiStateMismatch') {
        const blockerMessage =
          lifecycle.blockers.length > 0 ? lifecycle.blockers.join(', ') : 'backend/ui state mismatch';
        throw new Error(`[E2E] operation '${operation.name}' UI state mismatch: ${blockerMessage}`);
      }
      await options.onNotReadyPoll?.(context, latestState);
      return undefined;
    },
    {
      pollMs: options.pollMs ?? 100,
      retryErrors: false,
      timeoutMessage: options.timeoutMessage ?? `[E2E] operation '${operation.name}' did not become runnable in time.`,
    },
  );
  return latestState;
}

async function runOperationNowWithOptions<Context>(
  context: Context,
  operation: AnyOperation<Context>,
  options?: IE2ERunOperationOptions<Context>,
): Promise<void> {
  await runOperation(context, operation, options);
}

function setActiveOperationLabel(context: unknown, operationName: string): void {
  const flow = readFlowRuntimeFromContext(context);
  flow?.setActiveOperation?.(operationName);
}

function clearActiveOperationLabel(context: unknown): void {
  const flow = readFlowRuntimeFromContext(context);
  flow?.setActiveOperation?.('');
}

async function captureOperationScreenshot(
  context: unknown,
  operationName: string,
  phase: 'start' | 'end' | 'failure',
): Promise<void> {
  const flow = readFlowRuntimeFromContext(context);
  if (!flow) {
    return;
  }
  await captureE2EScreenshot(flow, {
    scope: 'operation',
    phase,
    flowName: flow.flowName,
    name: operationName,
  });
}

async function captureOperationPhaseScreenshotIfChanged(
  context: unknown,
  operationName: string,
  state: unknown,
): Promise<void> {
  const flow = readFlowRuntimeFromContext(context);
  if (!flow) return;

  const phase = readOperationPhase(state);
  if (!phase) return;

  const capturedPhaseKey = '__e2e_last_captured_phase';
  if (flow.getData<string>(capturedPhaseKey) === phase) {
    return;
  }
  flow.setData(capturedPhaseKey, phase);
  console.info(`[E2E] operation:phase ${operationName} phase=${phase}`);
  await captureE2EScreenshot(flow, {
    scope: 'phase',
    phase: 'change',
    flowName: flow.flowName,
    name: `${operationName}-${phase}`,
  });
}

function readFlowRuntimeFromContext(
  context: unknown,
): ({ setActiveOperation?: (operationName?: string) => void } & IE2EFlowRuntime) | null {
  if (!context || typeof context !== 'object' || Array.isArray(context)) return null;
  const flow = (context as { flow?: unknown }).flow;
  if (!flow || typeof flow !== 'object' || Array.isArray(flow)) return null;
  return flow as { setActiveOperation?: (operationName?: string) => void } & IE2EFlowRuntime;
}

function looksLikeOperation(value: unknown): value is { inspect: unknown } {
  return !!value && typeof value === 'object' && typeof (value as { inspect?: unknown }).inspect === 'function';
}

function readOperationLifecycleState(state: unknown): {
  state: IE2EOperationState;
  blockers: string[];
} {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new Error('[E2E] operation inspect returned an invalid state payload');
  }

  const record = state as Record<string, unknown>;
  const operationState = readOperationState(record);
  const blockers = Array.isArray(record.blockers)
    ? record.blockers.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    : [];
  return { state: operationState, blockers };
}

function readOperationPhase(state: unknown): string | null {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    return null;
  }

  const phase = (state as Record<string, unknown>).phase;
  if (typeof phase !== 'string') {
    return null;
  }

  const trimmedPhase = phase.trim();
  return trimmedPhase || null;
}

function readOperationState(record: Record<string, unknown>): IE2EOperationState {
  const state = record.state;
  if (state === 'complete' || state === 'runnable' || state === 'processing' || state === 'uiStateMismatch') {
    return state;
  }
  throw new Error('[E2E] operation inspect did not provide a valid state value');
}
