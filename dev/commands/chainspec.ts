import Path from 'node:path';
import { parseArgs } from 'node:util';
import { resolveDevProfile } from '../session.ts';
import { generateChainSpec } from '../../core/__test__/helpers/generateChainSpec.ts';

export async function run(args = process.argv.slice(2)): Promise<void> {
  const separator = args.indexOf('--');
  if (separator >= 0) args = [...args.slice(0, separator), ...args.slice(separator + 1)];
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      profile: { type: 'string' },
      instance: { type: 'string' },
      join: { type: 'string' },
      'chain-spec': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      'ticks-between-slots': { type: 'string' },
      'compute-difficulty': { type: 'string' },
    },
  });
  if (values.help) {
    console.info(`Usage: yarn dev chainspec [options] [runtime.wasm]

Generate a custom local chain specification:
  --profile NAME             Owning account profile (default: default; alias: --instance)
  --join NAME                Owning local environment
  --chain-spec FILE          Output path (default: ARGON_CHAIN_SPEC_PATH or e2e/argon/chainspec.raw.json)
  --ticks-between-slots N    Positive number of ticks per mining slot
  --compute-difficulty N     Positive initial compute difficulty
  -h, --help                 Show this help

Provide a runtime WASM path or at least one chain parameter.`);
    return;
  }
  const runtimeWasmPath = positionals[0];
  const ticksBetweenSlotsArg = values['ticks-between-slots'];
  const ticksBetweenSlots = ticksBetweenSlotsArg === undefined ? undefined : Number(ticksBetweenSlotsArg);
  const computeDifficultyArg = values['compute-difficulty'];
  const computeDifficulty = computeDifficultyArg === undefined ? undefined : Number(computeDifficultyArg);

  if (positionals.length > 1) {
    throw new Error('Only one runtime WASM path may be provided.');
  }
  if (ticksBetweenSlots !== undefined && (!Number.isSafeInteger(ticksBetweenSlots) || ticksBetweenSlots <= 0)) {
    throw new Error('--ticks-between-slots must be a positive integer.');
  }
  if (computeDifficulty !== undefined && (!Number.isSafeInteger(computeDifficulty) || computeDifficulty <= 0)) {
    throw new Error('--compute-difficulty must be a positive integer.');
  }
  if (!runtimeWasmPath && ticksBetweenSlots === undefined && computeDifficulty === undefined) {
    throw new Error(
      'Usage: yarn dev chainspec [path-to-runtime-wasm] [--ticks-between-slots <count>] [--compute-difficulty <count>]',
    );
  }
  const profile = resolveDevProfile(values);
  const { toComposeProjectName } = await import('@argonprotocol/apps-core');
  const composeProjectName = toComposeProjectName(profile.join ?? profile.instance, profile.network);

  const outputPath = values['chain-spec'];
  if (outputPath !== undefined) {
    if (!outputPath.trim() || /[\0\r\n]/.test(outputPath)) throw new Error('--chain-spec must name a valid file path.');
  }
  await generateChainSpec({
    runtimeWasmPath,
    ticksBetweenSlots,
    computeDifficulty,
    outputPath,
    env: {
      ...process.env,
      COMPOSE_PROJECT_NAME: composeProjectName,
      JOIN_COMPOSE_NETWORK: composeProjectName,
      ...(outputPath ? { ARGON_CHAIN_SPEC_PATH: Path.resolve(outputPath) } : {}),
    },
  });
}
