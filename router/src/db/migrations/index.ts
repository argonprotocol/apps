import type { ISqliteMigration } from '@argonprotocol/apps-core';
import { InitialMigration } from './001-initial.ts';
import { SessionsMigration } from './002-sessions.ts';
import { InviteEnvelopeMigration } from './003-invite-envelope.ts';
import { OperationsUpgradeStateMigration } from './004-operations-upgrade-state.ts';
import { BitcoinLockCouponsMigration } from './005-bitcoin-lock-coupons.ts';

export const migrations = [
  InitialMigration,
  SessionsMigration,
  InviteEnvelopeMigration,
  OperationsUpgradeStateMigration,
  BitcoinLockCouponsMigration,
] satisfies ISqliteMigration[];
