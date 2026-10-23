#!/usr/bin/env node
import { parseArgs } from 'node:util';

try {
  const { values } = parseArgs({
    options: {
      profile: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.info(`Usage: yarn mainnet [options]

Launch desktop on mainnet:
  --profile NAME  Desktop account (default: default)
  -h, --help      Show this help`);
  } else {
    const { startPublicNetworkDesktop } = await import('../publicDesktop.ts');
    await startPublicNetworkDesktop('mainnet', values.profile);
  }
} catch (error) {
  console.error(`[mainnet] ${(error as Error).message}`);
  process.exitCode = 1;
}
