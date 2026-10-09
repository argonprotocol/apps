import { expect, it, vi } from 'vitest';
import { Operation, runOperation } from '../../e2e/flows/operations/index.ts';
import { FinancialPositionBook, reduceFinancialPositions } from '../lib/financials/index.ts';
import { financialGroups } from '../interfaces/IFinancialPosition.ts';

it('waits at post-run validation for a stale financial snapshot to recover', async () => {
  const book = new FinancialPositionBook();
  book.setScope({ ownedAccounts: ['synthetic-account'] });
  const observation = { observedAt: new Date('2026-10-09T12:00:00Z'), blockNumber: 10, blockHash: '0x10' };
  for (const group of financialGroups) book.publish(book.beginRefresh(group), [], observation);

  let uiValidated = false;
  const implementation = {
    postRunTimeoutMs: 1_000,
    async inspect() {
      const financials = reduceFinancialPositions(book.snapshots);
      const complete = uiValidated && financials.readiness === 'ready';
      return {
        state: complete ? 'complete' : 'runnable',
        blockers: complete ? [] : ['financial positions are partial'],
      };
    },
    async run() {
      uiValidated = true;
      book.fail(book.beginRefresh('vaulting'), 'Vault revenue changed during the financial snapshot');
    },
  };
  const operation = new Operation(import.meta, implementation);
  let settled = false;
  const completion = runOperation({}, operation, { throwIfNotReady: true }).then(
    () => {
      settled = true;
    },
    error => {
      settled = true;
      throw error;
    },
  );
  void completion.catch(() => undefined);

  await vi.waitFor(() => expect(reduceFinancialPositions(book.snapshots).readiness).toBe('partial'));
  await new Promise(resolve => setTimeout(resolve, 150));
  expect(settled).toBe(false);
  book.publish(book.beginRefresh('vaulting'), [], observation);
  await completion;
  expect((await operation.inspect({})).state).toBe('complete');
});

it('fails within the post-run budget when financial state remains incomplete', async () => {
  let uiValidated = false;
  const implementation = {
    postRunTimeoutMs: 100,
    async inspect() {
      return {
        state: 'runnable',
        blockers: uiValidated ? ['financial positions are partial'] : ['UI validation pending'],
      };
    },
    async run() {
      uiValidated = true;
    },
  };
  const operation = new Operation(import.meta, implementation);
  const completion = runOperation({}, operation, { throwIfNotReady: true });
  await expect(completion).rejects.toThrow('timed out');
  await expect(completion).rejects.toThrow('financial positions are partial');
  expect((await operation.inspect({})).blockers).toEqual(['financial positions are partial']);
});
