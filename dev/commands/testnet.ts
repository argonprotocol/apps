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
    console.info(`Usage: yarn testnet [options]

Launch desktop on testnet:
  --profile NAME  Desktop account (default: default)
  -h, --help      Show this help`);
  } else {
    const { startPublicNetworkDesktop } = await import('../publicDesktop.ts');
    await startPublicNetworkDesktop('testnet', values.profile);
  }
} catch (error) {
  console.error(`[testnet] ${(error as Error).message}`);
  process.exitCode = 1;
}
