#!/usr/bin/env node
import { addGlobalArgs, applyEnv, buildCli } from './index.js';
import { waitForLoad } from '@argonprotocol/mainchain';

const program = buildCli();
addGlobalArgs(program);
// load env
applyEnv(program);

await waitForLoad();
await program.parseAsync(process.argv);
