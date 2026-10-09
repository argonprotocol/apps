import { createVaultingFlowContext, type IVaultingFlowContext } from '../contexts/vaultingContext.ts';
import { sudoFundWallet } from '../helpers/sudoFundWallet.ts';
import { pollEvery } from '../helpers/utils.ts';
import vaultingActivateTab from './Vaulting.op.activateTab.ts';
import { OperationalFlow } from './index.ts';
import type { IE2EFlowRuntime, IE2EOperationInspectState } from '../types.ts';

type SettingsState = IE2EOperationInspectState<{ hasVault: boolean }, { completed: boolean }>;

export default new OperationalFlow<IVaultingFlowContext, SettingsState>(import.meta, {
  description: 'Change vault funding and Bitcoin fees through settings, including closing and reopening progress.',
  defaultTimeoutMs: 120_000,
  createContext: createVaultingFlowContext,
  async inspect({ flow }) {
    const hasVault = await flow.queryApp(refs => !!refs.myVault.createdVault);
    const completed = !!flow.getData('updatedVaultSettings');
    return {
      chainState: { hasVault: !!hasVault },
      uiState: { completed },
      state: completed ? 'complete' : hasVault ? 'runnable' : 'processing',
      blockers: hasVault ? [] : ['Create a vault before changing its settings.'],
    };
  },
  async run({ flow }) {
    await flow.run(vaultingActivateTab);
    await flow.waitFor('VaultingDashboard', { timeoutMs: 60_000 });
    const initial = await flow.queryApp(refs => ({
      argons: refs.myVault.createdVault!.securitizationTarget.toString(),
      argonots: refs.myVault.data.argonotCommitment.heldMicronots.toString(),
      flatFee: (
        refs.myVault.createdVault!.pendingTerms?.[1] ?? refs.myVault.createdVault!.terms
      ).bitcoinBaseFee.toString(),
      walletAddress: refs.wallets.defaultArgonWallet.address,
    }));
    if (!initial) throw new Error('Vault settings are unavailable.');
    await sudoFundWallet({
      address: initial.walletAddress,
      microgons: 1_000_000_000n,
      micronots: 100_000_000n,
      archiveUrl: flow.getData<string>('sessionArchiveUrl'),
    });
    await pollEvery(
      250,
      async () => {
        const available = await flow.queryApp(refs => refs.wallets.defaultArgonWallet.availableMicronots.toString());
        return BigInt(available ?? '0') >= 10_000_000n;
      },
      { timeoutMs: 30_000 },
    );

    await flow.click('Dashboard.openVaultEditOverlay()');
    await flow.click({ selector: '[aria-label="Edit Bitcoin locking fee"]' });
    await flow.type(
      { selector: '[data-testid="EditBoxOverlay"] [data-testid="InputMoney"] [data-testid="input-number"]' },
      '9',
      { clear: true },
    );
    await flow.click('EditBoxOverlay.cancelOverlay()');
    const cancelledFee = await flow.queryApp(refs => refs.config.vaultSetup.btcFlatFee.toString());
    if (cancelledFee !== initial.flatFee) throw new Error('Cancelled Bitcoin fee changes were retained.');

    await flow.click({ selector: '[aria-label="Edit Argon securitization"]' });
    await flow.type({ selector: '[data-testid="settings-funding-amount"] [data-testid="input-number"]' }, '10', {
      clear: true,
    });
    let retriedArgonFee = false;
    await pollEvery(
      250,
      async () => {
        if ((await flow.isVisible('VaultSettingsPanel.submitChange()')).clickable) return true;
        if (retriedArgonFee) return false;
        if (!(await flow.isVisible('VaultSettingsPanel.updateFee()')).clickable) return false;

        retriedArgonFee = true;
        await flow.click('VaultSettingsPanel.updateFee()');
        return false;
      },
      { timeoutMs: 120_000, timeoutMessage: 'ARGN funding draft did not become ready after fee estimation.' },
    );
    await flow.click('VaultSettingsPanel.submitChange()');
    await flow.waitFor({ selector: '[aria-label="Argon securitization transaction in progress"]' });
    await flow.click('VaultSettingsPanel.fundingPopoverOpen = false');
    await flow.click('VaultSettingsPanel.closeOverlay()');
    await flow.click('Dashboard.openVaultEditOverlay()');
    await flow.click({ selector: '[aria-label="Edit Argon securitization"]' });
    await flow.waitFor({ selector: '[aria-label="Securitization editor"]' });
    // Finalization may complete while settings are closed; reopening then shows a new draft.
    const reopenedDraft = await flow.isVisible({
      selector: '[data-testid="settings-funding-amount"] [data-testid="input-number"]',
    });
    if (reopenedDraft.visible) {
      await flow.click('VaultSettingsPanel.fundingPopoverOpen = false');
    } else {
      await flow.waitFor({ selector: '[aria-label="Securitization editor"]' }, { state: 'missing', timeoutMs: 60_000 });
    }
    const addedArgons = await flow.getText('Vault.settings.argn');
    if (!addedArgons.includes(`${((BigInt(initial.argons) + 10_000_000n) / 1_000_000n).toLocaleString('en-US')} ARGN`))
      throw new Error(`Finalized ARGN was not displayed: ${addedArgons}`);

    await flow.click({ selector: '[aria-label="Edit Argonot securitization"]' });
    await flow.type({ selector: '[data-testid="settings-funding-amount"] [data-testid="input-number"]' }, '10', {
      clear: true,
    });
    let retriedArgonotFee = false;
    await pollEvery(
      250,
      async () => {
        if ((await flow.isVisible('VaultSettingsPanel.submitChange()')).clickable) return true;
        if (retriedArgonotFee) return false;
        if (!(await flow.isVisible('VaultSettingsPanel.updateFee()')).clickable) return false;

        retriedArgonotFee = true;
        await flow.click('VaultSettingsPanel.updateFee()');
        return false;
      },
      { timeoutMs: 120_000, timeoutMessage: 'ARGNOT funding draft did not become ready after fee estimation.' },
    );
    await flow.click('VaultSettingsPanel.submitChange()');
    await waitForSecuritizationToFinish(flow);
    const addedArgonots = await flow.getText('Vault.settings.argnot');
    if (
      !addedArgonots.includes(
        `${((BigInt(initial.argonots) + 10_000_000n) / 1_000_000n).toLocaleString('en-US')} ARGNOT`,
      )
    )
      throw new Error(`Finalized ARGNOT was not displayed: ${addedArgonots}`);

    await pollEvery(
      500,
      async () => {
        const committed = await flow.queryApp(refs => refs.myVault.createdVault!.committedMicrogons.toString());
        return BigInt(committed ?? '0') >= BigInt(initial.argons) + 10_000_000n;
      },
      { timeoutMs: 60_000 },
    );
    await flow.click({ selector: '[aria-label="Edit Argon securitization"]' });
    await flow.click({ selector: '[aria-label="Securitization action"] input[value="withdraw"]' });
    await flow.type({ selector: '[data-testid="settings-funding-amount"] [data-testid="input-number"]' }, '10', {
      clear: true,
    });
    let retriedWithdrawalFee = false;
    await pollEvery(
      250,
      async () => {
        if ((await flow.isVisible('VaultSettingsPanel.submitChange()')).clickable) return true;
        if (retriedWithdrawalFee) return false;
        if (!(await flow.isVisible('VaultSettingsPanel.updateFee()')).clickable) return false;

        retriedWithdrawalFee = true;
        await flow.click('VaultSettingsPanel.updateFee()');
        return false;
      },
      { timeoutMs: 120_000, timeoutMessage: 'ARGN withdrawal draft did not become ready after fee estimation.' },
    );
    await flow.click('VaultSettingsPanel.submitChange()');
    await waitForSecuritizationToFinish(flow);
    const withdrawal = await flow.queryApp(refs => ({
      target: refs.myVault.createdVault!.securitizationTarget.toString(),
      pending: refs.myVault
        .createdVault!.scheduledArgonWithdrawals.reduce((total, [, amount]) => total + amount, 0n)
        .toString(),
    }));
    if (withdrawal?.target !== initial.argons || withdrawal.pending !== '10000000')
      throw new Error('Withdraw did not lower the finalized ARGN target and schedule the committed funds.');
    const settingsText = await flow.getText('VaultSettingsPanel');
    if (!/\b10\s+ARGN\b/.test(settingsText) || !settingsText.includes('Eligible'))
      throw new Error('The finalized ARGN withdrawal was not displayed in Exit Schedule.');

    await flow.click({ selector: '[aria-label="Edit Bitcoin locking fee"]' });
    await flow.type(
      { selector: '[data-testid="EditBoxOverlay"] [data-testid="InputMoney"] [data-testid="input-number"]' },
      '3',
      { clear: true },
    );
    // The fee transaction finalizes before Config saves.
    // Fail only the subsequent local write to exercise retry after chain success.
    await flow.queryApp(refs => {
      const { db } = refs;
      const execute = db.execute.bind(db);
      db.execute = async (query, values) => {
        if (query.startsWith('INSERT INTO Config') && values?.includes('vaultSetup')) {
          db.execute = execute;
          throw new Error('Synthetic vault settings persistence failure');
        }
        return execute(query, values);
      };
    });
    await flow.click('EditBoxOverlay.saveOverlay()');
    await flow.waitFor({ selector: '[data-testid="EditBoxOverlay"] [role="alert"]' }, { timeoutMs: 60_000 });
    const failure = await flow.getText({ selector: '[data-testid="EditBoxOverlay"] [role="alert"]' });
    if (!failure.includes('Synthetic vault settings persistence failure'))
      throw new Error(`Unexpected fee save failure: ${failure}`);
    const editable = await flow.getAttribute(
      { selector: '[data-testid="EditBoxOverlay"] [data-testid="InputMoney"] [data-testid="input-number"]' },
      'contenteditable',
    );
    if (editable !== 'false')
      throw new Error('Finalized Bitcoin fees can still be edited before retry, diverging from the chain.');
    await flow.click('EditBoxOverlay.saveOverlay()');
    await flow.waitFor('EditBoxOverlay', { state: 'missing', timeoutMs: 60_000 });
    const result = await flow.queryApp(refs => {
      const vault = refs.myVault.createdVault!;
      const terms = vault.pendingTerms?.[1] ?? vault.terms;
      return {
        argons: vault.securitizationTarget.toString(),
        argonots: refs.myVault.data.argonotCommitment.heldMicronots.toString(),
        flatFee: terms.bitcoinBaseFee.toString(),
        configuredFlatFee: refs.config.vaultSetup.btcFlatFee.toString(),
      };
    });
    flow.setData('updatedVaultSettings', result);
    await flow.click('VaultSettingsPanel.closeOverlay()');
  },
});

async function waitForSecuritizationToFinish(flow: IE2EFlowRuntime): Promise<void> {
  const editor = { selector: '[aria-label="Securitization editor"]' };
  const retry = 'VaultSettingsPanel.retryChange()';

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await pollEvery(
      250,
      async () => !(await flow.isVisible(editor)).visible || (await flow.isVisible(retry)).clickable,
      {
        timeoutMs: 60_000,
      },
    );
    if (!(await flow.isVisible(editor)).visible) return;

    const action = (await flow.getText(retry)).trim();
    if (action !== 'Try Again') {
      throw new Error(`Securitization transaction could not be reconciled: ${await flow.getText(editor)}`);
    }
    if (attempt === 2) {
      throw new Error(`Securitization still needs retry after two refresh attempts: ${await flow.getText(editor)}`);
    }
    // The command is finalized; this retries the local refresh without submitting it again.
    await flow.click(retry);
  }
}
