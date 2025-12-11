import { readReleaseNotes } from './utils.ts';

const rawVersion = process.argv[2];

(async () => {
  const releaseNotes = readReleaseNotes(rawVersion, true);
  if (!releaseNotes) {
    process.exit(1);
  }
  console.log(releaseNotes);
})();
