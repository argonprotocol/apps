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
  let command = 'start';
  if (args[0] && !args[0].startsWith('-')) command = args.shift()!;
  if (command === 'help') {
    command = args.shift() ?? 'start';
    args.unshift('--help');
  }
  if (!commands.includes(command)) throw new Error(`Unknown development command "${command}". Run yarn dev --help.`);

  const { run } = (await import(`./commands/${command}.ts`)) as Pick<typeof StartCommand, 'run'>;
  await run(args);
  if (command === 'start' && (args.includes('--help') || args.includes('-h'))) {
    console.info(
      `\nCommands: ${commands.join(', ')}\nPublic networks: yarn testnet [--profile NAME], yarn mainnet [--profile NAME]`,
    );
  }
} catch (error) {
  console.error(`[dev] ${(error as Error).message}`);
  process.exitCode = 1;
}
