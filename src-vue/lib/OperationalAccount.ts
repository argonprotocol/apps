import {
  getOfflineRegistry,
  hexToU8a,
  Keyring,
  type KeyringPair,
  TxSubmitter,
  u8aToHex,
} from '@argonprotocol/mainchain';
import { stringToU8a } from '@polkadot/util';
import { blake2AsU8a, signatureVerify } from '@polkadot/util-crypto';
import { getConfig, Config } from '../stores/config.ts';
import { getMainchainClient } from '../stores/mainchain.ts';
import { getWalletKeys } from '../stores/wallets.ts';

let setupOperatorAccountPromise: Promise<void> | null = null;
export type IOperationalAccountFeePayer = 'vaulting' | 'miningBot';
const OPERATIONAL_ACCOUNT_PROOF_MESSAGE_KEY = 'operational_primary_account';
const VAULT_ACCOUNT_PROOF_MESSAGE_KEY = 'operational_vault_account';
const MINING_FUNDING_ACCOUNT_PROOF_MESSAGE_KEY = 'operational_mining_funding';
const MINING_BOT_ACCOUNT_PROOF_MESSAGE_KEY = 'operational_mining_bot';

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

function createAccessCodeProof(accessCode: string, operationalAddr: string) {
  const accessCodePair = new Keyring({ type: 'sr25519' }).addFromSeed(hexToU8a(accessCode));
  const payload = getOfflineRegistry()
    .createType('([u8;17],[u8;32],AccountId)', [
      stringToU8a('access_code_claim'),
      accessCodePair.publicKey,
      operationalAddr,
    ])
    .toU8a();
  const payloadHash = blake2AsU8a(payload, 256);
  return {
    public: accessCodePair.publicKey,
    signature: accessCodePair.sign(payloadHash),
  };
}

async function registerOperatorAccount(feePayer: IOperationalAccountFeePayer) {
  const config = getConfig();
  if (config.certificationDetails) return;

  const walletKeys = getWalletKeys();
  const client = await getMainchainClient(false);
  const configuredOperationalAddr = walletKeys.operationalAddress;
  const configuredVaultingAddr = walletKeys.vaultingAddress;
  const configuredMiningHoldAddr = walletKeys.miningHoldAddress;
  const configuredMiningBotAddr = walletKeys.miningBotAddress;
  const accessCode = config.bootstrapDetails?.accessCode?.trim();
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

  const foundOperationalAccount = await loadOperationalAccount(config as Config);
  if (foundOperationalAccount) return;

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

  console.log('Operational account proof verification', {
    operationalAddr,
    vaultingAddr,
    miningHoldAddr,
    miningBotAddr,
    proofs: {
      operational: operationalAccountProof.isValid,
      vault: vaultAccountProof.isValid,
      miningFunding: miningFundingAccountProof.isValid,
      miningBot: miningBotAccountProof.isValid,
    },
  });

  const tx = client.tx.operationalAccounts.register({
    V1: {
      operationalAccount: operationalAddr,
      encryptionPubkey: operationalEncryptionKey.publicKey,
      operationalAccountProof: { signature: operationalAccountProof.signature },
      vaultAccount: vaultingAddr,
      miningFundingAccount: miningHoldAddr,
      miningBotAccount: miningBotAddr,
      vaultAccountProof: { signature: vaultAccountProof.signature },
      miningFundingAccountProof: { signature: miningFundingAccountProof.signature },
      miningBotAccountProof: { signature: miningBotAccountProof.signature },
      accessCode: accessCode ? createAccessCodeProof(accessCode, operationalAddr) : null,
    },
  });
  const submitterAccount = feePayer === 'vaulting' ? vaultingAccount : miningBotAccount;
  const txResult = await new TxSubmitter(client, tx, submitterAccount).submit();
  await txResult.waitForInFirstBlock;

  // config.hasOperatorAccount = true;
  await config.save();
}

export async function ensureOperatorAccountRegistered(feePayer: IOperationalAccountFeePayer) {
  if (setupOperatorAccountPromise) {
    await setupOperatorAccountPromise;
    return;
  }

  setupOperatorAccountPromise = registerOperatorAccount(feePayer);
  try {
    await setupOperatorAccountPromise;
  } finally {
    setupOperatorAccountPromise = null;
  }
}

export async function loadOperationalAccount(config: Config): Promise<boolean> {
  const client = await getMainchainClient(false);
  const walletKeys = getWalletKeys();
  const accountRaw = await client.query.operationalAccounts.operationalAccounts(walletKeys.operationalAddress);
  if (accountRaw.isEmpty) return false;

  const account = accountRaw.unwrap().toJSON();
  const details = config.setCertificationDetails({});

  details.hasVault = details.hasVault || (account.vaultCreated as boolean);
  details.hasUniswapTransfer = details.hasUniswapTransfer || (account.hasUniswapTransfer as boolean);
  details.hasTreasuryBondParticipation =
    details.hasTreasuryBondParticipation || (account.hasTreasuryPoolParticipation as boolean);
  details.hasFirstMiningSeat = details.hasFirstMiningSeat || ((account.miningSeatAccrual || 0) as number) >= 1;
  details.hasSecondMiningSeat = details.hasSecondMiningSeat || ((account.miningSeatAccrual || 0) as number) >= 2;
  details.hasBitcoinLock = details.hasBitcoinLock || ((account.bitcoinAccrual || 0) as number) > 0;
  config.certificationDetails = details;

  return true;
}
