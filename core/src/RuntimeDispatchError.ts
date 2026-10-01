import { ExtrinsicError, hexToU8a, type SpRuntimeDispatchError } from '@argonprotocol/mainchain';
import type { HistoricalEvent } from '@argonprotocol/runtime-client';
import type { ArgonClient } from './MainchainClients.js';

type HistoricalSystemFailure = Extract<
  HistoricalEvent,
  { section: 'system'; method: 'ExtrinsicFailed' }
>['data']['dispatchError'];
type HistoricalBatchFailure = Extract<
  HistoricalEvent,
  { section: 'utility'; method: 'BatchInterrupted' }
>['data']['error'];

export type RuntimeDispatchError = HistoricalSystemFailure | HistoricalBatchFailure;

export function runtimeDispatchErrorToExtrinsicError(
  client: Pick<ArgonClient, 'registry'>,
  error: SpRuntimeDispatchError | RuntimeDispatchError,
  batchInterruptedIndex?: number,
  txFee = 0n,
): ExtrinsicError {
  const decoded = findRuntimeModuleError(client, error);
  return createRuntimeExtrinsicError(client, {
    errorCode: decoded ? `${decoded.section}.${decoded.name}` : runtimeEnumName(error),
    details: decoded?.docs.join(' '),
    batchInterruptedIndex,
    txFee,
  });
}

export function createRuntimeExtrinsicError(
  client: Pick<ArgonClient, 'registry'>,
  args: Partial<Pick<ExtrinsicError, 'errorCode' | 'details' | 'message' | 'batchInterruptedIndex' | 'txFee'>>,
): ExtrinsicError {
  const { errorCode = 'Unknown Error', details, message: existingMessage, batchInterruptedIndex, txFee = 0n } = args;
  const description = details ?? existingMessage;
  let codeForMessage = errorCode;
  if (errorCode.startsWith('{')) {
    try {
      // Older non-module errors used the codec's JSON representation as the code.
      const dispatchError = client.registry.createType<SpRuntimeDispatchError>(
        'SpRuntimeDispatchError',
        JSON.parse(errorCode),
      );
      // Module indices cannot be resolved safely without their original runtime metadata.
      if (!dispatchError.isModule) codeForMessage = runtimeEnumName(dispatchError);
    } catch {
      // Preserve an undecodable stored code for diagnostics and use the generic message.
    }
  }

  const runtimeDescription =
    (description && description !== errorCode ? description : undefined) ||
    findRuntimeErrorDocs(client, codeForMessage);
  const message = runtimeErrorMessages.get(codeForMessage) || runtimeDescription || genericTransactionMessage;
  const error = new ExtrinsicError(errorCode, runtimeDescription || message, batchInterruptedIndex, txFee);
  // The SDK constructor uses the code as Error.message, which is what promise consumers display.
  error.message = message === genericTransactionMessage ? `${message} (Error code: ${codeForMessage})` : message;
  return error;
}

export function findRuntimeModuleError(
  client: Pick<ArgonClient, 'registry'>,
  error: SpRuntimeDispatchError | RuntimeDispatchError,
) {
  if ('isModule' in error) return error.isModule ? client.registry.findMetaError(error.asModule) : undefined;
  if (error.type !== 'Module') return undefined;

  const encodedError = hexToU8a(error.value.error);
  const moduleError = new Uint8Array(encodedError.length + 1);
  moduleError[0] = error.value.index;
  moduleError.set(encodedError, 1);
  return client.registry.findMetaError(moduleError);
}

function runtimeEnumName(value: SpRuntimeDispatchError | RuntimeDispatchError): string {
  if (!('value' in value)) return value.type;
  if ('type' in value.value) return `${value.type}.${value.value.type}`;
  return value.type;
}

function findRuntimeErrorDocs({ registry }: Pick<ArgonClient, 'registry'>, errorCode: string): string | undefined {
  const [section, name] = errorCode.split('.');
  const pallet = registry.metadata.pallets.find(
    pallet => pallet.name.toString().toLowerCase() === section.toLowerCase(),
  );
  if (pallet?.errors.isSome) {
    const variant = registry.lookup
      .getSiType(pallet.errors.unwrap().type)
      .def.asVariant.variants.find(variant => variant.name.eq(name));
    return variant?.docs.join(' ') || undefined;
  }

  let type = registry.lookup.types.find(type => type.type.path.join('::') === 'sp_runtime::DispatchError')?.type;
  for (const variantName of errorCode.split('.')) {
    if (!type?.def.isVariant) return;
    const variant = type.def.asVariant.variants.find(variant => variant.name.eq(variantName));
    if (!variant) return;
    if (variant.docs.length) return variant.docs.join(' ');
    type = variant.fields.length ? registry.lookup.getSiType(variant.fields[0].type) : undefined;
  }
}

const insufficientFundsMessage =
  'Not enough available funds to cover the transaction and its fees. Reduce the amount or add funds, then try again.';
const minimumBalanceMessage = 'Your account needs to keep a minimum balance. Reduce the amount and try again.';
const restrictedFundsMessage = 'These funds are restricted and cannot be transferred.';
const unsupportedTransactionMessage = 'The network does not support this asset or transaction.';
const genericTransactionMessage =
  'The transaction could not be completed. Please try again or contact support if the problem continues.';

// Plain-language overrides for common failures and built-in variants without metadata docs.
const runtimeErrorMessages = new Map<string, string>([
  ['Token.FundsUnavailable', insufficientFundsMessage],
  ['balances.InsufficientBalance', insufficientFundsMessage],
  ['bitcoinLocks.InsufficientFunds', insufficientFundsMessage],
  ['Token.OnlyProvider', minimumBalanceMessage],
  [
    'Token.BelowMinimum',
    'This transaction would leave an account below the network’s minimum balance. Adjust the amount and try again.',
  ],
  ['Token.NotExpendable', minimumBalanceMessage],
  ['balances.Expendability', minimumBalanceMessage],
  ['bitcoinLocks.AccountWouldGoBelowMinimumBalance', minimumBalanceMessage],
  [
    'balances.ExistentialDeposit',
    'The amount is too small to create the destination account. Increase the amount and try again.',
  ],
  ['Token.CannotCreate', 'The destination account cannot be created with this transfer. Check the address and amount.'],
  ['Token.UnknownAsset', unsupportedTransactionMessage],
  ['Token.Frozen', restrictedFundsMessage],
  ['Token.Unsupported', unsupportedTransactionMessage],
  ['Token.CannotCreateHold', 'The network cannot reserve the funds required for this transaction.'],
  ['Token.Blocked', restrictedFundsMessage],
  ['BadOrigin', 'Your account does not have permission to perform this transaction.'],
  [
    'CannotLookup',
    'The network could not find the account required for this transaction. Check the address used in the transaction.',
  ],
  ['Unavailable', 'The network cannot perform this transaction right now. Please try again later.'],
  ['Exhausted', 'The network has reached its transaction limit. Please try again later.'],
  ['Arithmetic.Underflow', genericTransactionMessage],
  ['Arithmetic.Overflow', genericTransactionMessage],
  ['Arithmetic.DivisionByZero', genericTransactionMessage],
]);
