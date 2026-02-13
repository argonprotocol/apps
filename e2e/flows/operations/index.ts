import { miningOnboardingFlow } from './miningOnboarding.js';
import { vaultingOnboardingFlow } from './vaultingOnboarding.js';
import type { E2EFlowDefinition } from '../types.js';

export const operationsFlows: E2EFlowDefinition[] = [miningOnboardingFlow, vaultingOnboardingFlow];
