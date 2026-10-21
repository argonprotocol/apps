import { ensureDevGatewayCerts } from '../dev/gatewayCerts.ts';
import { runYarn } from '../core/__test__/helpers/runYarn.ts';

runYarn(['build:indexer']);
runYarn(['build:server']);
await ensureDevGatewayCerts();
