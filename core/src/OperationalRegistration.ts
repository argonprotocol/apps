import type { QueryableModuleConsts } from '@polkadot/api-base/types';
import type { u8 } from '@polkadot/types-codec';
import { u8aToHex, type SubmittableExtrinsic } from '@argonprotocol/mainchain';
import { stringToU8a } from '@polkadot/util';
import { blake2AsU8a } from '@polkadot/util-crypto';
import type { ArgonClient } from './MainchainClients.js';
import type { IOperationalAccessProof } from './OperationalAccessProof.js';
import type { TxSigner } from './TxSigner.js';

/** Build a registration authorized by the operational key; the caller chooses its submitter. */
export function buildOperationalRegistration(args: {
  client: ArgonClient;
  operationalAccount: TxSigner;
  vaultAccount: TxSigner;
  miningAccount: TxSigner;
  encryptionPubkey: Uint8Array;
  accessProof: IOperationalAccessProof | null;
}): SubmittableExtrinsic {
  const { client, operationalAccount, vaultAccount, miningAccount, encryptionPubkey, accessProof } = args;
  // The registration shape is shared. The deployed runtime has no proof-version constant;
  // the upgraded runtime publishes a u8 selecting its stricter signing contract.
  const constants: QueryableModuleConsts = client.raw.consts.operationalAccounts;
  const proofVersion = (constants.registrationProofVersion as u8 | undefined)?.toNumber();
  if (proofVersion !== undefined && proofVersion !== 2) {
    throw new Error('Unsupported operational registration proof version. Update the app before registering.');
  }

  let payload: Uint8Array;
  if (proofVersion === 2) {
    // Proof signatures are excluded, including the upstream invite signature.
    payload = client.registry
      .createType('(Bytes,H256,AccountId,AccountId,AccountId,[u8;32],Option<AccountId>)', [
        u8aToHex(stringToU8a('argon/operational-registration/v2')),
        client.genesisHash,
        operationalAccount.address,
        vaultAccount.address,
        miningAccount.address,
        encryptionPubkey,
        accessProof?.upstreamAccount,
      ])
      .toU8a();
  } else {
    payload = client.registry
      .createType('(Bytes,AccountId,AccountId)', [
        u8aToHex(stringToU8a('operational_primary_account')),
        operationalAccount.address,
        operationalAccount.address,
      ])
      .toU8a();
  }
  const operationalSignature = operationalAccount.sign(blake2AsU8a(payload, 256), { withType: true });

  const roleProof = (account: TxSigner, domain: string) => {
    const rolePayload = client.registry
      .createType('(Bytes,AccountId,AccountId)', [
        u8aToHex(stringToU8a(domain)),
        operationalAccount.address,
        account.address,
      ])
      .toU8a();
    return { signature: account.sign(blake2AsU8a(rolePayload, 256), { withType: true }) };
  };

  return client.tx.operationalAccounts.register({
    V1: {
      operationalAccount: operationalAccount.address,
      vaultAccount: vaultAccount.address,
      miningAccount: miningAccount.address,
      encryptionPubkey,
      operationalAccountProof: { signature: operationalSignature },
      vaultAccountProof: roleProof(vaultAccount, 'operational_vault_account'),
      miningAccountProof: roleProof(miningAccount, 'operational_mining_account'),
      accessProof,
    },
  });
}
