export function getElapsedTime(totalSeconds: number) {
  totalSeconds = Math.max(0, totalSeconds);

  return {
    totalSeconds,
    hours: Math.floor(totalSeconds / 3600),
    minutes: Math.floor((totalSeconds % 3600) / 60),
    seconds: totalSeconds % 60,
  };
}
