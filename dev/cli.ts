#!/usr/bin/env node
import type * as StartCommand from './commands/start.ts';

const commands = [
  'start',
  'desktop',
  'fund',
  'fund-ethereum',
  'logs',
  'status',
  'stop',
  'reset',
  'bitcoin',
  'upstream-invite',
  'compose',
  'chainspec',
];

try {
  const args = process.argv.slice(2);
  let command = args.shift();
  if (command === 'help') {
    command = args.shift();
    if (command) args.unshift('--help');
  }
  if (!command || command === '--help' || command === '-h') {
    console.info(`Usage: yarn dev <command> [options]

Commands: ${commands.join(', ')}
Run yarn dev start --help for startup options or yarn dev help <command> for command-specific options.
Public networks: yarn testnet [--profile NAME], yarn mainnet [--profile NAME]`);
    process.exit(0);
  }
  if (command.startsWith('-')) throw new Error('Specify a command first, such as yarn dev start.');
  if (!commands.includes(command)) throw new Error(`Unknown development command "${command}". Run yarn dev for help.`);

  const { run } = (await import(`./commands/${command}.ts`)) as Pick<typeof StartCommand, 'run'>;
  await run(args);
} catch (error) {
  console.error(`[dev] ${(error as Error).message}`);
  process.exitCode = 1;
}
