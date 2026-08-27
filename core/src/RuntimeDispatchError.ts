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
  if (decoded) {
    const { docs, name, section } = decoded;
    return new ExtrinsicError(`${section}.${name}`, docs.join(' '), batchInterruptedIndex, txFee);
  }

  if ('isModule' in error) return new ExtrinsicError(error.toString(), undefined, batchInterruptedIndex, txFee);

  return new ExtrinsicError(runtimeEnumName(error), undefined, batchInterruptedIndex, txFee);
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

function runtimeEnumName(value: RuntimeDispatchError): string {
  if (!('value' in value)) return value.type;
  if ('type' in value.value) return `${value.type}.${value.value.type}`;
  return value.type;
}
