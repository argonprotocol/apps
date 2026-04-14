import {
  ArgonClient,
  getOfflineRegistry,
  Keyring,
  type KeyringPair,
  type SubmittableExtrinsic,
  u8aToHex,
} from '@argonprotocol/mainchain';
import { createDeferred } from '@argonprotocol/apps-core';
import { stringToU8a } from '@polkadot/util';
import { blake2AsU8a, signatureVerify } from '@polkadot/util-crypto';
import { Config } from '../stores/config.ts';
import { getMainchainClient } from '../stores/mainchain.ts';
import { WalletKeys } from './WalletKeys.ts';

const OPERATIONAL_ACCOUNT_PROOF_MESSAGE_KEY = 'operational_primary_account';
const VAULT_ACCOUNT_PROOF_MESSAGE_KEY = 'operational_vault_account';
const MINING_FUNDING_ACCOUNT_PROOF_MESSAGE_KEY = 'operational_mining_funding';
const MINING_BOT_ACCOUNT_PROOF_MESSAGE_KEY = 'operational_mining_bot';

export type IOperationalChainProgress = {
  hasVault: boolean;
  hasUniswapTransfer: boolean;
  hasTreasuryBondParticipation: boolean;
  hasFirstMiningSeat: boolean;
  hasSecondMiningSeat: boolean;
  hasBitcoinLock: boolean;
};

function createOwnershipProof(account: KeyringPair, ownerAddr: string, accountAddr: string, domain: string) {
  const domainBytes = stringToU8a(domain);
  const payload = getOfflineRegistry()
    .createType('(Bytes,AccountId,AccountId)', [u8aToHex(domainBytes), ownerAddr, accountAddr])
    .toU8a();

  const payloadHash = blake2AsU8a(payload, 256);
  const signature = account.sign(payloadHash, { withType: true });

  return {
    signature,
    isValid: signatureVerify(payloadHash, signature, account.publicKey).isValid,
  };
}

function createAccessCodeProof(inviteSecret: string, operationalAddr: string) {
  const invitePair = new Keyring({ type: 'sr25519' }).addFromMnemonic(inviteSecret);
  const domainBytes = stringToU8a('access_code_claim');
  const payload = getOfflineRegistry()
    .createType('(Bytes,Bytes,AccountId)', [u8aToHex(domainBytes), u8aToHex(invitePair.publicKey), operationalAddr])
    .toU8a();
  const payloadHash = blake2AsU8a(payload, 256);
  return {
    public: invitePair.publicKey,
    signature: invitePair.sign(payloadHash),
  };
}

export async function buildOperatorAccountRegistrationTx(args: {
  walletKeys: WalletKeys;
  config: Config;
  client?: ArgonClient;
}): Promise<SubmittableExtrinsic | undefined> {
  const { config, walletKeys } = args;
  const client = args.client ?? (await getMainchainClient(false));
  const existing = await client.query.operationalAccounts.operationalAccounts(walletKeys.operationalAddress);
  if (!existing.isEmpty) return;

  const configuredOperationalAddr = walletKeys.operationalAddress;
  const configuredVaultingAddr = walletKeys.vaultingAddress;
  const configuredMiningHoldAddr = walletKeys.miningHoldAddress;
  const configuredMiningBotAddr = walletKeys.miningBotAddress;
  const inviteSecret = config.upstreamOperator?.inviteSecret?.trim();

  const [operationalAccount, operationalEncryptionKey, vaultingAccount, miningHoldAccount, miningBotAccount] =
    await Promise.all([
      walletKeys.getOperationalKeypair(),
      walletKeys.getOperationalEncryptionKeypair(),
      walletKeys.getVaultingKeypair(),
      walletKeys.getMiningHoldKeypair(),
      walletKeys.getMiningBotKeypair(),
    ]);
  const operationalAddr = operationalAccount.address;
  const vaultingAddr = vaultingAccount.address;
  const miningHoldAddr = miningHoldAccount.address;
  const miningBotAddr = miningBotAccount.address;

  const mismatchedAddresses = {
    operational: configuredOperationalAddr !== operationalAddr ? { configuredOperationalAddr, operationalAddr } : null,
    vaulting: configuredVaultingAddr !== vaultingAddr ? { configuredVaultingAddr, vaultingAddr } : null,
    miningHold: configuredMiningHoldAddr !== miningHoldAddr ? { configuredMiningHoldAddr, miningHoldAddr } : null,
    miningBot: configuredMiningBotAddr !== miningBotAddr ? { configuredMiningBotAddr, miningBotAddr } : null,
  };
  if (Object.values(mismatchedAddresses).some(Boolean)) {
    console.warn('Operational account registration address mismatch detected', mismatchedAddresses);
  }

  const operationalAccountProof = createOwnershipProof(
    operationalAccount,
    operationalAddr,
    operationalAddr,
    OPERATIONAL_ACCOUNT_PROOF_MESSAGE_KEY,
  );
  const vaultAccountProof = createOwnershipProof(
    vaultingAccount,
    operationalAddr,
    vaultingAddr,
    VAULT_ACCOUNT_PROOF_MESSAGE_KEY,
  );
  const miningFundingAccountProof = createOwnershipProof(
    miningHoldAccount,
    operationalAddr,
    miningHoldAddr,
    MINING_FUNDING_ACCOUNT_PROOF_MESSAGE_KEY,
  );
  const miningBotAccountProof = createOwnershipProof(
    miningBotAccount,
    operationalAddr,
    miningBotAddr,
    MINING_BOT_ACCOUNT_PROOF_MESSAGE_KEY,
  );

  return client.tx.operationalAccounts.register({
    V1: {
      operationalAccount: operationalAddr,
      encryptionPubkey: operationalEncryptionKey,
      operationalAccountProof: { signature: operationalAccountProof.signature },
      vaultAccount: vaultingAddr,
      miningFundingAccount: miningHoldAddr,
      miningBotAccount: miningBotAddr,
      vaultAccountProof: { signature: vaultAccountProof.signature },
      miningFundingAccountProof: { signature: miningFundingAccountProof.signature },
      miningBotAccountProof: { signature: miningBotAccountProof.signature },
      accessCode: inviteSecret ? createAccessCodeProof(inviteSecret, operationalAddr) : null,
    },
  });
}

export async function subscribeOperationalAccount(
  walletKeys: WalletKeys,
  onUpdate: (update: IOperationalChainProgress) => void,
  client?: ArgonClient,
) {
  client ??= await getMainchainClient(false);
  const deferred = createDeferred<void>();
  const candidateAddresses = [
    walletKeys.operationalAddress,
    walletKeys.vaultingAddress,
    walletKeys.miningHoldAddress,
    walletKeys.miningBotAddress,
  ];

  const operationalAddress =
    (
      await Promise.all(
        candidateAddresses.map(async address => {
          const linkedOperationalAccount =
            await client.query.operationalAccounts.operationalAccountBySubAccount(address);
          return linkedOperationalAccount.isSome ? linkedOperationalAccount.unwrap().toString() : null;
        }),
      )
    ).find(Boolean) ?? walletKeys.operationalAddress;

  const unsubscribe = await client.query.operationalAccounts.operationalAccounts(operationalAddress, accountRaw => {
    const entry = {
      hasVault: false,
      hasUniswapTransfer: false,
      hasTreasuryBondParticipation: false,
      hasFirstMiningSeat: false,
      hasSecondMiningSeat: false,
      hasBitcoinLock: false,
    };
    if (accountRaw.isSome) {
      const account = accountRaw.unwrap();
      const miningSeatAccrual = account.miningSeatAccrual.toBigInt();

      Object.assign(entry, {
        hasVault: account.vaultCreated.toPrimitive(),
        hasUniswapTransfer: account.hasUniswapTransfer.toPrimitive(),
        hasTreasuryBondParticipation: account.hasTreasuryPoolParticipation.toPrimitive(),
        hasFirstMiningSeat: miningSeatAccrual >= 1n,
        hasSecondMiningSeat: miningSeatAccrual >= 2n,
        hasBitcoinLock: account.bitcoinAccrual.toBigInt() > 0n,
      });
    }
    onUpdate(entry);

    if (!deferred.isResolved) {
      deferred.resolve();
    }
  });

  await deferred.promise;
  return unsubscribe;
}
