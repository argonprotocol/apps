export type E2ECommandArgs = Record<string, unknown>;

export type E2ETarget = string | { testId?: string; selector?: string; index?: number };
export type E2EWaitState = 'visible' | 'hidden' | 'exists' | 'missing' | 'enabled';

export interface E2ETimeoutOptions {
  timeoutMs?: number;
}

export interface E2EWaitOptions extends E2ETimeoutOptions {
  state?: E2EWaitState;
}

export interface E2ETypeOptions extends E2ETimeoutOptions {
  clear?: boolean;
}

export interface E2EClipboardOptions extends E2ETimeoutOptions {
  clear?: boolean;
}

export interface E2EFlowDefinition {
  name: string;
  description: string;
  defaultTimeoutMs?: number;
  run: (runtime: E2EFlowRuntime) => Promise<void>;
}

export interface E2EFlowRuntime {
  input: E2ECommandArgs;
  defaultTimeoutMs: number;
  run: <T = unknown>(command: string, args?: E2ECommandArgs) => Promise<T>;
  click: (target: E2ETarget, options?: E2ETimeoutOptions) => Promise<void>;
  type: (target: E2ETarget, text: string, options?: E2ETypeOptions) => Promise<void>;
  waitFor: (target: E2ETarget, options?: E2EWaitOptions) => Promise<void>;
  isVisible: (target: E2ETarget) => Promise<{ ok: boolean; visible: boolean; exists: boolean; enabled: boolean }>;
  count: (target: E2ETarget) => Promise<number>;
  getText: (target: E2ETarget, options?: E2ETimeoutOptions) => Promise<string>;
  getAttribute: (target: E2ETarget, attribute: string, options?: E2ETimeoutOptions) => Promise<string | null>;
  copy: (target: E2ETarget, options?: E2ETimeoutOptions) => Promise<void>;
  paste: (target: E2ETarget, options?: E2EClipboardOptions) => Promise<void>;
  setData: (key: string, value: unknown) => void;
  getData: <T = unknown>(key: string) => T | undefined;
}

export interface E2EFlowExecutionOptions {
  input?: E2ECommandArgs;
}

export interface E2EFlowExecutionResult {
  data: E2ECommandArgs;
}
