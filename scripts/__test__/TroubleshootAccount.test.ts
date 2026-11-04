import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import Os from 'node:os';
import Path from 'node:path';
import type { ArgonQueryClient } from '@argonprotocol/apps-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveReadonlyAccount, resolveReadonlyInstanceName, writeReadonlyWallet } from '../troubleshootAccount.ts';

const temporaryDirectories: string[] = [];
const operationalAccountId = `5${'o'.repeat(47)}`;
const defaultAccountId = `5${'v'.repeat(47)}`;
const miningAccountId = `5${'m'.repeat(47)}`;

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('troubleshoot account', () => {
  it('resolves an operator name and writes reusable readonly wallet metadata', async () => {
    const profile = {
      vaultAccount: defaultAccountId,
      miningAccount: miningAccountId,
      name: new TextEncoder().encode('Atlas'),
    };
    const client = {
      query: {
        operationalAccounts: {
          operationalAccounts: {
            entries: vi.fn(async () => [[{ args: [operationalAccountId] }, profile]]),
          },
        },
      },
    } as unknown as ArgonQueryClient;

    const identity = await resolveReadonlyAccount(client, { operatorName: 'Atlas' });
    const instanceDirectory = mkdtempSync(Path.join(Os.tmpdir(), 'argon-readonly-wallet-'));
    temporaryDirectories.push(instanceDirectory);

    writeReadonlyWallet(instanceDirectory, identity);

    expect(identity).toEqual({
      operatorName: 'Atlas',
      operationalAccountId,
      defaultAccountId,
      miningAccountId,
    });
    expect(JSON.parse(readFileSync(Path.join(instanceDirectory, 'wallet.json'), 'utf8'))).toEqual({
      encryptedMnemonic: '',
      meta: {
        miningBotAddress: miningAccountId,
        vaultingAddress: defaultAccountId,
        operationalAddress: operationalAccountId,
        ethereumAddress: '',
      },
    });
    const walletPath = Path.join(instanceDirectory, 'wallet.json');
    const contents = readFileSync(walletPath, 'utf8');
    expect(writeReadonlyWallet(instanceDirectory, identity)).toBe(walletPath);
    expect(readFileSync(walletPath, 'utf8')).toBe(contents);
    expect(resolveReadonlyInstanceName(identity)).toBe('atlas-readonly');
  });

  it('resolves a default account through its operational profile', async () => {
    const operationalAccountBySubAccount = vi.fn(async () => operationalAccountId);
    const operationalAccounts = vi.fn(async () => ({
      vaultAccount: defaultAccountId,
      miningBotAccount: miningAccountId,
      name: new TextEncoder().encode('Atlas'),
    }));
    const client = {
      query: {
        operationalAccounts: {
          operationalAccountBySubAccount,
          operationalAccounts,
        },
      },
    } as unknown as ArgonQueryClient;

    await expect(resolveReadonlyAccount(client, { defaultAccountId })).resolves.toEqual({
      operatorName: 'Atlas',
      operationalAccountId,
      defaultAccountId,
      miningAccountId,
    });
    expect(operationalAccountBySubAccount).toHaveBeenCalledWith(defaultAccountId);
    expect(operationalAccounts).toHaveBeenCalledWith(operationalAccountId);
  });

  it('loads an account that is not linked to an operational profile', async () => {
    const operationalAccountBySubAccount = vi.fn(async () => null);
    const client = {
      query: {
        operationalAccounts: {
          operationalAccountBySubAccount,
        },
      },
    } as unknown as ArgonQueryClient;

    const identity = await resolveReadonlyAccount(client, { defaultAccountId });
    const instanceDirectory = mkdtempSync(Path.join(Os.tmpdir(), 'argon-readonly-wallet-'));
    temporaryDirectories.push(instanceDirectory);
    writeReadonlyWallet(instanceDirectory, identity);

    expect(identity).toEqual({
      operatorName: '',
      operationalAccountId: '',
      defaultAccountId,
      miningAccountId: '',
    });
    expect(JSON.parse(readFileSync(Path.join(instanceDirectory, 'wallet.json'), 'utf8')).meta).toEqual(
      expect.objectContaining({
        vaultingAddress: defaultAccountId,
        operationalAddress: '',
        miningBotAddress: '',
      }),
    );
    expect(resolveReadonlyInstanceName(identity)).toBe(
      `account-${defaultAccountId.slice(0, 8).toLowerCase()}-readonly`,
    );
    expect(operationalAccountBySubAccount).toHaveBeenCalledWith(defaultAccountId);
  });

  it('rejects ambiguous operator names with the matching default accounts', async () => {
    const secondDefaultAccountId = `5${'w'.repeat(47)}`;
    const client = {
      query: {
        operationalAccounts: {
          operationalAccounts: {
            entries: vi.fn(async () => [
              [
                { args: [operationalAccountId] },
                {
                  vaultAccount: defaultAccountId,
                  miningAccount: miningAccountId,
                  name: new TextEncoder().encode('Atlas'),
                },
              ],
              [
                { args: [`5${'p'.repeat(47)}`] },
                {
                  vaultAccount: secondDefaultAccountId,
                  miningAccount: `5${'n'.repeat(47)}`,
                  name: new TextEncoder().encode('Atlas'),
                },
              ],
            ]),
          },
        },
      },
    } as unknown as ArgonQueryClient;

    await expect(resolveReadonlyAccount(client, { operatorName: 'Atlas' })).rejects.toThrow(
      `Operator name \"Atlas\" matches multiple accounts: ${defaultAccountId}, ${secondDefaultAccountId}`,
    );
  });

  it('does not accept a linked mining account as the default account', async () => {
    const client = {
      query: {
        operationalAccounts: {
          operationalAccountBySubAccount: vi.fn(async () => operationalAccountId),
          operationalAccounts: vi.fn(async () => ({
            vaultAccount: defaultAccountId,
            miningAccount: miningAccountId,
            name: new TextEncoder().encode('Atlas'),
          })),
        },
      },
    } as unknown as ArgonQueryClient;

    await expect(resolveReadonlyAccount(client, { defaultAccountId: miningAccountId })).rejects.toThrow(
      `${miningAccountId} is linked to Atlas, but it is not the default account ${defaultAccountId}`,
    );
  });

  it('does not reuse a generated wallet after its linked mining account changes', () => {
    const instanceDirectory = mkdtempSync(Path.join(Os.tmpdir(), 'argon-readonly-wallet-'));
    temporaryDirectories.push(instanceDirectory);
    const identity = {
      operatorName: 'Atlas',
      operationalAccountId,
      defaultAccountId,
      miningAccountId,
    };
    writeReadonlyWallet(instanceDirectory, identity);

    expect(() =>
      writeReadonlyWallet(instanceDirectory, {
        ...identity,
        miningAccountId: `5${'n'.repeat(47)}`,
      }),
    ).toThrow(`Refusing to replace the existing wallet at ${Path.join(instanceDirectory, 'wallet.json')}`);
  });
});
