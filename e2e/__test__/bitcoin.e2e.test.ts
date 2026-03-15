import { describe, it } from 'vitest';
import { createFlowSession, type IFlowSession } from '../flows/session.ts';

const skipE2E = Boolean(JSON.parse(process.env.SKIP_E2E ?? '0'));

type BitcoinFlowName = 'Bitcoin.flow.lockUnlock' | 'Bitcoin.flow.mismatchAccept' | 'Bitcoin.flow.mismatchReturn';

async function runIsolatedFlow(flowName: BitcoinFlowName): Promise<void> {
  const sessionName = `bitcoin-spec-${flowName}`;
  const session: IFlowSession = await createFlowSession({
    useTestNetwork: true,
    sessionName,
  });

  try {
    await session.run(flowName);
  } finally {
    await session.close();
  }
}

describe.skipIf(skipE2E).sequential('Bitcoin Operation Flows', () => {
  it(
    'bitcoin lock/unlock',
    async () => {
      await runIsolatedFlow('Bitcoin.flow.lockUnlock');
    },
    45 * 60_000,
  );

  it(
    'bitcoin mismatch accept',
    async () => {
      await runIsolatedFlow('Bitcoin.flow.mismatchAccept');
    },
    45 * 60_000,
  );

  it(
    'bitcoin mismatch return',
    async () => {
      await runIsolatedFlow('Bitcoin.flow.mismatchReturn');
    },
    45 * 60_000,
  );
});
