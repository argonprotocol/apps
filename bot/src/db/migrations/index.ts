import type { ISqliteMigration } from '@argonprotocol/apps-core';
import { InitialMigration } from './001-initial.ts';
import { RenameBitcoinLockRelayTargetRateMigration } from './002-rename-bitcoin-lock-relay-target-rate.ts';
import { AddBitcoinLockCouponEstimatedGiftUsdMigration } from './003-add-bitcoin-lock-coupon-estimated-gift-usd.ts';

export const migrations = [
  InitialMigration,
  RenameBitcoinLockRelayTargetRateMigration,
  AddBitcoinLockCouponEstimatedGiftUsdMigration,
] satisfies ISqliteMigration[];
