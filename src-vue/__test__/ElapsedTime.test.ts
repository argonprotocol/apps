import { expect, it } from 'vitest';
import { getElapsedTime } from '../lib/ElapsedTime.ts';

it('treats a future timestamp as zero elapsed time', () => {
  expect(getElapsedTime(-300)).toEqual({
    totalSeconds: 0,
    hours: 0,
    minutes: 0,
    seconds: 0,
  });
});
