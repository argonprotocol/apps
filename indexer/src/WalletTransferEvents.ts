import type { ArgonClient, GenericEvent } from '@argonprotocol/mainchain';
import { groupEventsByExtrinsic, isUserTransferEventSet } from '@argonprotocol/apps-core';
import { type IWalletTransferRecord, WalletTransferCurrency, WalletTransferSource } from './LegacyIndexerDb.js';

export { groupEventsByExtrinsic, isUserTransferEventSet };

export function decodeWalletTransfer(args: {
  client: ArgonClient;
  event: GenericEvent;
  extrinsicEvents: readonly GenericEvent[];
  eventIndex: number;
  extrinsicIndex?: number;
}): Omit<IWalletTransferRecord, 'blockNumber'> | undefined {
  const { client, event, extrinsicEvents, eventIndex, extrinsicIndex } = args;
  if (extrinsicIndex === undefined) return;

  if (client.events.balances.BalanceSet.is(event)) {
    return {
      toAddress: event.data.who.toHuman(),
      fromAddress: null,
      source: WalletTransferSource.Faucet,
      currency: WalletTransferCurrency.Argon,
    };
  }

  if (client.events.ownership.BalanceSet.is(event)) {
    return {
      toAddress: event.data.who.toHuman(),
      fromAddress: null,
      source: WalletTransferSource.Faucet,
      currency: WalletTransferCurrency.Argonot,
    };
  }

  if (client.events.crosschainTransfer.TransferToArgonSettled.is(event)) {
    const { transfer } = event.data;
    return {
      toAddress: transfer.to.toHuman(),
      fromAddress: null,
      source: WalletTransferSource.Ethereum,
      currency: transfer.asset.isArgon ? WalletTransferCurrency.Argon : WalletTransferCurrency.Argonot,
    };
  }

  if (!isUserTransferEventSet(extrinsicEvents, eventIndex)) return;

  if (client.events.balances.Transfer.is(event)) {
    return {
      toAddress: event.data.to.toHuman(),
      fromAddress: event.data.from.toHuman(),
      source: WalletTransferSource.Transfer,
      currency: WalletTransferCurrency.Argon,
    };
  }

  if (client.events.ownership.Transfer.is(event)) {
    return {
      toAddress: event.data.to.toHuman(),
      fromAddress: event.data.from.toHuman(),
      source: WalletTransferSource.Transfer,
      currency: WalletTransferCurrency.Argonot,
    };
  }
}
