import { describe, expect, it } from 'vitest';
import { createFlowSession, type IFlowSession } from '../flows/session.ts';

const skipE2E = Boolean(JSON.parse(process.env.SKIP_E2E ?? '0'));

type OnboardingFlowName = 'Mining.flow.onboarding' | 'Vaulting.flow.onboarding';

async function runIsolatedFlow(flowName: OnboardingFlowName): Promise<number> {
  const sessionName = `onboarding-spec-${flowName}`;
  const session: IFlowSession = await createFlowSession({
    useTestNetwork: true,
    sessionName,
  });

  try {
    const result = await session.run(flowName);
    return result.elapsedMs;
  } finally {
    await session.close();
  }
}

describe.skipIf(skipE2E).sequential('Operational Flows', () => {
  it(
    'mining onboarding',
    async () => {
      const elapsedMs = await runIsolatedFlow('Mining.flow.onboarding');
      expect(elapsedMs).toBeGreaterThan(0);
    },
    45 * 60_000,
  );

  it(
    'vaulting onboarding',
    async () => {
      const elapsedMs = await runIsolatedFlow('Vaulting.flow.onboarding');
      expect(elapsedMs).toBeGreaterThan(0);
    },
    45 * 60_000,
  );
});
