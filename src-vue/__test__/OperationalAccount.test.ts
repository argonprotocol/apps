import { expect, it, vi } from 'vitest';
import { Keyring } from '@argonprotocol/mainchain';
import {
  activateOperationalAccountSetup,
  ensureOperationalAccountRegistered,
  getOnboardingSetupStatus,
  isValidOperatorName,
  setOperationalProfileName,
  usesOperationalProfileNameRuntime,
} from '../lib/OperationalAccount.ts';
import { ExtrinsicType } from '../interfaces/ITransactionRecord.ts';
import { OnboardingSetupStatus } from '../interfaces/IConfig.ts';
import { bigintCodec } from '../../core/__test__/helpers/codecs.ts';
import { TxAttemptState } from '../lib/TransactionTracker.ts';
import { normalizeOperatorNameInput } from '../lib/Utils.ts';

const appsCoreMocks = vi.hoisted(() => ({
  getVaultByOperator: vi.fn(),
}));

vi.mock('@argonprotocol/apps-core', async importOriginal => ({
  ...(await importOriginal()),
  getVaultByOperator: appsCoreMocks.getVaultByOperator,
}));

it.each([
  {
    runtime: 'previous runtime with a vault',
    usesOperationalProfile: false,
    hasMiningSeats: false,
    hasVault: true,
    isServerInstalled: true,
    operatorName: 'OperatorOne',
    expected: OnboardingSetupStatus.Finished,
  },
  {
    runtime: 'previous runtime without a vault',
    usesOperationalProfile: false,
    hasMiningSeats: true,
    hasVault: false,
    isServerInstalled: true,
    operatorName: 'OperatorOne',
    expected: OnboardingSetupStatus.Checklist,
  },
  {
    runtime: 'current runtime with mining seats',
    usesOperationalProfile: true,
    hasMiningSeats: true,
    hasVault: false,
    isServerInstalled: true,
    operatorName: 'OperatorOne',
    expected: OnboardingSetupStatus.Finished,
  },
  {
    runtime: 'current runtime with a vault',
    usesOperationalProfile: true,
    hasMiningSeats: false,
    hasVault: true,
    isServerInstalled: true,
    operatorName: 'OperatorOne',
    expected: OnboardingSetupStatus.Finished,
  },
])('derives onboarding recovery for the $runtime', params => {
  const status = getOnboardingSetupStatus({
    hasOnboardingHistory: true,
    hasMiningSeats: params.hasMiningSeats,
    hasVault: params.hasVault,
    isServerInstalled: params.isServerInstalled,
    operatorName: params.operatorName,
    usesOperationalProfile: params.usesOperationalProfile,
  });

  expect(status).toBe(params.expected);
});

it('keeps onboarding at the blank slate without authoritative chain history', () => {
  const status = getOnboardingSetupStatus({
    hasOnboardingHistory: false,
    hasMiningSeats: false,
    hasVault: false,
    isServerInstalled: false,
    operatorName: '',
    usesOperationalProfile: false,
  });

  expect(status).toBe(OnboardingSetupStatus.None);
});

it.each(['Vault', 'FamilyVault', 'VAULTTeam'])('reserves %s from operator names', name => {
  expect(isValidOperatorName(name)).toBe(false);
});

it.each([
  { input: 'argon family!', expected: 'Argonfamily' },
  { input: 'A_rg-on', expected: 'Argon' },
  { input: 'OperatorName123456789', expected: 'OperatorName123456' },
])('normalizes $input while editing an operator name', ({ input, expected }) => {
  expect(normalizeOperatorNameInput(input)).toBe(expected);
});

it('submits a current-runtime profile name with a funded linked signer', async () => {
  const keyring = new Keyring({ type: 'sr25519' });
  const vaulting = keyring.addFromUri('//ProfileVault');
  const tx = { kind: 'set-operational-name' };
  const setName = vi.fn().mockReturnValue(tx);
  Object.assign(setName, { meta: {} });
  const client = {
    query: {
      operationalAccounts: {
        operationalAccounts: vi.fn().mockResolvedValue({ isNone: true }),
      },
    },
    tx: {
      operationalAccounts: { setName },
      vaults: {},
    },
  };
  const transactionTracker = {
    load: vi.fn(),
    findLatestTxAttempt: vi.fn(),
    submitAndWatch: vi.fn().mockResolvedValue({ tx: { id: 1 } }),
  };
  const walletKeys = {
    operationalAddress: 'operator',
    getVaultingKeypair: vi.fn().mockResolvedValue(vaulting),
  };

  const txInfo = await setOperationalProfileName({
    transactionTracker: transactionTracker as any,
    walletKeys: walletKeys as any,
    name: 'OperatorOne',
    client: client as any,
  });

  expect(usesOperationalProfileNameRuntime(client as any)).toBe(true);
  expect(setName).toHaveBeenCalledWith('OperatorOne');
  expect(transactionTracker.submitAndWatch).toHaveBeenCalledWith({
    tx,
    txSigner: vaulting,
    useLatestNonce: true,
    extrinsicType: ExtrinsicType.OperationalSetProfileName,
    metadata: { operatorName: 'OperatorOne' },
  });
  expect(txInfo).toEqual({ tx: { id: 1 } });
});

it('resumes a pending profile name after restart without submitting it again', async () => {
  const pending = {
    tx: {
      extrinsicType: ExtrinsicType.OperationalSetProfileName,
      metadataJson: { operatorName: 'OperatorOne' },
    },
  };
  const setName = vi.fn();
  const client = {
    query: {
      operationalAccounts: {
        operationalAccounts: vi.fn().mockResolvedValue({ isNone: true }),
      },
    },
    tx: {
      operationalAccounts: { setName },
      vaults: {},
    },
  };
  const transactionTracker = {
    load: vi.fn(),
    findLatestTxAttempt: vi.fn().mockResolvedValue({
      txInfo: pending,
      txAttemptState: TxAttemptState.Pending,
    }),
    submitAndWatch: vi.fn(),
  };
  const walletKeys = {
    operationalAddress: 'operator',
    getVaultingKeypair: vi.fn(),
  };

  const txInfo = await setOperationalProfileName({
    transactionTracker: transactionTracker as any,
    walletKeys: walletKeys as any,
    name: 'OperatorOne',
    client: client as any,
  });

  expect(txInfo).toBe(pending);
  expect(setName).not.toHaveBeenCalled();
  expect(transactionTracker.submitAndWatch).not.toHaveBeenCalled();
  expect(walletKeys.getVaultingKeypair).not.toHaveBeenCalled();
});

it('keeps names on vaults while both name extrinsics are available', () => {
  const client = {
    tx: {
      operationalAccounts: { setName: vi.fn() },
      vaults: { setName: vi.fn() },
    },
  };

  expect(usesOperationalProfileNameRuntime(client as any)).toBe(false);
});

it('uses the finalized vault profile before repairing an underfunded delegate', async () => {
  const profileTransaction = { tx: { id: 1 } };
  const delegateTransaction = { tx: { id: 2 } };
  const account = vi
    .fn()
    .mockResolvedValueOnce({ data: { free: bigintCodec(999_978n) } })
    .mockResolvedValueOnce({ data: { free: bigintCodec(1_500_000n) } });
  const client = {
    query: { system: { account } },
    tx: {
      operationalAccounts: {},
      vaults: { setName: vi.fn() },
    },
  };
  const createdVault = {
    name: '',
    delegateAccountId: 'delegate',
  };
  const finalizedVault = {
    ...createdVault,
    name: 'OperatorOne',
  };
  const load = vi
    .fn()
    .mockResolvedValueOnce(undefined)
    .mockImplementationOnce(async () => {
      createdVault.name = 'OperatorOne';
    });
  const myVault = {
    createdVault,
    load,
    setupVaultInviteProfile: vi.fn().mockResolvedValue(profileTransaction),
    ensureVaultDelegateReady: vi.fn().mockResolvedValue(delegateTransaction),
  };
  const transactionTracker = { load: vi.fn() };
  const walletKeys = {
    vaultingAddress: 'vaulting',
    getVaultDelegateKeypair: vi.fn().mockResolvedValue({ address: 'delegate' }),
  };
  const transactions: unknown[] = [];
  appsCoreMocks.getVaultByOperator
    .mockResolvedValueOnce(finalizedVault)
    .mockRejectedValueOnce(new Error('Archive RPC unavailable'));

  const setup = await activateOperationalAccountSetup({
    client: client as any,
    myVault: myVault as any,
    transactionTracker: transactionTracker as any,
    walletKeys: walletKeys as any,
    operatorName: 'OperatorOne',
    onTransaction: async transaction => {
      transactions.push(transaction);
    },
  });

  expect(setup).toEqual({
    operatorName: 'OperatorOne',
    vaultDelegateIsReady: true,
  });
  expect(transactions).toEqual([profileTransaction, delegateTransaction]);
});

it('restores a finalized operator name transaction when the authoritative vault query is unavailable', async () => {
  const profileTransaction = {
    tx: {
      id: 1,
      metadataJson: { vaultName: 'OperatorOne' },
    },
  };
  const client = {
    query: {
      system: {
        account: vi.fn().mockResolvedValue({ data: { free: bigintCodec(1_500_000n) } }),
      },
    },
    tx: {
      operationalAccounts: {},
      vaults: { setName: vi.fn() },
    },
  };
  const createdVault = {
    name: '',
    delegateAccountId: 'delegate',
  };
  const myVault = {
    createdVault,
    load: vi.fn(),
    setupVaultInviteProfile: vi.fn(async ({ operatorName }) => {
      createdVault.name = operatorName;
      return profileTransaction;
    }),
    ensureVaultDelegateReady: vi.fn(),
  };
  const transactionTracker = {
    load: vi.fn(),
    findLatestTxAttempt: vi.fn().mockResolvedValue({
      txInfo: profileTransaction,
      txAttemptState: TxAttemptState.Finalized,
    }),
  };
  const walletKeys = {
    vaultingAddress: 'vaulting',
    getVaultDelegateKeypair: vi.fn().mockResolvedValue({ address: 'delegate' }),
  };
  appsCoreMocks.getVaultByOperator.mockRejectedValue(new Error('Archive RPC unavailable'));

  const setup = await activateOperationalAccountSetup({
    client: client as any,
    myVault: myVault as any,
    transactionTracker: transactionTracker as any,
    walletKeys: walletKeys as any,
    operatorName: '',
    onTransaction: async () => undefined,
  });

  expect(setup).toEqual({
    operatorName: 'OperatorOne',
    vaultDelegateIsReady: true,
  });
});

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
    findLatestTxAttempt: vi.fn(),
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
    findLatestTxAttempt: vi.fn(),
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
    consts: {
      operationalAccounts: {},
    },
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
    findLatestTxAttempt: vi.fn(),
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
