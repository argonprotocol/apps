import type { DriverClient } from '../driver/client.js';
import { operationsFlows } from './operations/index.js';
import { executeFlow } from './runtime.js';
import type { E2EFlowDefinition, E2EFlowExecutionOptions, E2EFlowExecutionResult } from './types.js';

const allFlows: E2EFlowDefinition[] = [...operationsFlows];
const flowRegistry = new Map<string, E2EFlowDefinition>();

for (const flow of allFlows) {
  if (flowRegistry.has(flow.name)) {
    throw new Error(`[E2E] Duplicate flow name '${flow.name}'`);
  }
  flowRegistry.set(flow.name, flow);
}

export function listFlows(): E2EFlowDefinition[] {
  return [...flowRegistry.values()];
}

export function getFlow(name: string): E2EFlowDefinition | null {
  return flowRegistry.get(name) ?? null;
}

export async function runFlow(
  driver: DriverClient,
  name: string,
  options: E2EFlowExecutionOptions = {},
): Promise<E2EFlowExecutionResult> {
  const flow = getFlow(name);
  if (!flow) {
    throw new Error(`Unknown flow '${name}'`);
  }
  return executeFlow(driver, flow, options);
}

export type { E2EFlowDefinition, E2ECommandArgs } from './types.js';
