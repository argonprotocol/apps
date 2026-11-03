import { expect, it, vi } from 'vitest';
import { WalletSecrets } from '../lib/WalletSecrets.ts';
import { WalletForEthereum } from '../lib/WalletForEthereum.ts';
import { WalletKeys } from '../lib/WalletKeys.ts';
// prettier-ignore
import { BitcoinNetwork, CosignScript, HDKey, bip39, getBip32Version, type ICosignScriptLock } from '@argonprotocol/bitcoin';
import { toArgonEthereumSignature } from '../lib/EthereumKeys.ts';
import type { IWalletRecord } from '../lib/db/WalletsTable.ts';
import { createTestWallet } from './helpers/wallet.ts';
import { getOfflineRegistry, Keyring, u8aToHex } from '@argonprotocol/mainchain';
import { blake2AsU8a, sha256AsU8a, signatureVerify } from '@polkadot/util-crypto';
import { mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';
import { recoverMessageAddress, recoverTransactionAddress, serializeTransaction, type Hex } from 'viem';
import { GlobalCouncil, type IGlobalCouncilApproval } from '../lib/GlobalCouncil.ts';
import type { ArgonClient, MiningFrames } from '@argonprotocol/apps-core';
import type { SubmittableExtrinsic } from '@argonprotocol/mainchain';
import { exposeMasterMnemonic, getWalletKeys } from '../stores/wallets.ts';
import { EncryptionSecret } from '../lib/EncryptionSecret.ts';
import { reactive } from 'vue';

const invokeWithTimeout = vi.hoisted(() => vi.fn<typeof import('../lib/tauriApi.ts').invokeWithTimeout>());
vi.mock('../lib/tauriApi.ts', () => ({ invokeWithTimeout }));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (command: string, args: Record<string, unknown> = {}) => invokeWithTimeout(command, args, 60e3),
}));

it('exports a saved mnemonic before startup without loading account services, including a committed key change', async () => {
  const mnemonic = 'test test test test test test test test test test test junk';
  const key = new Uint8Array(32).fill(7);
  const [encryptedMnemonic] = await EncryptionSecret.encryptWithKey(key, [mnemonic]);
  invokeWithTimeout.mockReset();
  invokeWithTimeout.mockImplementation(async (command, args) => {
    if (command === 'read_wallet_file') {
      if ((args as { filename: string }).filename === 'wallet.tmp.json') return null;
      return JSON.stringify({
        encryptedMnemonic: 'ciphertext-for-replaced-key',
        pendingKeyChange: { encryptedMnemonic, replacements: {} },
      });
    }
    if (command === 'keychain_info') return { method: 'system' };
    if (command === 'keychain_decrypt') {
      return EncryptionSecret.decryptWithKey(key, (args as { ciphertexts: string[] }).ciphertexts);
    }
    throw new Error(`Unexpected native operation: ${command}`);
  });

  await expect(exposeMasterMnemonic()).resolves.toBe(mnemonic);
  expect(() => getWalletKeys()).toThrow('Wallet startup has not finished.');
});

it('signs split council approval calls without reopening the mnemonic for each signature', async () => {
  const mnemonic = 'test test test test test test test test test test test junk';
  const keys = new WalletKeys(
    WalletKeys.deriveIdentity(mnemonic),
    new WalletSecrets({ encryptedMnemonic: 'ciphertext' }),
  );
  let decryptions = 0;
  invokeWithTimeout.mockReset();
  invokeWithTimeout.mockImplementation(async command => {
    if (command === 'keychain_info') return { method: 'none' };
    if (command !== 'keychain_decrypt' || decryptions++) throw new Error('Mnemonic access has ended');
    return [mnemonic];
  });
  keys.initializeSession(mnemonic);
  const council = new GlobalCouncil(Promise.resolve({} as never), keys, {} as MiningFrames, async () => undefined);
  const signatures: Hex[] = [];
  let encodingError: Error | undefined = undefined;
  const client = {
    consts: { crosschainTransfer: { maxQueueApprovalsPerCall: 1 } },
    createType: (_: string, values: Hex[]) => {
      if (encodingError) throw encodingError;
      return values;
    },
    tx: {
      crosschainTransfer: {
        approveQueueEntries: (_: string, values: Hex[]) => {
          signatures.push(...values);
          return {} as SubmittableExtrinsic;
        },
      },
    },
  } as unknown as ArgonClient;
  const hashes = [`0x${'01'.repeat(32)}`, `0x${'02'.repeat(32)}`] as Hex[];
  const approvals = hashes.map(approvalHash => ({ approvalHash })) as IGlobalCouncilApproval[];

  const transactions = await council.buildApprovePendingGatewayUpdateTxs(client, approvals);
  expect(transactions).toHaveLength(2);
  const expected = mnemonicToAccount(mnemonic, { path: keys.councilSignerEthereumHdPath });
  for (let index = 0; index < hashes.length; index++) {
    expect(await recoverMessageAddress({ message: { raw: hashes[index] }, signature: signatures[index] })).toBe(
      expected.address,
    );
  }
  encodingError = new Error('Synthetic transaction encoding failed');
  await expect(council.buildApprovePendingGatewayUpdateTxs(client, approvals)).rejects.toThrow(encodingError);
  expect(signatures).toHaveLength(2);
});

it('keeps session signing available without reopening the mnemonic, but still protects secret export', async () => {
  const mnemonic = 'test test test test test test test test test test test junk';
  const { walletKeys: identity } = createTestWallet(mnemonic);
  const keys = new WalletKeys(
    {
      miningBotAddress: identity.miningBotAddress,
      vaultingAddress: identity.vaultingAddress,
      operationalAddress: identity.operationalAddress,
      ethereumAddress: identity.coreEthereumAddress,
    },
    new WalletSecrets({ encryptedMnemonic: 'synthetic-ciphertext' }),
  );
  invokeWithTimeout.mockReset();
  invokeWithTimeout.mockImplementation(async () => {
    throw new Error('Protected material is unavailable');
  });
  await expect(keys.getOperationalSigner()).rejects.toThrow('Wallet session is not initialized');

  const sessionKeyrings = new Set<Keyring>();
  const derivation = vi.spyOn(Keyring.prototype, 'createFromUri');
  keys.initializeSession(mnemonic);
  const [operational, upstream] = await Promise.all([
    keys.getOperationalSigner(),
    keys.getUpstreamOperatorAuthSigner(),
  ]).finally(() => {
    for (const keyring of derivation.mock.contexts as Keyring[]) sessionKeyrings.add(keyring);
    derivation.mockRestore();
  });
  expect(operational.address).toBe(identity.operationalAddress);
  const expectedUpstream = new Keyring({ type: 'sr25519' }).addFromUri(`${mnemonic}//upstream-operator-auth`);
  expect(upstream.address).toBe(expectedUpstream.address);

  // Subsequent router challenges and SSH reconnects cannot reopen the mnemonic.
  invokeWithTimeout.mockImplementation(async () => {
    throw new Error('Protected material is unavailable');
  });
  const challenge = new TextEncoder().encode('synthetic-router-challenge');
  for (const keypair of [await keys.getOperationalSigner(), await keys.getUpstreamOperatorAuthSigner()]) {
    expect(signatureVerify(challenge, keypair.sign(challenge), keypair.address).isValid).toBe(true);
  }
  const ssh = new Keyring({ type: 'ed25519' }).addFromSeed(await keys.getSshPrivateKeySeed());
  const expectedSsh = new Keyring({ type: 'ed25519' }).addFromUri(`${mnemonic}//ssh-ed25519//1`);
  expect(ssh.publicKey).toEqual(expectedSsh.publicKey);
  // Shared with the native derivation fixture; changing languages must not change identities.
  expect(u8aToHex(await keys.getSshPrivateKeySeed())).toBe(
    '0xf1cc4f14478818dfb68db75362e1f9e09ca76c6470f6f42b6b20c617a576443f',
  );
  const delegateAddress = new Keyring({ type: 'sr25519' }).addFromUri(`${mnemonic}//vaulting//delegate`).address;
  expect((await keys.getVaultDelegateSigner()).address).toBe(delegateAddress);
  expect(sessionKeyrings.size).toBeGreaterThan(0);
  expect([...sessionKeyrings].flatMap(keyring => keyring.getPairs().map(pair => pair.address))).not.toContain(
    delegateAddress,
  );
  expect(await keys.getUpstreamEndpointRecoverySeed()).toBe(
    '0x1fa66170f8c3723323b6dee9e4f38cef836bb3867e22340e8f77934dbd612760',
  );

  for (const path of [keys.defaultArgonKeyReference, '//mining', '//vaulting//delegate']) {
    const pair = await keys.getArgonSigner(path);
    const address = new Keyring({ type: 'sr25519' }).createFromUri(`${mnemonic}${path}`).address;
    expect(signatureVerify(challenge, pair.sign(challenge), address).isValid).toBe(true);
  }
  await expect(keys.exposeMasterMnemonic()).rejects.toThrow('Protected material is unavailable');
});

it.each(['encrypted', 'memory'])('derives the original key identities from a %s secret source', async source => {
  const mnemonic = 'test test test test test test test test test test test junk';
  const identity = WalletKeys.deriveIdentity(mnemonic);
  let keys: WalletKeys;
  if (source === 'memory') {
    keys = WalletKeys.fromMnemonic(mnemonic);
  } else {
    keys = new WalletKeys(identity, new WalletSecrets({ encryptedMnemonic: 'synthetic-ciphertext' }));
  }
  invokeWithTimeout.mockReset();
  invokeWithTimeout.mockImplementation(async command => {
    if (command === 'keychain_info') return { method: 'none' };
    if (source === 'memory' || command !== 'keychain_decrypt')
      throw new Error(`Unexpected native derivation: ${command}`);
    return [mnemonic];
  });

  expect(identity.ethereumAddress).toBe('0x5d2d1735e986a9e0fCBc75DE222d55D3D3B4D272');
  keys.initializeSession(mnemonic);
  expect(keys.sshPublicKey).toBe('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAII94h+za42BaEOCyEfxtDMzYbnBUhArtQZrkTlf+LIS4');
  const challenge = new TextEncoder().encode('synthetic-signing-challenge');
  for (const [pair, address] of [
    [await keys.getDefaultArgonSigner(), identity.vaultingAddress],
    [await keys.getMiningBotSigner(), identity.miningBotAddress],
    [
      await keys.getLegacyMiningHoldSigner(),
      new Keyring({ type: 'sr25519' }).createFromUri(`${mnemonic}//holding`).address,
    ],
  ] as const) {
    expect(pair.address).toBe(address);
    expect(signatureVerify(challenge, pair.sign(challenge), address).isValid).toBe(true);
    expect(pair).not.toHaveProperty('encodePkcs8');
    expect(pair).not.toHaveProperty('toJson');
    expect(pair).not.toHaveProperty('derive');
    expect(reactive(pair)).toBe(pair);
  }
  expect(await keys.exportEthereumPrivateKey()).toBe(
    '0xf5265cc3ba1ffd60761c486e1226178b2eca593c5d139588e647e7eb3351dce6',
  );
  // Frozen outputs from the previous native derivation for this synthetic root.
  expect(u8aToHex(await keys.getOperationalEncryptionKeypair())).toBe(
    '0xd7ecc7670ba24cfe2a5ac77ca4f9869d8958c98456bf7319a39134bdaaaaab4c',
  );
  const path = "m/1018'/0'/1'/0/0'";
  const nativeFixture = HDKey.fromExtendedKey(
    'tprv8jG5xqT4L7DLeAj4xg3ERJZXjN36JMmjWXadt3YctFmx25wU2Y28jnVBYQeswDtndpEWa23TL96i2YFiuNm7KJqUpAjisAPZ9tUPZZjWkCF',
    getBip32Version(BitcoinNetwork.Regtest),
  );
  expect((await keys.getBitcoinPublicKey(path, BitcoinNetwork.Regtest)).publicExtendedKey).toBe(
    nativeFixture.publicExtendedKey,
  );
  const addresses = await keys.getEthereumAddresses([
    keys.ethereumHdPath,
    keys.councilSignerEthereumHdPath,
    ...keys.getMintingAuthorityEthereumHdPaths(2),
  ]);
  expect(new Set(addresses).size).toBe(4);
  await expect(keys.getEthereumAddresses(["m/44'/60'/0'/0/0"])).rejects.toThrow('hardened segments');
});

it('derives previously unseen public keys from the unlocked session without reopening the mnemonic', async () => {
  const mnemonic = 'test test test test test test test test test test test junk';
  const keys = new WalletKeys(
    WalletKeys.deriveIdentity(mnemonic),
    new WalletSecrets({ encryptedMnemonic: 'synthetic-ciphertext' }),
  );
  keys.initializeSession(mnemonic);
  invokeWithTimeout.mockRejectedValue(new Error('Public key queries must not access the keychain'));

  const path = "m/1018'/0'/987'/0/500'";
  const root = HDKey.fromMasterSeed(bip39.mnemonicToSeedSync(mnemonic));
  const expected = root.derive(path);
  try {
    const bitcoin = await keys.getBitcoinPublicKey(path, BitcoinNetwork.Regtest);
    const expectedPublic = new HDKey({
      versions: getBip32Version(BitcoinNetwork.Regtest),
      publicKey: expected.publicKey!,
      chainCode: expected.chainCode!,
      depth: expected.depth,
      index: expected.index,
      parentFingerprint: expected.parentFingerprint,
    });
    expect(bitcoin.publicKey).toEqual(expected.publicKey);
    expect(bitcoin.publicExtendedKey).toBe(expectedPublic.publicExtendedKey);
    expect('privateKey' in bitcoin).toBe(false);

    const ethereumPaths = [keys.ethereumHdPath, keys.getMintingAuthorityEthereumHdPath(500)];
    expect(await keys.getEthereumAddresses(ethereumPaths)).toEqual(
      ethereumPaths.map(path => mnemonicToAccount(mnemonic, { path }).address.toLowerCase()),
    );
    // A second query works even though no keychain operation can succeed in this session.
    expect(await keys.getBitcoinPublicKey(path, BitcoinNetwork.Regtest)).toEqual(bitcoin);
    await expect(keys.exposeMasterMnemonic()).rejects.toThrow('Public key queries must not access the keychain');
  } finally {
    expected.wipePrivateData();
    root.wipePrivateData();
  }
});

it('uses the Substrate URI and the configured default wallet with an in-memory source', async () => {
  const mnemonic = 'test test test test test test test test test test test junk';
  const substrateSuri = '//WalletSecretSource';
  const keys = WalletKeys.fromMnemonic(mnemonic, { substrateSuri });
  invokeWithTimeout.mockReset();
  invokeWithTimeout.mockRejectedValue(new Error('No native secrets exist for this in-memory wallet'));

  const keyring = new Keyring({ type: 'sr25519' });
  const mining = keyring.createFromUri(`${substrateSuri}//mining`);
  const operational = keyring.createFromUri(`${substrateSuri}//operational`);
  const challenge = new TextEncoder().encode('synthetic-development-challenge');
  expect(keys.miningBotAddress).toBe(mining.address);
  expect(signatureVerify(challenge, (await keys.getMiningBotSigner()).sign(challenge), mining.address).isValid).toBe(
    true,
  );
  expect((await keys.getOperationalSigner()).address).toBe(operational.address);
  expect(await keys.exposeMasterMnemonic()).toBe(mnemonic);
  expect(await keys.exportEthereumPrivateKey()).toBe(
    '0xf5265cc3ba1ffd60761c486e1226178b2eca593c5d139588e647e7eb3351dce6',
  );

  const defaultWallet = keyring.createFromUri(`${substrateSuri}//capital`);
  keys.configureDefaultArgonWallet({ address: defaultWallet.address, keyReference: '//capital' });
  const signer = await keys.getDefaultArgonSigner();
  expect(keys.defaultArgonAddress).toBe(defaultWallet.address);
  expect(signatureVerify(challenge, signer.sign(challenge), defaultWallet.address).isValid).toBe(true);

  for (const methodLength of [2, 300]) {
    const payload = getOfflineRegistry().createType(
      'ExtrinsicPayload',
      { method: `0x${'00'.repeat(methodLength)}` },
      { version: 4 },
    );
    const bytes = payload.toU8a({ method: true });
    const message = bytes.length > 256 ? blake2AsU8a(bytes) : bytes;
    const { signature } = payload.sign(signer);
    expect(signature).toMatch(/^0x01[0-9a-f]{128}$/);
    expect(signatureVerify(message, signature, defaultWallet.address).isValid).toBe(true);
  }
});

it('signs for the chosen external wallet without replacing the core Ethereum identity', async () => {
  const mnemonic = 'test test test test test test test test test test test junk';
  const identity = WalletKeys.deriveIdentity(mnemonic);
  const keys = new WalletKeys(identity, new WalletSecrets({ encryptedMnemonic: 'synthetic-core-ciphertext' }));
  const externalPrivateKey = '0x1111111111111111111111111111111111111111111111111111111111111111';
  const external = privateKeyToAccount(externalPrivateKey);
  const record: IWalletRecord = {
    id: 1,
    walletType: 'ethereum',
    name: 'External',
    address: external.address,
    sortOrder: 1,
    secretKind: 'privateKey',
    encryptedSecret: 'synthetic-external-ciphertext',
    createdAt: new Date(),
    updatedAt: new Date(),
  } satisfies IWalletRecord;
  const transaction = {
    type: 'eip1559',
    chainId: 1,
    nonce: 0,
    gas: 21000n,
    maxFeePerGas: 1n,
    maxPriorityFeePerGas: 0n,
    to: '0x0000000000000000000000000000000000000001',
    value: 0n,
  } as const;
  const unsigned = serializeTransaction(transaction);
  invokeWithTimeout.mockReset();
  invokeWithTimeout.mockImplementation(async (command, args) => {
    if (command === 'keychain_info') return { method: 'none' };
    if (command === 'keychain_decrypt') {
      return (args.ciphertexts as string[]).map(ciphertext => {
        if (ciphertext === record.encryptedSecret) return `  ${externalPrivateKey.slice(2)}  `;
        if (ciphertext === 'synthetic-core-ciphertext') return mnemonic;
        throw new Error('Unexpected ciphertext');
      });
    }
    throw new Error(`Unexpected native operation: ${command}`);
  });
  await keys.configureEthereumSignerPolicy({
    chainId: 1,
    gatewayAddress: '0x1111111111111111111111111111111111111111',
    tokenAddresses: [],
  });

  keys.initializeSession(mnemonic);
  keys.initializeEthereumWallet(record, externalPrivateKey);
  const externalSigner = await keys.getEthereumSigner(
    keys.ethereumHdPath,
    new WalletForEthereum(record.address, undefined, record),
  );
  const coreSigner = await keys.getEthereumSigner(keys.ethereumHdPath);
  const externalSignature = await externalSigner.signEthereumTransaction(unsigned);
  expect(
    await recoverTransactionAddress({ serializedTransaction: serializeTransaction(transaction, externalSignature) }),
  ).toBe(external.address);
  const coreSignature = await coreSigner.signEthereumTransaction(unsigned);
  expect(
    await recoverTransactionAddress({ serializedTransaction: serializeTransaction(transaction, coreSignature) }),
  ).toBe(identity.ethereumAddress);

  record.secretKind = 'mnemonic';
  record.derivationPath = "m/44'/60'/0'/0/1";
  record.address = mnemonicToAccount(mnemonic, { path: record.derivationPath as `m/44'/60'/${string}` }).address;
  invokeWithTimeout.mockImplementation(async command => {
    if (command === 'keychain_info') return { method: 'none' };
    if (command === 'keychain_decrypt') return [mnemonic];
    throw new Error(`Unexpected native operation: ${command}`);
  });
  keys.initializeEthereumWallet(record, mnemonic);
  const importedSigner = await keys.getEthereumSigner(
    keys.ethereumHdPath,
    new WalletForEthereum(record.address, undefined, record),
  );
  const importedSignature = await importedSigner.signEthereumTransaction(unsigned);
  expect(
    await recoverTransactionAddress({ serializedTransaction: serializeTransaction(transaction, importedSignature) }),
  ).toBe(mnemonicToAccount(mnemonic, { path: record.derivationPath as `m/44'/60'/${string}` }).address);
  expect(keys.coreEthereumAddress).toBe(identity.ethereumAddress.toLowerCase());
});

it('signs Ethereum locally with the original signatures and chain/token restrictions', async () => {
  const mnemonic = 'test test test test test test test test test test test junk';
  const identity = WalletKeys.deriveIdentity(mnemonic);
  const keys = new WalletKeys(identity, new WalletSecrets({ encryptedMnemonic: 'synthetic-ciphertext' }));
  invokeWithTimeout.mockReset();
  invokeWithTimeout.mockImplementation(async command => {
    if (command === 'keychain_info') return { method: 'none' };
    if (command !== 'keychain_decrypt') throw new Error(`Unexpected native signing: ${command}`);
    return [mnemonic];
  });
  keys.initializeSession(mnemonic);
  const signer = await keys.getEthereumSigner(keys.ethereumHdPath);
  expect(await signer.signMessage({ message: 'hello world' })).toBe(
    '0x4126b820e15feace303bcd40ad56978240bf43cd435f9af2d2ee69e9797053866d4e836424774c690dfe24b59d3b07b7a2c01fb4ac5079c7eb495f0d832862031b',
  );
  expect(toArgonEthereumSignature(await signer.signMessage({ message: { raw: '0x68656c6c6f20776f726c64' } }))).toBe(
    '0x4126b820e15feace303bcd40ad56978240bf43cd435f9af2d2ee69e9797053866d4e836424774c690dfe24b59d3b07b7a2c01fb4ac5079c7eb495f0d8328620300',
  );
  const transaction = {
    type: 'eip1559',
    chainId: 1,
    nonce: 0,
    gas: 21000n,
    maxFeePerGas: 1n,
    maxPriorityFeePerGas: 0n,
    to: '0x1111111111111111111111111111111111111111',
    value: 0n,
  } as const;
  const unsigned = serializeTransaction(transaction);
  await expect(signer.signEthereumTransaction(unsigned)).rejects.toThrow('policy');
  const policy = {
    chainId: 1,
    gatewayAddress: transaction.to,
    tokenAddresses: ['0x2222222222222222222222222222222222222222'],
  };
  await keys.configureEthereumSignerPolicy(policy);
  await expect(signer.signEthereumTransaction(serializeTransaction({ ...transaction, chainId: 2 }))).rejects.toThrow(
    'chain ID',
  );
  const signature = await signer.signEthereumTransaction(unsigned);
  const signed = serializeTransaction(transaction, signature);
  expect(await recoverTransactionAddress({ serializedTransaction: signed })).toBe(identity.ethereumAddress);
  await expect(signer.signEthereumTransaction(signed)).rejects.toThrow('unsigned');
  await expect(signer.signEthereumTransaction(`${unsigned}00`)).rejects.toThrow();

  const permit = {
    tokenAddress: policy.tokenAddresses[0],
    tokenName: 'Synthetic Argon',
    value: 123n,
    nonce: 7n,
    deadline: 2_000_000_000n,
  };
  await expect(
    signer.signEthereumPermit({ ...permit, tokenAddress: '0x3333333333333333333333333333333333333333' }),
  ).rejects.toThrow('not allowed');
  const permitSignature = await signer.signEthereumPermit(permit);
  expect(permitSignature).toEqual({
    v: 28,
    r: '0xc3625ef7e4f24fb26db7b3ba8be12a9696f44af13812386f70ea891d5f313342',
    s: '0x40c32b606e6092111f84a7a5eff7885de7f9890a14e08a397f6ddae3ea297cc4',
  });
  await new WalletKeys(identity).configureEthereumSignerPolicy({ ...policy, chainId: 2 });
  expect(await signer.signEthereumPermit(permit)).toEqual(permitSignature);
});

it('uses the secured Ethereum address as the core wallet authority', () => {
  const { walletKeys } = createTestWallet();
  const record = {
    id: 1,
    walletType: 'ethereum',
    name: 'Imported-looking Core Wallet',
    address: walletKeys.coreEthereumAddress.toUpperCase(),
    sortOrder: 1,
    secretKind: 'privateKey',
    encryptedSecret: 'redundant-secret',
    createdAt: new Date(),
    updatedAt: new Date(),
  } satisfies IWalletRecord;

  expect(walletKeys.isCoreEthereumAddress(record.address)).toBe(true);
  expect(walletKeys.isCoreEthereumWallet(record)).toBe(true);
  expect(walletKeys.isCoreEthereumWallet({ ...record, address: '0x0000000000000000000000000000000000000001' })).toBe(
    false,
  );
});

it('uses the caller-supplied mining capacity and incrementally reuses generated subaccounts', async () => {
  const { walletKeys: sourceWalletKeys } = createTestWallet();
  const walletKeys = new WalletKeys({
    miningBotAddress: sourceWalletKeys.miningBotAddress,
    vaultingAddress: sourceWalletKeys.defaultArgonAddress,
    operationalAddress: sourceWalletKeys.operationalAddress,
    ethereumAddress: sourceWalletKeys.coreEthereumAddress,
  });

  const fallbackSubaccounts = await walletKeys.getMiningBotSubaccounts();
  const fallbackValues = Object.values(fallbackSubaccounts);

  expect(fallbackValues).toHaveLength(144);
  expect(fallbackValues[0]?.index).toBe(0);
  expect(fallbackValues[143]?.index).toBe(143);

  const runtimeSubaccounts = await walletKeys.getMiningBotSubaccounts(150);
  const runtimeValues = Object.values(runtimeSubaccounts);

  expect(runtimeSubaccounts).toBe(fallbackSubaccounts);
  expect(runtimeValues).toHaveLength(150);
  expect(runtimeValues[149]?.index).toBe(149);

  const expandedSubaccounts = await walletKeys.getMiningBotSubaccounts(152);
  const expandedValues = Object.values(expandedSubaccounts);

  expect(expandedSubaccounts).toBe(runtimeSubaccounts);
  expect(expandedValues).toHaveLength(152);
  expect(expandedValues[150]?.index).toBe(150);
  expect(expandedValues[151]?.index).toBe(151);

  const reusedSubaccounts = await walletKeys.getMiningBotSubaccounts(140);

  expect(reusedSubaccounts).toBe(expandedSubaccounts);
  expect(Object.values(reusedSubaccounts)).toHaveLength(152);
});

it('rejects protected key operations with a recognizable error when signing is unavailable', async () => {
  const { walletKeys: sourceWalletKeys } = createTestWallet();
  const walletKeys = new WalletKeys(
    {
      miningBotAddress: sourceWalletKeys.miningBotAddress,
      vaultingAddress: sourceWalletKeys.defaultArgonAddress,
      operationalAddress: sourceWalletKeys.operationalAddress,
      ethereumAddress: sourceWalletKeys.coreEthereumAddress,
    },
    undefined,
    { canSign: false, canAccessServer: false },
  );

  await expect(walletKeys.getDefaultArgonSigner()).rejects.toMatchObject({
    name: 'WalletSigningUnavailableError',
  });
  await expect(walletKeys.getEthereumSigner(walletKeys.ethereumHdPath)).rejects.toMatchObject({
    name: 'WalletSigningUnavailableError',
  });
});

it('keeps Bitcoin owner and vault signing private while preserving the release transaction', async () => {
  const keys = WalletKeys.fromMnemonic('test test test test test test test test test test test junk');
  const network = BitcoinNetwork.Regtest;
  const ownerPath = "m/84'/0'/0'/0/0";
  const vaultPath = "m/84'/0'/0'/1";
  const owner = await keys.getBitcoinSigner(ownerPath, network);
  const vault = await keys.getBitcoinSigner(vaultPath, network);
  const ownerPublic = await keys.getBitcoinPublicKey(ownerPath, network);
  const vaultPublic = HDKey.fromExtendedKey(
    (await keys.getBitcoinPublicKey(vaultPath, network)).publicExtendedKey,
    getBip32Version(network),
  );
  const lock: ICosignScriptLock = {
    createdAtHeight: 50,
    fundedSatoshis: 100_000n,
    openClaimHeight: 2_000,
    ownerPubkey: u8aToHex(ownerPublic.publicKey),
    p2wshScriptHashHex: '',
    securitizedSatoshis: 100_000n,
    vaultClaimHeight: 1_000,
    vaultClaimPubkey: u8aToHex(vaultPublic.deriveChild(1).publicKey),
    vaultPubkey: u8aToHex(vaultPublic.deriveChild(0).publicKey),
    vaultXpubSources: { parentFingerprint: vaultPublic.identifier!.slice(0, 4), cosignHdIndex: 0 },
  };
  const script = new CosignScript(lock, network);
  lock.p2wshScriptHashHex = script.calculateScriptPubkey();
  const release = {
    releaseRequest: {
      bitcoinNetworkFee: 1_000n,
      destinationSatoshis: 99_000n,
      changeSatoshis: 0n,
      toScriptPubkey: `0x0014${'12'.repeat(20)}`,
    },
    utxos: [{ utxoRef: { txid: `0x${'34'.repeat(32)}`, vout: 0 }, satoshis: 100_000n }],
  };
  const psbt = script.getCosignPsbt(release);
  const expectedTxid = u8aToHex(sha256AsU8a(sha256AsU8a(psbt.unsignedTx)));
  const referenceRoot = HDKey.fromMasterSeed(
    bip39.mnemonicToSeedSync('test test test test test test test test test test test junk'),
    getBip32Version(network),
  );
  const referencePsbt = script.vaultCosignPsbt(psbt, lock, referenceRoot.derive(vaultPath));
  const referenceSignature = referencePsbt.getInput(0).partialSig![0][1];
  const referenceTx = script.cosignAndGenerateTx({
    ...release,
    vaultCosignatures: [referenceSignature],
    ownerXpriv: referenceRoot.derive(ownerPath),
  });

  let exposedKey: HDKey | undefined;
  const vaultCosign = script.vaultCosignPsbt.bind(script);
  const ownerCosign = script.cosignAndGenerateTx.bind(script);
  script.vaultCosignPsbt = (...args) => {
    exposedKey = args[2];
    return vaultCosign(...args);
  };
  script.cosignAndGenerateTx = args => {
    exposedKey = args.ownerXpriv;
    return ownerCosign(args);
  };

  const callerScript = Object.assign(script, lock);
  const signedPsbt = vault.vaultCosignPsbt(callerScript, psbt);
  const [pubkey, signature] = signedPsbt.getInput(0).partialSig![0];
  expect(u8aToHex(pubkey)).toBe(lock.vaultPubkey);
  expect(signature).toEqual(referenceSignature);
  const tx = owner.cosignAndGenerateTx(callerScript, { ...release, vaultCosignatures: [signature] });
  expect(tx.isFinal).toBe(true);
  expect(`0x${tx.hash}`).toBe(expectedTxid);
  expect(tx.getOutput(0).amount).toBe(99_000n);
  expect(tx.toBytes(true, true)).toEqual(referenceTx.toBytes(true, true));
  expect(exposedKey).toBeUndefined();

  for (const signer of [owner, vault]) {
    expect('privateKey' in signer).toBe(false);
    expect('privateExtendedKey' in signer).toBe(false);
    expect('derive' in signer).toBe(false);
    expect(reactive(signer)).toBe(signer);
  }
});

it('enforces signing availability in memory-backed wallets', async () => {
  const { walletKeys } = createTestWallet('//ReadonlyWalletKeys', { canSign: false, canAccessServer: false });

  await expect(walletKeys.getDefaultArgonSigner()).rejects.toMatchObject({
    name: 'WalletSigningUnavailableError',
  });
  await expect(walletKeys.getEthereumAddresses([walletKeys.ethereumHdPath])).rejects.toMatchObject({
    name: 'WalletSigningUnavailableError',
  });
  const path = "m/1018'/0'/1'/0/0'";
  await expect(walletKeys.getBitcoinSigner(path, BitcoinNetwork.Regtest)).rejects.toMatchObject({
    name: 'WalletSigningUnavailableError',
  });
});
