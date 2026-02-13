import { describe, expect, it } from 'vitest';
import { createFlowSession, getDefaultFlowInput, type FlowSession } from '../flows/session.js';

const skipE2E = Boolean(JSON.parse(process.env.SKIP_E2E ?? '0'));

async function runIsolatedFlow(flowName: 'miningOnboarding' | 'vaultingOnboarding'): Promise<number> {
  const sessionName = `onboarding-spec-${flowName}`;
  const session: FlowSession = await createFlowSession({
    useTestNetwork: true,
    sessionName,
  });

  try {
    const result = await session.run(flowName, getDefaultFlowInput(flowName));
    return result.elapsedMs;
  } finally {
    await session.close();
  }
}

describe.skipIf(skipE2E).sequential('Onboarding Flows', () => {
  it(
    'mining onboarding',
    async () => {
      const elapsedMs = await runIsolatedFlow('miningOnboarding');
      expect(elapsedMs).toBeGreaterThan(0);
    },
    45 * 60_000,
  );

  it(
    'vaulting onboarding',
    async () => {
      const elapsedMs = await runIsolatedFlow('vaultingOnboarding');
      expect(elapsedMs).toBeGreaterThan(0);
    },
    45 * 60_000,
  );
});
