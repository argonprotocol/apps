import {
  createArgonClient,
  type ArgonClient,
  type ISubmittableOptions,
  type TxSigningAccount,
  TxSubmitter,
  raceWithTimeout,
} from '@argonprotocol/apps-core';
import { getClient, type SubmittableExtrinsic } from '@argonprotocol/mainchain';
import type { ApiOptions } from '@polkadot/api/types';
import { sudo } from '@argonprotocol/testing';
import { integrationSession } from '../integrationNetwork.ts';
import { acquireIntegrationLock } from './locks.ts';

export async function getTestMainchainClient(host: string, options?: ApiOptions): Promise<ArgonClient> {
  return createArgonClient(await getClient(host, options));
}

export async function getFinalizedClient(client: ArgonClient) {
  return await client.at(await client.rpc.chain.getFinalizedHead());
}

export async function submitAndFinalize(
  client: ArgonClient,
  tx: SubmittableExtrinsic,
  txSigner: TxSigningAccount,
  options?: ISubmittableOptions,
) {
  const session = integrationSession.getStore();
  const release =
    txSigner.address === sudo().address ? await acquireIntegrationLock('sudo', session?.lockDirectory) : undefined;
  try {
    const result = await new TxSubmitter(client, tx, txSigner).submit(options);
    if (session) {
      await raceWithTimeout(result.waitForFinalizedBlock, 120_000, () => {
        throw new Error('Shared integration transaction did not finalize within 120 seconds');
      });
    } else {
      await result.waitForFinalizedBlock;
    }
    return result;
  } finally {
    await release?.();
  }
}

export async function sudoSubmitAndFinalize(
  client: ArgonClient,
  tx: SubmittableExtrinsic,
  options?: ISubmittableOptions,
) {
  return await submitAndFinalize(client, client.tx.sudo.sudo(tx), sudo(), options);
}
