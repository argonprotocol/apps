import Fs from 'node:fs';
import Path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { constants, createGunzip, createGzip } from 'node:zlib';

const seedNetworks = ['mainnet', 'testnet'] as const;

export async function compressSeeds(seedDirectory: string): Promise<void> {
  for (const network of seedNetworks) {
    const databasePath = Path.join(seedDirectory, `${network}-activity-v2.db`);
    if (!Fs.existsSync(databasePath)) throw new Error(`Missing seed ${databasePath}`);

    await writeAtomically(`${databasePath}.gz`, temporaryPath => {
      return pipeline(
        Fs.createReadStream(databasePath),
        createGzip({ level: constants.Z_BEST_COMPRESSION }),
        Fs.createWriteStream(temporaryPath),
      );
    });
  }
}

export async function extractSeeds(seedDirectory: string): Promise<void> {
  for (const network of seedNetworks) {
    const databasePath = Path.join(seedDirectory, `${network}-activity-v2.db`);
    const compressedPath = `${databasePath}.gz`;
    if (Fs.existsSync(compressedPath)) {
      await extractSeed(compressedPath, databasePath);
    } else if (!Fs.existsSync(databasePath)) {
      throw new Error(`Missing compressed seed ${compressedPath}`);
    }
  }
}

export async function extractSeed(compressedPath: string, databasePath: string): Promise<void> {
  await writeAtomically(databasePath, temporaryPath => {
    return pipeline(Fs.createReadStream(compressedPath), createGunzip(), Fs.createWriteStream(temporaryPath));
  });
}

const command = process.argv[2];
if (process.argv[1] && Path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const seedDirectory = Path.join(import.meta.dirname, '../seeds');
  if (command === 'extract') {
    await extractSeeds(seedDirectory);
  } else if (command === 'compress') {
    await compressSeeds(seedDirectory);
  } else {
    throw new Error('Usage: seedArtifacts.ts <extract|compress>');
  }
}

async function writeAtomically(
  destinationPath: string,
  write: (temporaryPath: string) => Promise<void>,
): Promise<void> {
  const temporaryPath = `${destinationPath}.tmp`;
  Fs.rmSync(temporaryPath, { force: true });
  try {
    await write(temporaryPath);
    Fs.renameSync(temporaryPath, destinationPath);
  } catch (error) {
    Fs.rmSync(temporaryPath, { force: true });
    throw error;
  }
}
