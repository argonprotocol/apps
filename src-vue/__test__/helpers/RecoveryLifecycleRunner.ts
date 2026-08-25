import { raceWithTimeout } from '@argonprotocol/apps-core';
import { expect } from 'vitest';

export async function runRecoveryLifecycle<State>(args: {
  name: string;
  recover: () => Promise<void>;
  readDurableState: () => Promise<State>;
  timeoutMs?: number;
}): Promise<State> {
  const states: State[] = [];

  for (const phase of ['initial replay', 'restart replay']) {
    await raceWithTimeout(args.recover(), args.timeoutMs ?? 5_000, () => {
      throw new Error(`${args.name} stalled during ${phase}`);
    });
    states.push(await args.readDurableState());
  }

  expect(states[1], `${args.name} changed durable state after restart`).toEqual(states[0]);
  return states[0];
}
