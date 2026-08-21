import { expect, it, vi } from 'vitest';
import { getOfflineRegistry, Keyring } from '@argonprotocol/mainchain';
import {
  activateOperationalAccountSetup,
  canRequestOperationsUpgrade,
  ensureOperationalAccountRegistered,
  getOnboardingSetupStatus,
  isValidOperatorName,
  setOperationalProfileName,
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

function createOperationalAccount(name: string) {
  return getOfflineRegistry().createType('Option<PalletOperationalAccountsOperationalAccount>', {
    name: name || null,
  });
}

it.each([
  {
    state: 'before restored chain progress loads',
    hasLoadedInitialOperationalProgress: false,
    isUpgradedToOperations: false,
    expected: false,
  },
  {
    state: 'after an active operational account loads',
    hasLoadedInitialOperationalProgress: true,
    isUpgradedToOperations: true,
    expected: false,
  },
  {
    state: 'after an eligible treasury account loads',
    hasLoadedInitialOperationalProgress: true,
    isUpgradedToOperations: false,
    expected: true,
  },
])('allows an Operations upgrade only $state', params => {
  expect(
    canRequestOperationsUpgrade({
      hasLoadedInitialOperationalProgress: params.hasLoadedInitialOperationalProgress,
      hasExtensionTreasury: true,
      hasCompletedTreasuryCertification: true,
      isUpgradedToOperations: params.isUpgradedToOperations,
    }),
  ).toBe(params.expected);
});

it.each([
  {
    operation: 'a vault',
    hasMiningSeats: false,
    hasVault: true,
    isServerInstalled: true,
    operatorName: 'OperatorOne',
    expected: OnboardingSetupStatus.Finished,
  },
  {
    operation: 'mining seats',
    hasMiningSeats: true,
    hasVault: false,
    isServerInstalled: true,
    operatorName: 'OperatorOne',
    expected: OnboardingSetupStatus.Finished,
  },
  {
    operation: 'no active operation',
    hasMiningSeats: false,
    hasVault: false,
    isServerInstalled: true,
    operatorName: 'OperatorOne',
    expected: OnboardingSetupStatus.Checklist,
  },
])('derives onboarding recovery with $operation', params => {
  const status = getOnboardingSetupStatus({
    hasOnboardingHistory: true,
    hasMiningSeats: params.hasMiningSeats,
    hasVault: params.hasVault,
    isServerInstalled: params.isServerInstalled,
    operatorName: params.operatorName,
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

it('uses the finalized operator profile before repairing an underfunded delegate', async () => {
  const profileTransaction = { tx: { id: 1 } };
  const delegateTransaction = { tx: { id: 2 } };
  const account = vi
    .fn()
    .mockResolvedValueOnce({ data: { free: bigintCodec(999_978n) } })
    .mockResolvedValueOnce({ data: { free: bigintCodec(1_500_000n) } });
  const client = {
    query: {
      operationalAccounts: {
        operationalAccounts: vi.fn().mockResolvedValue(createOperationalAccount('OperatorOne')),
      },
      system: { account },
    },
    tx: {
      operationalAccounts: {},
    },
  };
  const createdVault = {
    vaultId: 7,
    delegateAccountId: 'delegate',
  };
  const finalizedVault = { ...createdVault };
  const load = vi.fn();
  const myVault = {
    createdVault,
    vaults: { operatorNamesByVaultId: { 7: 'OperatorOne' } },
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

it('restores a finalized operator name transaction when the profile query initially lags', async () => {
  const profileTransaction = {
    tx: {
      id: 1,
      metadataJson: { operatorName: 'OperatorOne' },
    },
  };
  let savedOperatorName = '';
  const client = {
    query: {
      operationalAccounts: {
        operationalAccounts: vi.fn(async () => createOperationalAccount(savedOperatorName)),
      },
      system: {
        account: vi.fn().mockResolvedValue({ data: { free: bigintCodec(1_500_000n) } }),
      },
    },
    tx: {
      operationalAccounts: {},
    },
  };
  const createdVault = {
    vaultId: 7,
    delegateAccountId: 'delegate',
  };
  const myVault = {
    createdVault,
    vaults: { operatorNamesByVaultId: {} },
    load: vi.fn(),
    setupVaultInviteProfile: vi.fn(async ({ operatorName }) => {
      savedOperatorName = operatorName;
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
