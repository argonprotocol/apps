import fs from 'node:fs';
import Path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { DriverClient } from '../driver/client.ts';
import type { AnyOperationalFlow } from './operations/index.ts';
import { executeFlow } from './runtime.ts';
import type { IE2EFlowDefinition, IE2EFlowExecutionOptions, IE2EFlowExecutionResult } from './types.ts';

const OPERATION_FILE_PATTERN = /^[A-Z][A-Za-z0-9]*\.(op|flow)\.[A-Za-z0-9_]+\.(ts|js)$/;
const OPERATIONS_DIR = resolveOperationsDir();
const requireModule = createRequire(Path.join(OPERATIONS_DIR, 'index.ts'));
const flowRegistry = new Map<string, IE2EFlowDefinition>();

for (const flowOperation of loadFlowOperations()) {
  const flow = toFlowDefinition(flowOperation);
  if (flowRegistry.has(flow.name)) {
    throw new Error(`[E2E] Duplicate flow name '${flow.name}'`);
  }
  flowRegistry.set(flow.name, flow);
}

export function listFlows(): IE2EFlowDefinition[] {
  return [...flowRegistry.values()];
}

export function getFlow(name: string): IE2EFlowDefinition | null {
  return flowRegistry.get(name) ?? null;
}

export async function runFlow(
  driver: DriverClient,
  name: string,
  options: IE2EFlowExecutionOptions = {},
): Promise<IE2EFlowExecutionResult> {
  const flow = getFlow(name);
  if (!flow) {
    throw new Error(`Unknown flow '${name}'`);
  }
  return executeFlow(driver, flow, options);
}

export type { IE2EFlowDefinition, E2ECommandArgs } from './types.ts';

function loadFlowOperations(): AnyOperationalFlow[] {
  const moduleFiles = fs
    .readdirSync(OPERATIONS_DIR, { withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => entry.name)
    .filter(name => name !== 'index.ts' && name !== 'index.js')
    .filter(name => OPERATION_FILE_PATTERN.test(name))
    .sort((left, right) => left.localeCompare(right));

  const operations: AnyOperationalFlow[] = [];
  for (const moduleFile of moduleFiles) {
    const modulePath = Path.join(OPERATIONS_DIR, moduleFile);
    const moduleExports = requireModule(modulePath) as Record<string, unknown>;
    const flowOperation = moduleExports.default;
    if (isOperationalFlow(flowOperation)) {
      operations.push(flowOperation);
      continue;
    }
    if (!isOperation(flowOperation)) {
      throw new Error(`[E2E] ${moduleFile} must default-export an Operation or OperationalFlow`);
    }
  }
  return operations;
}

function toFlowDefinition(flowOperation: AnyOperationalFlow): IE2EFlowDefinition {
  const flowName = flowOperation.name;
  return {
    name: flowName,
    description: flowOperation.description,
    defaultTimeoutMs: flowOperation.defaultTimeoutMs,
    async run(flow) {
      const context = flowOperation.createContext(flow, flowName);
      await flow.runOperations(context, [flowOperation]);
    },
  };
}

function isOperationalFlow(value: unknown): value is AnyOperationalFlow {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<AnyOperationalFlow>;
  return (
    typeof candidate.name === 'string' &&
    typeof candidate.description === 'string' &&
    typeof candidate.defaultTimeoutMs === 'number' &&
    typeof candidate.createContext === 'function' &&
    typeof candidate.inspect === 'function' &&
    typeof candidate.run === 'function'
  );
}

function isOperation(
  value: unknown,
): value is { name: string; inspect: (...args: unknown[]) => unknown; run: (...args: unknown[]) => unknown } {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as { name?: unknown; inspect?: unknown; run?: unknown };
  return (
    typeof candidate.name === 'string' && typeof candidate.inspect === 'function' && typeof candidate.run === 'function'
  );
}

function resolveOperationsDir(): string {
  const metaUrl = (import.meta as { url?: unknown }).url;
  if (typeof metaUrl === 'string' && metaUrl.length > 0) {
    return fileURLToPath(new URL('./operations', metaUrl));
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
