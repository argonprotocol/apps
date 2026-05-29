import {
  type ArgonClient,
  type ISubmittableOptions,
  type SubmittableExtrinsic,
  type TxSigningAccount,
  TxSubmitter,
} from '@argonprotocol/mainchain';
import { sudo } from '@argonprotocol/testing';

export async function getFinalizedClient(client: ArgonClient) {
  return await client.at(await client.rpc.chain.getFinalizedHead());
}

export async function submitAndFinalize(
  client: ArgonClient,
  tx: SubmittableExtrinsic,
  txSigner: TxSigningAccount,
  options?: ISubmittableOptions,
) {
  const result = await new TxSubmitter(client, tx, txSigner).submit(options);
  await result.waitForFinalizedBlock;
  return result;
}

export async function sudoSubmitAndFinalize(
  client: ArgonClient,
  tx: SubmittableExtrinsic,
  options?: ISubmittableOptions,
) {
  return await submitAndFinalize(client, client.tx.sudo.sudo(tx), sudo(), options);
}
