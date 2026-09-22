import { describe, it } from 'vitest';
import { FlowSession } from '../FlowSession.ts';

const skipE2E = Boolean(JSON.parse(process.env.SKIP_E2E ?? '0'));

type OnboardingFlowName = 'Mining.flow.onboarding' | 'Vaulting.flow.onboarding';

async function runIsolatedFlow(flowName: OnboardingFlowName): Promise<void> {
  const sessionName = `onboarding-spec-${flowName}`;
  const session = await FlowSession.start({
    useTestNetwork: true,
    sessionName,
  });

  try {
    await session.run(flowName);
  } finally {
    await session.close();
  }
}

describe.skipIf(skipE2E).sequential('Operational Flows', () => {
  it(
    'mining onboarding',
    async () => {
      await runIsolatedFlow('Mining.flow.onboarding');
    },
    45 * 60_000,
  );

  it(
    'vaulting onboarding',
    async () => {
      await runIsolatedFlow('Vaulting.flow.onboarding');
    },
    45 * 60_000,
  );
});
