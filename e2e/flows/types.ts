import type { AnyOperation } from './operations/index.ts';

export type E2ECommandArgs = Record<string, unknown>;

export type E2ETarget = string | { testId?: string; selector?: string; index?: number };
export type E2EWaitState = 'visible' | 'hidden' | 'exists' | 'missing' | 'enabled' | 'clickable';

export interface IE2ETimeoutOptions {
  timeoutMs?: number;
}

export interface IE2EClickOptions extends IE2ETimeoutOptions {
  waitForDisappearMs?: number;
}

export interface IE2EWaitOptions extends IE2ETimeoutOptions {
  state?: E2EWaitState;
}

export interface IE2ETypeOptions extends IE2ETimeoutOptions {
  clear?: boolean;
}

export interface IE2EClipboardOptions extends IE2ETimeoutOptions {
  clear?: boolean;
}

export interface IE2ECaptureScreenshotOptions extends IE2ETimeoutOptions {
  outputPath?: string;
  name?: string;
}

export interface IE2EQueryAppOptions extends IE2ETimeoutOptions {
  args?: E2ECommandArgs;
}

export interface IE2EFlowDefinition {
  name: string;
  description: string;
  defaultTimeoutMs?: number;
  run: (runtime: IE2EFlowRuntime) => Promise<void>;
}

export interface IE2EVisibilityState {
  ok: boolean;
  visible: boolean;
  exists: boolean;
  enabled: boolean;
  clickable: boolean;
  pointerBlocker?: string | null;
  pointerReason?: string | null;
}

export interface IE2EFlowRuntime {
  flowName: string;
  input: E2ECommandArgs;
  defaultTimeoutMs: number;
  setActiveOperation: (operationName?: string) => void;
  command: <T = unknown>(command: string, args?: E2ECommandArgs) => Promise<T>;
  run: {
    <Context, State>(
      context: Context,
      operation: AnyOperation<Context, State>,
      options?: IE2ERunOperationOptions<Context>,
    ): Promise<void>;
    <Context, State>(
      operation: AnyOperation<Context, State>,
      options?: IE2ERunOperationOptions<Context>,
    ): Promise<void>;
  };
  inspect: {
    <State = unknown, Context = unknown>(operation?: AnyOperation<Context, State>): Promise<State>;
  };
  waitUntilRunnable: {
    <State = unknown, Context = unknown>(
      operation?: AnyOperation<Context, State>,
      options?: IE2EWaitUntilRunnableOptions<Context>,
    ): Promise<State>;
  };
  poll: {
    <State = unknown, Context = unknown>(
      check: (state: State) => Promise<boolean> | boolean,
      options?: IE2EPollOptions,
    ): Promise<State>;
    <State = unknown, Context = unknown>(
      operation: AnyOperation<Context, State>,
      check: (state: State) => Promise<boolean> | boolean,
      options?: IE2EPollOptions,
    ): Promise<State>;
  };
  queryApp: <T = unknown>(fn: string, options?: IE2EQueryAppOptions) => Promise<T | undefined>;
  click: (target: E2ETarget, options?: IE2EClickOptions) => Promise<void>;
  type: (target: E2ETarget, text: string, options?: IE2ETypeOptions) => Promise<void>;
  waitFor: (target: E2ETarget, options?: IE2EWaitOptions) => Promise<void>;
  isVisible: (target: E2ETarget) => Promise<IE2EVisibilityState>;
  count: (target: E2ETarget) => Promise<number>;
  getText: (target: E2ETarget, options?: IE2ETimeoutOptions) => Promise<string>;
  getAttribute: (target: E2ETarget, attribute: string, options?: IE2ETimeoutOptions) => Promise<string | null>;
  copy: (target: E2ETarget, options?: IE2ETimeoutOptions) => Promise<void>;
  paste: (target: E2ETarget, options?: IE2EClipboardOptions) => Promise<void>;
  captureScreenshot: (options?: IE2ECaptureScreenshotOptions) => Promise<string>;
  setData: (key: string, value: unknown) => void;
  getData: <T = unknown>(key: string) => T | undefined;
}

export interface IE2ERunOperationOptions<Context> {
  throwIfNotReady?: boolean;
  timeoutMs?: number;
  pollMs?: number;
  timeoutMessage?: string;
  onNotReadyPoll?: (operation: AnyOperation<Context>, context: Context, state: unknown) => Promise<void> | void;
}

export interface IE2EWaitUntilRunnableOptions<Context> {
  timeoutMs?: number;
  pollMs?: number;
  timeoutMessage?: string;
  onNotReadyPoll?: (context: Context, state: unknown) => Promise<void> | void;
}

export interface IE2EPollOptions {
  timeoutMs?: number;
  pollMs?: number;
  timeoutMessage?: string;
}

export type IE2EOperationState = 'complete' | 'runnable' | 'processing' | 'uiStateMismatch';

export interface IE2EFlowExecutionOptions {
  input?: E2ECommandArgs;
}

export interface IE2EFlowExecutionResult {
  data: E2ECommandArgs;
}

export interface IE2EOperationInspectState<ChainState = unknown, UiState = unknown> {
  chainState: ChainState;
  uiState: UiState;
  state: IE2EOperationState;
  phase?: string;
  blockers: string[];
}
