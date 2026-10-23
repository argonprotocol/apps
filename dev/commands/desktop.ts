import { parseArgs } from 'node:util';

export async function run(args = process.argv.slice(2)): Promise<void> {
  const { values } = parseArgs({ args, options: { help: { type: 'boolean', short: 'h' } } });
  if (values.help) {
    console.info(`Usage: yarn dev desktop

Launch only the desktop app using the prepared environment and services.
Use yarn dev for normal local startup, or yarn testnet / yarn mainnet for public networks.`);
    return;
  }
  const { startDesktop } = await import('../desktop.ts');
  await startDesktop();
}
