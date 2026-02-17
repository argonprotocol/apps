import type { AugmentedQuery, AugmentedSubmittable } from '@polkadot/api-base/types';
import type { AnyNumber } from '@polkadot/types-codec/types';
import type { Compact, Option, Struct, u128, u32, u64, Vec } from '@polkadot/types-codec';
import type { Observable } from '@polkadot/types/types';
import { AccountId32, ArgonClient } from '@argonprotocol/mainchain';
import type { SubmittableExtrinsic } from '@polkadot/api/promise/types';

// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace SpecLte146 {
  export interface PalletTreasuryPrebondedArgons extends Struct {
    readonly vaultId: Compact<u32>;
    readonly accountId: AccountId32;
    readonly amountUnbonded: Compact<u128>;
    readonly startingFrameId: Compact<u64>;
    readonly bondedByStartOffset: Vec<u128>;
    readonly maxAmountPerFrame: Compact<u128>;
  }
  export type ITreasuryQuerySpec = {
    prebondedByVaultId: AugmentedQuery<
      'promise',
      (arg: u32 | AnyNumber | Uint8Array) => Observable<Option<PalletTreasuryPrebondedArgons>>,
      [u32]
    >;
  };
  export type ITreasuryTxSpec = {
    vaultOperatorPrebond: AugmentedSubmittable<
      (vaultId: u32 | AnyNumber | Uint8Array, maxAmountPerFrame: u128 | AnyNumber | Uint8Array) => SubmittableExtrinsic,
      [u32, u128]
    >;
  };
  export function isAtSpec(client: ArgonClient): boolean {
    return client.tx.treasury.setAllocation?.meta === undefined;
  }
}
