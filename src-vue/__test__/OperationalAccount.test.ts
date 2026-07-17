import { expect, it, vi } from 'vitest';
import { Keyring } from '@argonprotocol/mainchain';
import { ensureOperationalAccountRegistered } from '../lib/OperationalAccount.ts';
import { ExtrinsicType } from '../interfaces/ITransactionRecord.ts';
import { bigintCodec } from '../../core/__test__/helpers/codecs.ts';

it('submits operational registration once the treasury wallet can afford it', async () => {
  const keyring = new Keyring({ type: 'sr25519' });
  const operational = keyring.addFromUri('//Operational');
  const vaulting = keyring.addFromUri('//Vaulting');
  const defaultArgon = keyring.addFromUri('//DefaultArgon');
  const miningBot = keyring.addFromUri('//MiningBot');
  const tx = {
    paymentInfo: vi.fn().mockResolvedValue({
      partialFee: bigintCodec(25n),
    }),
  };
  const client = {
    consts: {
      operationalAccounts: {
        minimumBitcoin: bigintCodec(0n),
      },
    },
    query: {
      operationalAccounts: {
        operationalAccounts: vi.fn().mockResolvedValue({ isSome: false }),
        encryptedServerByDownstreamAccount: vi.fn(),
      },
    },
    tx: {
      operationalAccounts: {
        register: vi.fn().mockReturnValue(tx),
      },
    },
  };
  const transactionTracker = {
    load: vi.fn(),
    findLatestTxInfo: vi.fn(),
    getTxAttemptState: vi.fn(),
    submitAndWatch: vi.fn().mockResolvedValue({ tx: { id: 1 } }),
  };
  const walletKeys = {
    operationalAddress: operational.address,
    getOperationalKeypair: vi.fn().mockResolvedValue(operational),
    getOperationalEncryptionKeypair: vi.fn().mockResolvedValue(new Uint8Array(32)),
    getVaultingKeypair: vi.fn().mockResolvedValue(vaulting),
    getDefaultArgonKeypair: vi.fn().mockResolvedValue(defaultArgon),
    getMiningBotKeypair: vi.fn().mockResolvedValue(miningBot),
    getTreasuryKeypair: vi.fn().mockResolvedValue(defaultArgon),
  };

  const txInfo = await ensureOperationalAccountRegistered({
    transactionTracker: transactionTracker as any,
    walletKeys: walletKeys as any,
    accessProof: null,
    availableMicrogons: 25n,
    client: client as any,
  });

  expect(tx.paymentInfo).toHaveBeenCalledWith(defaultArgon.address);
  expect(client.tx.operationalAccounts.register).toHaveBeenCalledWith({
    V1: expect.objectContaining({
      accessProof: null,
    }),
  });
  expect(transactionTracker.submitAndWatch).toHaveBeenCalledWith({
    tx,
    txSigner: defaultArgon,
    useLatestNonce: true,
    extrinsicType: ExtrinsicType.OperationalRegister,
  });
  expect(txInfo).toEqual({ tx: { id: 1 } });
});

it('waits for more treasury funds before submitting operational registration', async () => {
  const keyring = new Keyring({ type: 'sr25519' });
  const operational = keyring.addFromUri('//Operational2');
  const vaulting = keyring.addFromUri('//Vaulting2');
  const defaultArgon = keyring.addFromUri('//DefaultArgon2');
  const miningBot = keyring.addFromUri('//MiningBot2');
  const tx = {
    paymentInfo: vi.fn().mockResolvedValue({
      partialFee: bigintCodec(25n),
    }),
  };
  const client = {
    consts: {
      operationalAccounts: {
        minimumBitcoin: bigintCodec(0n),
      },
    },
    query: {
      operationalAccounts: {
        operationalAccounts: vi.fn().mockResolvedValue({ isSome: false }),
        encryptedServerByDownstreamAccount: vi.fn(),
      },
    },
    tx: {
      operationalAccounts: {
        register: vi.fn().mockReturnValue(tx),
      },
    },
  };
  const transactionTracker = {
    load: vi.fn(),
    findLatestTxInfo: vi.fn(),
    getTxAttemptState: vi.fn(),
    submitAndWatch: vi.fn(),
  };
  const walletKeys = {
    operationalAddress: operational.address,
    getOperationalKeypair: vi.fn().mockResolvedValue(operational),
    getOperationalEncryptionKeypair: vi.fn().mockResolvedValue(new Uint8Array(32)),
    getVaultingKeypair: vi.fn().mockResolvedValue(vaulting),
    getDefaultArgonKeypair: vi.fn().mockResolvedValue(defaultArgon),
    getMiningBotKeypair: vi.fn().mockResolvedValue(miningBot),
    getTreasuryKeypair: vi.fn().mockResolvedValue(defaultArgon),
  };

  const txInfo = await ensureOperationalAccountRegistered({
    transactionTracker: transactionTracker as any,
    walletKeys: walletKeys as any,
    accessProof: null,
    availableMicrogons: 24n,
    client: client as any,
  });

  expect(tx.paymentInfo).toHaveBeenCalledWith(defaultArgon.address);
  expect(client.tx.operationalAccounts.register).toHaveBeenCalledWith({
    V1: expect.objectContaining({
      accessProof: null,
    }),
  });
  expect(transactionTracker.submitAndWatch).not.toHaveBeenCalled();
  expect(txInfo).toBeUndefined();
});

it('waits for the runtime upgrade before submitting an access-proof registration', async () => {
  const keyring = new Keyring({ type: 'sr25519' });
  const operational = keyring.addFromUri('//Operational3');
  const vaulting = keyring.addFromUri('//Vaulting3');
  const defaultArgon = keyring.addFromUri('//DefaultArgon3');
  const miningBot = keyring.addFromUri('//MiningBot3');
  const tx = {
    paymentInfo: vi.fn(),
  };
  const client = {
    query: {
      operationalAccounts: {
        operationalAccounts: vi.fn().mockResolvedValue({ isSome: false }),
      },
    },
    tx: {
      operationalAccounts: {
        register: vi.fn().mockReturnValue(tx),
      },
    },
  };
  const transactionTracker = {
    load: vi.fn(),
    findLatestTxInfo: vi.fn(),
    getTxAttemptState: vi.fn(),
    submitAndWatch: vi.fn(),
  };
  const walletKeys = {
    operationalAddress: operational.address,
    getOperationalKeypair: vi.fn().mockResolvedValue(operational),
    getOperationalEncryptionKeypair: vi.fn().mockResolvedValue(new Uint8Array(32)),
    getVaultingKeypair: vi.fn().mockResolvedValue(vaulting),
    getMiningBotKeypair: vi.fn().mockResolvedValue(miningBot),
    getTreasuryKeypair: vi.fn().mockResolvedValue(defaultArgon),
  };

  const txInfo = await ensureOperationalAccountRegistered({
    transactionTracker: transactionTracker as any,
    walletKeys: walletKeys as any,
    accessProof: {
      upstreamAccount: '//UpstreamOperator',
      signature: '0x1234',
    },
    availableMicrogons: 25n,
    client: client as any,
  });

  expect(client.tx.operationalAccounts.register).not.toHaveBeenCalled();
  expect(transactionTracker.submitAndWatch).not.toHaveBeenCalled();
  expect(tx.paymentInfo).not.toHaveBeenCalled();
  expect(txInfo).toBeUndefined();
});
