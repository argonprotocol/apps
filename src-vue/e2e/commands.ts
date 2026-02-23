import { getConfig } from '../stores/config';
import { getMiningFrames } from '../stores/mainchain';

type UnknownRecord = Record<string, unknown>;
export const LOGGABLE_ARG_KEYS = ['testId', 'selector', 'state', 'timeoutMs', 'index', 'attribute'] as const;

type WaitState = 'visible' | 'hidden' | 'exists' | 'missing' | 'enabled' | 'clickable';

interface ElementTarget {
  testId?: string;
  selector?: string;
  index?: number;
}

interface CommandContext {
  session: string;
  emit?: (payload: UnknownRecord) => void;
}

interface WaitForStateOptions {
  suppressStatusClear?: boolean;
  suppressVisualWait?: boolean;
}

interface HitTestPoint {
  x: number;
  y: number;
  label: string;
}

interface PointerInteractableResult {
  clickable: boolean;
  point: { x: number; y: number } | null;
  pointLabel: string | null;
  hit: Element | null;
  hitLabel: string | null;
  reason: string | null;
}

class CommandError extends Error {
  code: string;
  details?: UnknownRecord;

  constructor(code: string, message: string, details?: UnknownRecord) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_INTERVAL_MS = 50;
const DEFAULT_READY_TIMEOUT_MS = 45_000;
const MAX_TIMEOUT_MS = 300_000;
const VISUAL_MOVE_MS = 140;
const VISUAL_HIGHLIGHT_MS = 280;
const VISUAL_STEP_DELAY_MS = 80;
const VISUAL_WAIT_UPDATE_MS = 250;
const WAIT_PROGRESS_EMIT_MS = 1_000;
const VISUAL_STATUS_CLEAR_MS = 900;
const VISUAL_LABEL_MAX_LENGTH = 100;
const VISUAL_STATUS_MAX_LENGTH = 220;
const HIT_TEST_EDGE_INSET_PX = 6;
let inMemoryClipboard = '';
let appReadyPromise: Promise<void> | null = null;
type E2EWindow = Window & {
  __ARGON_E2E_CLIPBOARD__?: string;
  __ARGON_E2E_VISUALS__?: boolean;
};
type VisualState = {
  root: HTMLDivElement;
  cursor: HTMLDivElement;
  highlight: HTMLDivElement;
  label: HTMLDivElement;
  status: HTMLDivElement;
  hideTimer: ReturnType<typeof setTimeout> | null;
};
let visualState: VisualState | null = null;
let activeCommandLabel = '';
let statusClearTimer: ReturnType<typeof setTimeout> | null = null;
const QUIET_VISUAL_COMMANDS = new Set(['ui.getAttribute', 'ui.count', 'ui.isVisible']);
type CursorVisualMode = 'click' | 'wait';

function setCursorMode(state: VisualState, mode: CursorVisualMode): void {
  if (mode === 'click') {
    Object.assign(state.cursor.style, {
      width: '18px',
      height: '24px',
      transform: 'translate(-2px, -2px)',
      borderRadius: '0',
      clipPath: 'polygon(0 0, 0 100%, 34% 72%, 50% 100%, 62% 94%, 48% 64%, 80% 64%)',
      border: '1px solid #0f172a',
      background: 'linear-gradient(145deg, #f8fafc 0%, #e2e8f0 65%, #cbd5e1 100%)',
      boxShadow: '0 2px 8px rgba(15, 23, 42, 0.35)',
    });
    state.cursor.style.animation = 'none';
    return;
  }

  Object.assign(state.cursor.style, {
    width: '18px',
    height: '18px',
    transform: 'translate(-50%, -50%)',
    borderRadius: '9999px',
    clipPath: 'none',
    border: '2px solid rgba(226, 232, 240, 0.75)',
    background: 'rgba(56, 189, 248, 0.14)',
    boxShadow: '0 0 0 3px rgba(56, 189, 248, 0.28), 0 2px 8px rgba(15, 23, 42, 0.25)',
  });
  Object.assign(state.cursor.style, {
    animation: 'argon-e2e-wait 900ms linear infinite',
  });
}

function setFallbackClipboard(text: string): void {
  inMemoryClipboard = text;
  (window as E2EWindow).__ARGON_E2E_CLIPBOARD__ = text;
}

function getFallbackClipboard(): string {
  const clipboard = (window as E2EWindow).__ARGON_E2E_CLIPBOARD__;
  if (typeof clipboard === 'string') {
    inMemoryClipboard = clipboard;
    return clipboard;
  }
  return inMemoryClipboard;
}

function isVisualsEnabled(): boolean {
  return (window as E2EWindow).__ARGON_E2E_VISUALS__ !== false;
}

function ensureVisualState(): VisualState | null {
  if (!isVisualsEnabled() || !document.body) return null;
  if (visualState) return visualState;

  const styleId = 'argon-e2e-visual-styles';
  if (!document.getElementById(styleId)) {
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
@keyframes argon-e2e-wait {
  0% {
    box-shadow: 0 0 0 0 rgba(56, 189, 248, 0.16), 0 2px 8px rgba(15, 23, 42, 0.25);
  }
  50% {
    box-shadow: 0 0 0 4px rgba(56, 189, 248, 0.32), 0 2px 8px rgba(15, 23, 42, 0.25);
  }
  100% {
    box-shadow: 0 0 0 0 rgba(56, 189, 248, 0.16), 0 2px 8px rgba(15, 23, 42, 0.25);
  }
}`;
    (document.head ?? document.body).append(style);
  }

  const root = document.createElement('div');
  root.setAttribute('data-argon-e2e-visual', 'true');
  Object.assign(root.style, {
    position: 'fixed',
    inset: '0',
    pointerEvents: 'none',
    zIndex: '2147483647',
  });

  const cursor = document.createElement('div');
  Object.assign(cursor.style, {
    position: 'fixed',
    left: '0px',
    top: '0px',
    width: '18px',
    height: '24px',
    transform: 'translate(-2px, -2px)',
    clipPath: 'polygon(0 0, 0 100%, 34% 72%, 50% 100%, 62% 94%, 48% 64%, 80% 64%)',
    border: '1px solid #0f172a',
    background: 'linear-gradient(145deg, #f8fafc 0%, #e2e8f0 65%, #cbd5e1 100%)',
    boxShadow: '0 2px 8px rgba(15, 23, 42, 0.35)',
    transition: `left ${VISUAL_MOVE_MS}ms ease, top ${VISUAL_MOVE_MS}ms ease, opacity 120ms ease`,
    opacity: '0',
  });

  const highlight = document.createElement('div');
  Object.assign(highlight.style, {
    position: 'fixed',
    left: '0px',
    top: '0px',
    width: '0px',
    height: '0px',
    borderRadius: '6px',
    border: '2px solid #f97316',
    background: 'rgba(249, 115, 22, 0.12)',
    boxShadow: '0 0 0 4px rgba(249, 115, 22, 0.14)',
    transition: 'left 120ms ease, top 120ms ease, width 120ms ease, height 120ms ease, opacity 180ms ease',
    opacity: '0',
  });

  const label = document.createElement('div');
  Object.assign(label.style, {
    position: 'fixed',
    left: '0px',
    top: '0px',
    transform: 'translate(12px, 14px)',
    borderRadius: '4px',
    padding: '2px 6px',
    background: 'rgba(2, 6, 23, 0.9)',
    color: '#f8fafc',
    fontFamily: 'ui-monospace, Menlo, monospace',
    fontSize: '11px',
    lineHeight: '14px',
    whiteSpace: 'nowrap',
    transition: `left ${VISUAL_MOVE_MS}ms ease, top ${VISUAL_MOVE_MS}ms ease, opacity 120ms ease`,
    opacity: '0',
  });

  const status = document.createElement('div');
  Object.assign(status.style, {
    position: 'fixed',
    left: '16px',
    bottom: '16px',
    maxWidth: 'min(78vw, 960px)',
    borderRadius: '8px',
    border: '1px solid rgba(56, 189, 248, 0.55)',
    padding: '7px 11px',
    background: 'rgba(2, 6, 23, 0.94)',
    color: '#f8fafc',
    fontFamily: 'ui-monospace, Menlo, monospace',
    fontSize: '12px',
    lineHeight: '17px',
    whiteSpace: 'normal',
    wordBreak: 'break-word',
    boxShadow: '0 3px 16px rgba(2, 6, 23, 0.35)',
    transition: 'opacity 120ms ease',
    opacity: '0',
  });

  root.append(highlight, cursor, label, status);
  document.body.append(root);
  visualState = { root, cursor, highlight, label, status, hideTimer: null };
  setCursorMode(visualState, 'click');
  return visualState;
}

function positionVisuals(point: { x: number; y: number }, text: string, mode: CursorVisualMode = 'click'): void {
  const state = ensureVisualState();
  if (!state) return;

  setCursorMode(state, mode);
  state.cursor.style.left = `${point.x}px`;
  state.cursor.style.top = `${point.y}px`;
  state.cursor.style.opacity = '1';

  state.label.textContent = text;
  state.label.style.left = `${point.x}px`;
  state.label.style.top = `${point.y}px`;
  state.label.style.opacity = '1';

  scheduleActionVisualHide(state);
}

function scheduleActionVisualHide(state: VisualState): void {
  if (state.hideTimer) {
    clearTimeout(state.hideTimer);
  }
  state.hideTimer = setTimeout(() => {
    if (!visualState) return;
    state.cursor.style.opacity = '0';
    state.highlight.style.opacity = '0';
    state.label.style.opacity = '0';
    state.hideTimer = null;
  }, VISUAL_HIGHLIGHT_MS);
}

function hideVisuals(): void {
  if (!visualState) return;
  if (visualState.hideTimer) {
    clearTimeout(visualState.hideTimer);
    visualState.hideTimer = null;
  }
  visualState.cursor.style.opacity = '0';
  visualState.highlight.style.opacity = '0';
  visualState.label.style.opacity = '0';
  visualState.status.style.opacity = '0';
}

function truncateLabel(text: string, maxLength = VISUAL_LABEL_MAX_LENGTH): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
}

const WAIT_STATUS_PREFIX = '⏳ ';

function setWaitStatusText(text: string, mode: CursorVisualMode = 'click'): void {
  const state = ensureVisualState();
  if (!state) return;
  if (statusClearTimer) {
    clearTimeout(statusClearTimer);
    statusClearTimer = null;
  }
  const prefix = mode === 'wait' ? WAIT_STATUS_PREFIX : '';
  state.status.textContent = truncateLabel(`${prefix}${text}`, VISUAL_STATUS_MAX_LENGTH);
  state.status.style.opacity = '1';
}

function clearWaitStatusText(): void {
  if (statusClearTimer) {
    clearTimeout(statusClearTimer);
    statusClearTimer = null;
  }
  if (!visualState) return;
  visualState.status.style.opacity = '0';
}

function clearWaitStatusTextSoon(delayMs = VISUAL_STATUS_CLEAR_MS): void {
  if (statusClearTimer) {
    clearTimeout(statusClearTimer);
  }
  statusClearTimer = setTimeout(() => {
    if (!visualState) return;
    visualState.status.style.opacity = '0';
    statusClearTimer = null;
  }, delayMs);
}

function positionHighlight(element: HTMLElement): VisualState | null {
  const state = ensureVisualState();
  if (!state) return null;

  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;

  state.highlight.style.left = `${rect.left}px`;
  state.highlight.style.top = `${rect.top}px`;
  state.highlight.style.width = `${rect.width}px`;
  state.highlight.style.height = `${rect.height}px`;
  return state;
}

function showHighlight(element: HTMLElement): void {
  const state = positionHighlight(element);
  if (!state) return;
  state.highlight.style.opacity = '1';
  scheduleActionVisualHide(state);
}

function flashHighlight(element: HTMLElement): void {
  const state = positionHighlight(element);
  if (!state) return;
  state.highlight.style.opacity = '1';
}

function getElementCenter(element: HTMLElement): { x: number; y: number } | null {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
  };
}

async function visualizeAction(
  element: HTMLElement | null,
  text: string,
  mode: CursorVisualMode = 'click',
): Promise<void> {
  if (!element) return;
  const point = getElementCenter(element);
  if (!point) return;
  positionVisuals(point, text, mode);
  flashHighlight(element);
  await sleep(VISUAL_STEP_DELAY_MS);
}

function visualizeWait(target: ElementTarget, state: WaitState, element: HTMLElement | null, _elapsedMs: number): void {
  const targetLabel = getTargetLabel(target);
  const label = truncateLabel(`waiting ${state}: ${targetLabel}`);
  const pointer = element ? getPointerInteractableResult(element) : null;
  const blockerInfo = pointer && !pointer.clickable ? (pointer.hitLabel ?? pointer.reason ?? 'unknown') : '';
  const commandPrefix = activeCommandLabel ? `Waiting: ${activeCommandLabel} | ` : '';
  setWaitStatusText(
    `${commandPrefix}waiting for ${state}: ${targetLabel}${blockerInfo ? ` | blocked by ${blockerInfo}` : ''}`,
    'wait',
  );
  const point = element ? getElementCenter(element) : null;
  const fallbackPoint = {
    x: Math.max(24, Math.min(window.innerWidth - 24, window.innerWidth / 2)),
    y: Math.max(24, Math.min(window.innerHeight - 24, Math.max(64, window.innerHeight * 0.18))),
  };

  positionVisuals(point ?? fallbackPoint, label, 'wait');
  if (element && point) {
    showHighlight(element);
    return;
  }

  const stateVisual = ensureVisualState();
  if (!stateVisual) return;
  stateVisual.highlight.style.opacity = '0';
}

function asObject(value: unknown, command: string): UnknownRecord {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as UnknownRecord;
  }
  throw new CommandError('invalid_args', `Command '${command}' expects an object payload`);
}

function summarizeCommandArgs(args: unknown): string {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return '';
  const source = args as UnknownRecord;
  const parts: string[] = [];
  for (const key of LOGGABLE_ARG_KEYS) {
    if (source[key] == null) continue;

    parts.push(`${key}=${String(source[key])}`);
  }
  if (typeof source.text === 'string') {
    parts.push(`textLength=${source.text.length}`);
  }
  return parts.join(' ');
}

function getTargetFromArgs(args: UnknownRecord): ElementTarget | null {
  const testId = typeof args.testId === 'string' && args.testId ? args.testId : undefined;
  const selector = typeof args.selector === 'string' && args.selector ? args.selector : undefined;
  const index =
    typeof args.index === 'number' && Number.isInteger(args.index) && args.index >= 0 ? args.index : undefined;
  if (!testId && !selector) return null;
  return { testId, selector, index };
}

function getTargetLabelFromArgs(args: UnknownRecord): string | null {
  const target = getTargetFromArgs(args);
  if (!target) return null;
  return getTargetLabel(target);
}

function describeCommand(command: string, argsInput: unknown): string {
  const args =
    argsInput && typeof argsInput === 'object' && !Array.isArray(argsInput)
      ? (argsInput as UnknownRecord)
      : ({} as UnknownRecord);
  const targetLabel = getTargetLabelFromArgs(args);
  const state = typeof args.state === 'string' ? args.state : null;
  const attribute = typeof args.attribute === 'string' ? args.attribute : null;
  const pieces: string[] = [];

  switch (command) {
    case 'ui.waitFor':
      pieces.push('waitFor');
      if (state) pieces.push(state);
      if (targetLabel) pieces.push(targetLabel);
      break;
    case 'ui.click':
      pieces.push('click');
      if (targetLabel) pieces.push(targetLabel);
      break;
    case 'ui.type':
      pieces.push('type');
      if (targetLabel) pieces.push(targetLabel);
      if (typeof args.text === 'string') pieces.push(`textLength=${args.text.length}`);
      break;
    case 'ui.copy':
      pieces.push('copy');
      if (targetLabel) pieces.push(targetLabel);
      break;
    case 'ui.paste':
      pieces.push('paste');
      if (targetLabel) pieces.push(targetLabel);
      break;
    case 'ui.getText':
      pieces.push('getText');
      if (targetLabel) pieces.push(targetLabel);
      break;
    case 'ui.getAttribute':
      pieces.push('getAttribute');
      if (attribute) pieces.push(attribute);
      if (targetLabel) pieces.push(targetLabel);
      break;
    case 'ui.count':
      pieces.push('count');
      if (targetLabel) pieces.push(targetLabel);
      break;
    case 'ui.isVisible':
      pieces.push('isVisible');
      if (targetLabel) pieces.push(targetLabel);
      break;
    case 'clipboard.write':
      pieces.push('clipboard.write');
      if (typeof args.text === 'string') pieces.push(`textLength=${args.text.length}`);
      break;
    case 'clipboard.read':
      pieces.push('clipboard.read');
      break;
    default: {
      pieces.push(command);
      const summary = summarizeCommandArgs(args);
      if (summary) pieces.push(summary);
      break;
    }
  }

  return pieces.join(' ');
}

function summarizeCommandResult(result: unknown): string {
  if (result == null) return 'result=null';
  if (typeof result !== 'object' || Array.isArray(result)) {
    return `result=${String(result)}`;
  }
  const source = result as UnknownRecord;
  const parts: string[] = [];
  for (const key of [
    'target',
    'state',
    'attribute',
    'count',
    'visible',
    'exists',
    'enabled',
    'textLength',
    'backend',
  ]) {
    if (source[key] == null) continue;

    parts.push(`${key}=${String(source[key])}`);
  }
  if (typeof source.value === 'string') {
    const clipped = source.value.length > 60 ? `${source.value.slice(0, 59)}…` : source.value;
    parts.push(`value=${clipped}`);
  } else if (source.value == null) {
    parts.push('value=null');
  }
  if (typeof source.address === 'string') {
    const clipped = source.address.length > 22 ? `${source.address.slice(0, 22)}…` : source.address;
    parts.push(`address=${clipped}`);
  }
  if (!parts.length) {
    parts.push(`keys=${Object.keys(source).join(',')}`);
  }
  return parts.join(' ');
}

function shouldShowVisualCommandStatus(command: string): boolean {
  return command.startsWith('ui.') || command.startsWith('clipboard.') || command === 'app.waitForReady';
}

function getCommandStatusVerb(command: string, phase: 'start' | 'success' | 'error', quiet = false): string {
  if (command === 'ui.waitFor') {
    if (phase === 'start') return 'Waiting';
    if (phase === 'success') return 'Wait complete';
    return 'Wait failed';
  }
  if (command === 'ui.click') {
    if (phase === 'start') return 'Clicking';
    if (phase === 'success') return 'Clicked';
    return 'Click failed';
  }
  if (quiet) {
    return phase === 'error' ? 'Failed' : 'Polling';
  }
  if (phase === 'start') return 'Running';
  if (phase === 'success') return 'Done';
  return 'Failed';
}

function getCommandStatusTargetLabel(command: string, commandLabel: string): string {
  if (command === 'ui.click') {
    const trimmed = commandLabel.replace(/^click\s*/, '');
    return trimmed || commandLabel;
  }
  return commandLabel;
}

function getString(value: unknown, field: string, required = true, allowEmpty = false): string | undefined {
  if (value == null || (!allowEmpty && value === '')) {
    if (required) {
      throw new CommandError('invalid_args', `Missing '${field}'`);
    }
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new CommandError('invalid_args', `'${field}' must be a string`);
  }
  return value;
}

function getTimeoutMs(value: unknown, field: string, fallback: number): number {
  if (value == null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || Number.isNaN(value) || value < 0) {
    throw new CommandError('invalid_args', `'${field}' must be a finite non-negative number`);
  }
  return Math.min(value, MAX_TIMEOUT_MS);
}

function getBoolean(value: unknown, field: string, fallback: boolean): boolean {
  if (value == null) return fallback;
  if (typeof value !== 'boolean') {
    throw new CommandError('invalid_args', `'${field}' must be a boolean`);
  }
  return value;
}

function getWaitState(value: unknown): WaitState {
  if (value == null) return 'visible';
  if (
    value === 'visible' ||
    value === 'hidden' ||
    value === 'exists' ||
    value === 'missing' ||
    value === 'enabled' ||
    value === 'clickable'
  ) {
    return value;
  }
  throw new CommandError(
    'invalid_args',
    `'state' must be one of: visible, hidden, exists, missing, enabled, clickable`,
  );
}

function getTarget(args: UnknownRecord): ElementTarget {
  const testId = getString(args.testId, 'testId', false);
  const selector = getString(args.selector, 'selector', false);
  const indexValue = args.index;
  let index: number | undefined;
  if (indexValue != null) {
    if (typeof indexValue !== 'number' || !Number.isInteger(indexValue) || indexValue < 0) {
      throw new CommandError('invalid_args', `'index' must be a non-negative integer`);
    }
    index = indexValue;
  }
  if (!testId && !selector) {
    throw new CommandError('invalid_args', `Either 'testId' or 'selector' is required`);
  }
  return { testId, selector, index };
}

function getTargetLabel(target: ElementTarget): string {
  const base = target.testId ? `testId:${target.testId}` : `selector:${target.selector}`;
  return target.index != null ? `${base}[${target.index}]` : base;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return promise;
  }
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(new CommandError('timeout', `Timed out waiting for ${label}`, { timeoutMs, label }));
    }, timeoutMs);
    promise
      .then(value => {
        window.clearTimeout(timer);
        resolve(value);
      })
      .catch(error => {
        window.clearTimeout(timer);
        reject(error);
      });
  });
}

async function waitForAppReady(timeoutMs = DEFAULT_READY_TIMEOUT_MS): Promise<void> {
  if (!appReadyPromise) {
    appReadyPromise = (async () => {
      const config = getConfig();
      await withTimeout(config.isLoadedPromise, timeoutMs, 'config');

      // Mining frame history can take much longer than basic UI readiness.
      // Start it in the background so test commands can proceed once config is ready.
      const miningFrames = getMiningFrames();
      void miningFrames.load().catch(error => {
        console.warn('[E2E] Background miningFrames.load failed', error);
      });
    })();
  }
  try {
    await withTimeout(appReadyPromise, timeoutMs, 'app ready');
  } catch (error) {
    appReadyPromise = null;
    throw error;
  }
}

async function ensureAppReadyForUi(timeoutMs: number): Promise<void> {
  try {
    await waitForAppReady(timeoutMs);
  } catch (error) {
    // During startup, network/store initialization can briefly fail or stall.
    // UI commands should still proceed and rely on element-level timeouts.
    console.warn('[E2E] App readiness check failed; continuing ui command', error);
  }
}

function isVisible(element: HTMLElement): boolean {
  if (!element.isConnected) {
    return false;
  }

  const hiddenAncestor = element.closest('[aria-hidden="true"], [inert]');
  if (hiddenAncestor) {
    return false;
  }

  const style = window.getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
    return false;
  }
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function isEnabled(element: HTMLElement): boolean {
  if ('disabled' in element && (element as HTMLInputElement).disabled) {
    return false;
  }
  const ariaDisabled = element.getAttribute('aria-disabled');
  return ariaDisabled !== 'true';
}

function describeElementForLog(element: Element | null): string | null {
  if (!element) return null;
  const tag = element.tagName.toLowerCase();
  const id = element.id ? `#${element.id}` : '';
  const className = element.className;
  const classes =
    typeof className === 'string'
      ? className
          .trim()
          .split(/\s+/)
          .filter(Boolean)
          .slice(0, 3)
          .map(x => `.${x}`)
          .join('')
      : '';
  const testId = element.getAttribute('data-testid');
  const testIdLabel = testId ? `[data-testid="${testId}"]` : '';
  return `${tag}${id}${classes}${testIdLabel}`;
}

function getHitTestPoints(element: HTMLElement): HitTestPoint[] {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return [];

  const insetX = Math.min(HIT_TEST_EDGE_INSET_PX, rect.width / 3);
  const insetY = Math.min(HIT_TEST_EDGE_INSET_PX, rect.height / 3);
  const left = rect.left + insetX;
  const right = rect.right - insetX;
  const top = rect.top + insetY;
  const bottom = rect.bottom - insetY;
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  const points: HitTestPoint[] = [
    { label: 'center', x: centerX, y: centerY },
    { label: 'mid-left', x: left, y: centerY },
    { label: 'mid-right', x: right, y: centerY },
    { label: 'mid-top', x: centerX, y: top },
    { label: 'mid-bottom', x: centerX, y: bottom },
    { label: 'top-left', x: left, y: top },
    { label: 'top-right', x: right, y: top },
    { label: 'bottom-left', x: left, y: bottom },
    { label: 'bottom-right', x: right, y: bottom },
  ];

  return points
    .map(point => ({
      ...point,
      x: Math.min(Math.max(point.x, 0), Math.max(window.innerWidth - 1, 0)),
      y: Math.min(Math.max(point.y, 0), Math.max(window.innerHeight - 1, 0)),
    }))
    .filter(point => Number.isFinite(point.x) && Number.isFinite(point.y));
}

function isHitWithinElement(element: HTMLElement, hit: Element): boolean {
  if (hit === element) return true;
  if (element.contains(hit)) return true;
  return hit.contains(element);
}

function getPointerInteractableResult(element: HTMLElement): PointerInteractableResult {
  if (!isVisible(element)) {
    return {
      clickable: false,
      point: null,
      pointLabel: null,
      hit: null,
      hitLabel: null,
      reason: 'not_visible',
    };
  }

  if (!isEnabled(element)) {
    return {
      clickable: false,
      point: null,
      pointLabel: null,
      hit: null,
      hitLabel: null,
      reason: 'disabled',
    };
  }

  if (window.getComputedStyle(element).pointerEvents === 'none') {
    return {
      clickable: false,
      point: null,
      pointLabel: null,
      hit: element,
      hitLabel: describeElementForLog(element),
      reason: 'pointer_events_none',
    };
  }

  const points = getHitTestPoints(element);
  if (!points.length) {
    return {
      clickable: false,
      point: null,
      pointLabel: null,
      hit: null,
      hitLabel: null,
      reason: 'no_hit_points',
    };
  }

  let blocker: { point: HitTestPoint; hit: Element | null } | null = null;
  for (const point of points) {
    const hit = document.elementFromPoint(point.x, point.y);
    if (!hit) {
      if (!blocker) {
        blocker = { point, hit: null };
      }
      continue;
    }

    if (isHitWithinElement(element, hit)) {
      return {
        clickable: true,
        point: { x: point.x, y: point.y },
        pointLabel: point.label,
        hit,
        hitLabel: describeElementForLog(hit),
        reason: null,
      };
    }

    if (!blocker) {
      blocker = { point, hit };
    }
  }

  return {
    clickable: false,
    point: blocker ? { x: blocker.point.x, y: blocker.point.y } : null,
    pointLabel: blocker?.point.label ?? null,
    hit: blocker?.hit ?? null,
    hitLabel: describeElementForLog(blocker?.hit ?? null),
    reason: blocker?.hit ? 'intercepted' : 'offscreen_or_no_hit',
  };
}

function isPointerInteractable(element: HTMLElement): boolean {
  return getPointerInteractableResult(element).clickable;
}

function findAllByTestId(testId: string): HTMLElement[] {
  const nodes = document.querySelectorAll<HTMLElement>('[data-testid]');
  const matches: HTMLElement[] = [];
  for (const node of nodes) {
    if (node.getAttribute('data-testid') === testId) matches.push(node);
  }
  return matches;
}

function resolveElements(target: ElementTarget): HTMLElement[] {
  if (target.selector) {
    return [...document.querySelectorAll<HTMLElement>(target.selector)];
  }
  if (target.testId) {
    return findAllByTestId(target.testId);
  }
  return [];
}

function resolveElement(target: ElementTarget): HTMLElement | null {
  if (target.index != null) {
    return resolveElements(target)[target.index] ?? null;
  }
  if (target.selector) {
    return document.querySelector<HTMLElement>(target.selector);
  }
  if (target.testId) {
    const matches = findAllByTestId(target.testId);
    if (matches.length === 0) return null;
    for (const match of matches) {
      if (isVisible(match)) return match;
    }
    return matches[0] ?? null;
  }
  return null;
}

function isStateSatisfied(state: WaitState, element: HTMLElement | null): boolean {
  switch (state) {
    case 'visible':
      return !!element && isVisible(element);
    case 'hidden':
      return !!element && !isVisible(element);
    case 'exists':
      return !!element;
    case 'missing':
      return !element;
    case 'enabled':
      return !!element && isVisible(element) && isEnabled(element);
    case 'clickable':
      return !!element && isPointerInteractable(element);
    default:
      return false;
  }
}

async function waitForState(
  target: ElementTarget,
  state: WaitState,
  timeoutMs: number,
  onProgress?: (elapsedMs: number, element: HTMLElement | null) => void,
  options?: WaitForStateOptions,
): Promise<HTMLElement | null> {
  const start = Date.now();
  let nextVisualUpdateAt = 0;
  let nextProgressEmitAt = 0;
  while (Date.now() - start <= timeoutMs) {
    const now = Date.now();
    const element = resolveElement(target);
    if (isStateSatisfied(state, element)) {
      if (!options?.suppressStatusClear) {
        clearWaitStatusText();
      }
      onProgress?.(now - start, element);
      return element;
    }
    if (!options?.suppressVisualWait && now >= nextVisualUpdateAt) {
      visualizeWait(target, state, element, now - start);
      nextVisualUpdateAt = now + VISUAL_WAIT_UPDATE_MS;
    }
    if (onProgress && now >= nextProgressEmitAt) {
      onProgress(now - start, element);
      nextProgressEmitAt = now + WAIT_PROGRESS_EMIT_MS;
    }
    await sleep(DEFAULT_INTERVAL_MS);
  }
  const label = getTargetLabel(target);
  throw new CommandError('timeout', `Timed out waiting for ${state} on ${label}`, {
    timeoutMs,
    state,
    target: label,
  });
}

function emitInputEvents(element: HTMLElement): void {
  element.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true }));
  element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
}

interface EventCoordinates {
  clientX: number;
  clientY: number;
  screenX: number;
  screenY: number;
}

function getElementEventCoordinates(element: HTMLElement): EventCoordinates {
  const rect = element.getBoundingClientRect();
  const offsetX = rect.width > 2 ? rect.width / 2 : 1;
  const offsetY = rect.height > 2 ? rect.height / 2 : 1;
  const clientX = rect.left + offsetX;
  const clientY = rect.top + offsetY;
  return {
    clientX,
    clientY,
    screenX: window.screenX + clientX,
    screenY: window.screenY + clientY,
  };
}

function dispatchPointerEvent(
  element: HTMLElement,
  type: 'pointermove' | 'pointerdown' | 'pointerup',
  coordinates: EventCoordinates,
): void {
  if (typeof PointerEvent === 'undefined') return;
  const isDown = type === 'pointerdown';
  element.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      pointerType: 'mouse',
      pointerId: 1,
      isPrimary: true,
      button: 0,
      buttons: isDown ? 1 : 0,
      clientX: coordinates.clientX,
      clientY: coordinates.clientY,
      screenX: coordinates.screenX,
      screenY: coordinates.screenY,
      view: window,
    }),
  );
}

function dispatchMouseEvent(
  element: HTMLElement,
  type: 'mousemove' | 'mousedown' | 'mouseup' | 'click',
  coordinates: EventCoordinates,
): boolean {
  const isDown = type === 'mousedown';
  return element.dispatchEvent(
    new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      button: 0,
      buttons: isDown ? 1 : 0,
      detail: type === 'mousemove' ? 0 : 1,
      clientX: coordinates.clientX,
      clientY: coordinates.clientY,
      screenX: coordinates.screenX,
      screenY: coordinates.screenY,
    }),
  );
}

function dispatchClick(element: HTMLElement): void {
  const coordinates = getElementEventCoordinates(element);
  dispatchPointerEvent(element, 'pointermove', coordinates);
  dispatchMouseEvent(element, 'mousemove', coordinates);
  dispatchPointerEvent(element, 'pointerdown', coordinates);
  dispatchMouseEvent(element, 'mousedown', coordinates);
  dispatchPointerEvent(element, 'pointerup', coordinates);
  dispatchMouseEvent(element, 'mouseup', coordinates);
  dispatchMouseEvent(element, 'click', coordinates);
}

function setElementValue(element: HTMLElement, text: string, clear: boolean): void {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    const nextValue = clear ? text : `${element.value}${text}`;
    element.focus();
    element.value = nextValue;
    emitInputEvents(element);
    return;
  }

  if (element.isContentEditable) {
    const nextValue = clear ? text : `${element.textContent ?? ''}${text}`;
    element.focus();
    element.textContent = nextValue;
    emitInputEvents(element);
    return;
  }

  throw new CommandError('invalid_target', 'Target is not an editable field');
}

function getElementText(element: HTMLElement): string {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    return element.value;
  }
  return element.textContent?.trim() ?? '';
}

function getSessionFromArgs(args: UnknownRecord): string | undefined {
  return getString(args.session, 'session', false);
}

async function writeClipboard(text: string): Promise<{ backend: 'navigator' | 'memory' }> {
  setFallbackClipboard(text);
  try {
    await navigator.clipboard.writeText(text);
    return { backend: 'navigator' };
  } catch (error) {
    console.warn('[E2E] navigator.clipboard.writeText failed; using in-memory fallback', error);
    return { backend: 'memory' };
  }
}

async function readClipboard(): Promise<{ text: string; backend: 'navigator' | 'memory' }> {
  try {
    const text = await navigator.clipboard.readText();
    setFallbackClipboard(text);
    return { text, backend: 'navigator' };
  } catch (error) {
    console.warn('[E2E] navigator.clipboard.readText failed; using in-memory fallback', error);
    return { text: getFallbackClipboard(), backend: 'memory' };
  }
}

async function runCommandInternal(command: string, argsInput: unknown, context: CommandContext): Promise<unknown> {
  const args = asObject(argsInput ?? {}, command);
  const commandLabel = describeCommand(command, args);
  const targetSession = getSessionFromArgs(args);
  if (targetSession && targetSession !== context.session) {
    throw new CommandError('session_mismatch', `Command session '${targetSession}' does not match active session`);
  }

  const buildProgressEmitter = (target: ElementTarget, state: WaitState) => {
    return (elapsedMs: number, element: HTMLElement | null): void => {
      if (!context.emit) return;
      const pointer = element ? getPointerInteractableResult(element) : null;
      context.emit({
        type: 'client.event',
        event: 'ui.wait.progress',
        command,
        commandLabel,
        target: getTargetLabel(target),
        state,
        elapsedMs: Math.round(elapsedMs),
        exists: !!element,
        visible: !!element && isVisible(element),
        enabled: !!element && isEnabled(element),
        targetElement: element ? describeElementForLog(element) : null,
        clickable: pointer?.clickable ?? false,
        pointerBlocker: pointer && !pointer.clickable ? (pointer.hitLabel ?? pointer.reason ?? null) : null,
        pointerReason: pointer && !pointer.clickable ? pointer.reason : null,
        pointerPoint:
          pointer?.point && pointer.pointLabel
            ? `${Math.round(pointer.point.x)},${Math.round(pointer.point.y)}@${pointer.pointLabel}`
            : null,
        pointerHit: pointer?.hitLabel ?? null,
      });
    };
  };

  if (command.startsWith('ui.')) {
    const readyTimeoutMs = getTimeoutMs(args.readyTimeoutMs, 'readyTimeoutMs', DEFAULT_READY_TIMEOUT_MS);
    await ensureAppReadyForUi(readyTimeoutMs);
  }

  if (command === 'app.waitForReady') {
    const timeoutMs = getTimeoutMs(args.timeoutMs, 'timeoutMs', DEFAULT_READY_TIMEOUT_MS);
    await waitForAppReady(timeoutMs);
    return { ok: true };
  }

  if (command === 'ui.waitFor') {
    const target = getTarget(args);
    const state = getWaitState(args.state);
    const timeoutMs = getTimeoutMs(args.timeoutMs, 'timeoutMs', DEFAULT_TIMEOUT_MS);
    const element = await waitForState(target, state, timeoutMs, buildProgressEmitter(target, state));
    if (state !== 'missing') {
      await visualizeAction(element, `waitFor:${state}`, 'wait');
    } else {
      hideVisuals();
    }
    return { ok: true, state, target: getTargetLabel(target) };
  }

  if (command === 'ui.isVisible') {
    const target = getTarget(args);
    const element = resolveElement(target);
    return {
      ok: true,
      target: getTargetLabel(target),
      exists: !!element,
      visible: isStateSatisfied('visible', element),
      enabled: !!element && isEnabled(element),
    };
  }

  if (command === 'ui.count') {
    const target = getTarget(args);
    if (target.index != null) {
      return {
        ok: true,
        target: getTargetLabel(target),
        count: resolveElement(target) ? 1 : 0,
      };
    }
    return {
      ok: true,
      target: getTargetLabel(target),
      count: resolveElements(target).length,
    };
  }

  if (command === 'ui.click') {
    const target = getTarget(args);
    const timeoutMs = getTimeoutMs(args.timeoutMs, 'timeoutMs', DEFAULT_TIMEOUT_MS);
    const startedAt = Date.now();
    const visibleElement = await waitForState(target, 'visible', timeoutMs, buildProgressEmitter(target, 'visible'));
    if (!visibleElement) {
      throw new CommandError('not_found', `Target ${getTargetLabel(target)} not found`);
    }
    visibleElement.scrollIntoView({ block: 'center', inline: 'center' });
    const elapsedMs = Date.now() - startedAt;
    const clickableTimeoutMs = Math.max(150, timeoutMs - elapsedMs);
    const element = await waitForState(
      target,
      'clickable',
      clickableTimeoutMs,
      buildProgressEmitter(target, 'clickable'),
    );
    if (!element) {
      throw new CommandError('not_found', `Target ${getTargetLabel(target)} not found`);
    }
    element.scrollIntoView({ block: 'center', inline: 'center' });
    await visualizeAction(element, 'click');
    dispatchClick(element);
    return { ok: true, target: getTargetLabel(target) };
  }

  if (command === 'ui.type') {
    const target = getTarget(args);
    const timeoutMs = getTimeoutMs(args.timeoutMs, 'timeoutMs', DEFAULT_TIMEOUT_MS);
    const text = getString(args.text, 'text', true, true);
    const clear = getBoolean(args.clear, 'clear', false);
    const element = await waitForState(target, 'enabled', timeoutMs, buildProgressEmitter(target, 'enabled'));
    if (!element || text == null) {
      throw new CommandError('not_found', `Target ${getTargetLabel(target)} not found`);
    }
    element.scrollIntoView({ block: 'center', inline: 'center' });
    await visualizeAction(element, 'type');
    setElementValue(element, text, clear);
    return { ok: true, target: getTargetLabel(target), textLength: text.length };
  }

  if (command === 'ui.copy') {
    const target = getTarget(args);
    const timeoutMs = getTimeoutMs(args.timeoutMs, 'timeoutMs', DEFAULT_TIMEOUT_MS);
    const element = await waitForState(target, 'visible', timeoutMs, buildProgressEmitter(target, 'visible'));
    if (!element) {
      throw new CommandError('not_found', `Target ${getTargetLabel(target)} not found`);
    }
    await visualizeAction(element, 'copy');
    const text = getElementText(element);
    const result = await writeClipboard(text);
    return { ok: true, text, backend: result.backend };
  }

  if (command === 'ui.paste') {
    const target = getTarget(args);
    const timeoutMs = getTimeoutMs(args.timeoutMs, 'timeoutMs', DEFAULT_TIMEOUT_MS);
    const clear = getBoolean(args.clear, 'clear', false);
    const element = await waitForState(target, 'enabled', timeoutMs, buildProgressEmitter(target, 'enabled'));
    if (!element) {
      throw new CommandError('not_found', `Target ${getTargetLabel(target)} not found`);
    }
    await visualizeAction(element, 'paste');
    const { text, backend } = await readClipboard();
    setElementValue(element, text, clear);
    return { ok: true, target: getTargetLabel(target), textLength: text.length, backend };
  }

  if (command === 'ui.getText') {
    const target = getTarget(args);
    const timeoutMs = getTimeoutMs(args.timeoutMs, 'timeoutMs', DEFAULT_TIMEOUT_MS);
    const element = await waitForState(target, 'exists', timeoutMs, buildProgressEmitter(target, 'exists'));
    if (!element) {
      throw new CommandError('not_found', `Target ${getTargetLabel(target)} not found`);
    }
    return { ok: true, target: getTargetLabel(target), text: getElementText(element) };
  }

  if (command === 'ui.getAttribute') {
    const target = getTarget(args);
    const attribute = getString(args.attribute, 'attribute') as string;
    const timeoutMs = getTimeoutMs(args.timeoutMs, 'timeoutMs', DEFAULT_TIMEOUT_MS);
    const element = await waitForState(target, 'exists', timeoutMs, undefined, {
      suppressStatusClear: true,
      suppressVisualWait: true,
    });
    if (!element) {
      throw new CommandError('not_found', `Target ${getTargetLabel(target)} not found`);
    }
    return {
      ok: true,
      target: getTargetLabel(target),
      attribute,
      value: element.getAttribute(attribute),
    };
  }

  if (command === 'clipboard.write') {
    const text = getString(args.text, 'text', true, true) ?? '';
    const result = await writeClipboard(text);
    return { ok: true, backend: result.backend };
  }

  if (command === 'clipboard.read') {
    const result = await readClipboard();
    return { ok: true, text: result.text, backend: result.backend };
  }

  if (command === 'app.location') {
    return {
      href: window.location.href,
      path: window.location.pathname,
    };
  }

  throw new CommandError('unknown_command', `Unknown command '${command}'`);
}

export interface CommandExecutionResult {
  ok: boolean;
  result?: unknown;
  error?: {
    code: string;
    message: string;
    details?: UnknownRecord;
  };
}

export async function runCommand(
  command: string,
  argsInput: unknown,
  context: CommandContext,
): Promise<CommandExecutionResult> {
  const commandLabel = describeCommand(command, argsInput);
  const showVisualStatus = shouldShowVisualCommandStatus(command);
  const isWaitCommand = command === 'ui.waitFor';
  const quietVisualStatus = QUIET_VISUAL_COMMANDS.has(command);
  const statusLabel = getCommandStatusTargetLabel(command, commandLabel);
  const startedAt = Date.now();
  activeCommandLabel = commandLabel;
  if (showVisualStatus) {
    setWaitStatusText(
      `${getCommandStatusVerb(command, 'start', quietVisualStatus)}: ${statusLabel}`,
      isWaitCommand ? 'wait' : 'click',
    );
  }
  console.info(`[E2E] command:start ${commandLabel}`);
  try {
    const result = await runCommandInternal(command, argsInput, context);
    const elapsedMs = Date.now() - startedAt;
    const resultSummary = summarizeCommandResult(result);
    console.info(`[E2E] command:ok ${commandLabel} elapsedMs=${elapsedMs} ${resultSummary}`);
    if (showVisualStatus) {
      if (quietVisualStatus) {
        // Keep polling status visible during high-frequency loops (install progress checks).
        setWaitStatusText(`Polling: ${statusLabel}`, isWaitCommand ? 'wait' : 'click');
      } else if (isWaitCommand) {
        setWaitStatusText(`${getCommandStatusVerb(command, 'success', quietVisualStatus)}: ${statusLabel}`, 'wait');
        clearWaitStatusTextSoon();
      } else {
        setWaitStatusText(`${getCommandStatusVerb(command, 'success', quietVisualStatus)}: ${statusLabel}`, 'click');
        clearWaitStatusTextSoon();
      }
    }
    activeCommandLabel = '';
    return { ok: true, result };
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[E2E] command:error ${commandLabel} elapsedMs=${elapsedMs} ${message}`);
    if (showVisualStatus) {
      setWaitStatusText(
        `${getCommandStatusVerb(command, 'error', quietVisualStatus)}: ${statusLabel}`,
        isWaitCommand ? 'wait' : 'click',
      );
      clearWaitStatusTextSoon(quietVisualStatus ? 3_000 : 2_000);
    }
    activeCommandLabel = '';
    if (error instanceof CommandError) {
      return {
        ok: false,
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
        },
      };
    }
    return {
      ok: false,
      error: {
        code: 'internal_error',
        message,
      },
    };
  }
}
