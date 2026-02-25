import type { AnyOperation } from './operations/index.ts';

export type E2ECommandArgs = Record<string, unknown>;

export type E2ETarget = string | { testId?: string; selector?: string; index?: number };
export type E2EWaitState = 'visible' | 'hidden' | 'exists' | 'missing' | 'enabled' | 'clickable';

export interface IE2ETimeoutOptions {
  timeoutMs?: number;
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

export interface IE2EFlowDefinition {
  name: string;
  description: string;
  defaultTimeoutMs?: number;
  run: (runtime: IE2EFlowRuntime) => Promise<void>;
}

export interface IE2EFlowRuntime {
  input: E2ECommandArgs;
  defaultTimeoutMs: number;
  setActiveOperation: (operationName?: string) => void;
  run: <T = unknown>(command: string, args?: E2ECommandArgs) => Promise<T>;
  runOperations: <Context>(context: Context, operations: ReadonlyArray<AnyOperation<Context>>) => Promise<void>;
  click: (target: E2ETarget, options?: IE2ETimeoutOptions) => Promise<void>;
  type: (target: E2ETarget, text: string, options?: IE2ETypeOptions) => Promise<void>;
  waitFor: (target: E2ETarget, options?: IE2EWaitOptions) => Promise<void>;
  isVisible: (target: E2ETarget) => Promise<{ ok: boolean; visible: boolean; exists: boolean; enabled: boolean }>;
  count: (target: E2ETarget) => Promise<number>;
  getText: (target: E2ETarget, options?: IE2ETimeoutOptions) => Promise<string>;
  getAttribute: (target: E2ETarget, attribute: string, options?: IE2ETimeoutOptions) => Promise<string | null>;
  copy: (target: E2ETarget, options?: IE2ETimeoutOptions) => Promise<void>;
  paste: (target: E2ETarget, options?: IE2EClipboardOptions) => Promise<void>;
  captureScreenshot: (options?: IE2ECaptureScreenshotOptions) => Promise<string>;
  setData: (key: string, value: unknown) => void;
  getData: <T = unknown>(key: string) => T | undefined;
}

export interface IE2EFlowExecutionOptions {
  input?: E2ECommandArgs;
}

export interface IE2EFlowExecutionResult {
  data: E2ECommandArgs;
}

export interface IE2EOperationInspectState<ChainState = unknown, UiState = unknown> {
  chainState: ChainState;
  uiState: UiState;
  isRunnable: boolean;
  isComplete: boolean;
  blockers: string[];
}
