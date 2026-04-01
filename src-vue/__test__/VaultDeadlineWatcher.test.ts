import { describe, expect, it } from 'vitest';
import { computeCollectDeadline } from '../lib/VaultDeadlineWatcher.ts';

describe('computeCollectDeadline', () => {
  it.each([
    [
      'defaults to the next collection window when nothing is pending',
      { collectFrames: [], cosignDueFrames: [], currentFrameId: 120, timeToCollectFrames: 5 },
      { nextCollectFrame: 125, expiringCollectAmount: 0n },
    ],
    [
      'uses the oldest uncollected frame still inside the collection window',
      {
        collectFrames: [
          { frameId: 120, uncollectedEarnings: 0n },
          { frameId: 119, uncollectedEarnings: 2n },
          { frameId: 118, uncollectedEarnings: 4n },
          { frameId: 114, uncollectedEarnings: 9n },
        ],
        cosignDueFrames: [],
        currentFrameId: 120,
        timeToCollectFrames: 3,
      },
      { nextCollectFrame: 121, expiringCollectAmount: 4n },
    ],
    [
      'prefers the earliest cosign due frame when it arrives sooner than revenue collection',
      {
        collectFrames: [
          { frameId: 120, uncollectedEarnings: 0n },
          { frameId: 119, uncollectedEarnings: 5n },
        ],
        cosignDueFrames: [undefined, 122],
        currentFrameId: 120,
        timeToCollectFrames: 5,
      },
      { nextCollectFrame: 122, expiringCollectAmount: 5n },
    ],
    [
      'clamps deadlines earlier than the next frame',
      { collectFrames: [], cosignDueFrames: [118], currentFrameId: 120, timeToCollectFrames: 5 },
      { nextCollectFrame: 121, expiringCollectAmount: 0n },
    ],
  ])('%s', (_label, args, expected) => {
    expect(computeCollectDeadline(args)).toEqual(expected);
  });
});
