import Fs from 'node:fs/promises';
import Path from 'node:path';

export async function writeGeneratedFile(path: string, contents: string, check = false): Promise<void> {
  let current: string | undefined;
  try {
    current = await Fs.readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  // Dev apps watch these files; unchanged output must not trigger another app reload.
  if (current === contents) return;
  if (check) throw new Error(`${Path.basename(path)} is out of date; run the runtime client generator`);

  await Fs.writeFile(path, contents);
}
