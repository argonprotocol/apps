export function getMiningSeatProgressAtFrame(startingFrameId: number, frameId: number, frameProgress = 100): number {
  const frameSpan = 10;
  const endExclusiveFrameId = startingFrameId + frameSpan;

  if (frameId < startingFrameId) {
    return 0;
  }
  if (frameId >= endExclusiveFrameId) {
    return 100;
  }

  const completedFrames = frameId - startingFrameId;
  const normalizedFrameProgress = Math.max(0, Math.min(100, frameProgress)) / 100;
  const progress = ((completedFrames + normalizedFrameProgress) / frameSpan) * 100;

  return Math.max(0, Math.min(100, progress));
}
