import { $, $$, browser, expect } from '@wdio/globals';
import { Key } from 'webdriverio';

import { getClient, TxSubmitter, Keyring } from '@argonprotocol/mainchain';
import clipboard from 'clipboardy';
import { getArchiveUrl } from '../wdio.conf';

it('should be able to start a miner', async () => {
  await $('#app').waitForDisplayed();
  await waitAndClick('WelcomeOverlay.closeOverlay()');
  await waitAndClick('BlankSlate.startSettingUpMiner()');
  await waitAndClick('FinalSetupChecklist.openHowMiningWorksOverlay()'); // click for tour
  await waitAndClick('HowMiningWorks.cancelOverlay()');
  // open the bot rules
  await waitAndClick('FinalSetupChecklist.openBotCreateOverlay()');
  // cancel the tour
  await waitAndClick('BotCreateOverlay.stopSuggestingTour()');
  // set starting bid to 0
  await waitAndClick("BotSettings.openEditBoxOverlay('startingBid')");
  await waitAndClick('input-menu-trigger');
  await waitAndClick('Custom Amount');
  const startingBidInput = await waitForVisible(
    `${makeTestidSelector('startingBidCustomAmount')} ${makeTestidSelector('input-number')}`,
    5e3,
    false,
  );
  await browser.keys([Key.Backspace, Key.Backspace, Key.Backspace, '0']);
  const text = await startingBidInput.getText();
  expect(text).toBe('0.00');
  await waitAndClick('EditBoxOverlay.saveOverlay()');

  await waitAndClick('BotCreateOverlay.saveRules()');
  // fund the wallet
  await waitAndClick('FinalSetupChecklist.openFundMiningAccountOverlay()');
  const micronotsNeededElem = await waitForVisible('Receive.micronotsNeeded');
  const microgonsNeededElem = await waitForVisible('Receive.microgonsNeeded');
  await waitAndClick('CopyToClipboard.copyContent()');
  await new Promise(resolve => setTimeout(resolve, 1000));
  const address = clipboard.readSync();
  expect(address).toBeTruthy();

  const micronotsNeeded = BigInt(await micronotsNeededElem.getAttribute('data-value'));
  const microgonsNeeded = BigInt(await microgonsNeededElem.getAttribute('data-value'));
  expect(micronotsNeeded).toBeGreaterThan(0n);
  expect(microgonsNeeded).toBeGreaterThan(0n);

  // sudo fund the wallet
  const client = await getClient(getArchiveUrl());
  const tx = client.tx.sudo.sudo(
    client.tx.utility.batch([
      client.tx.balances.forceSetBalance(address, microgonsNeeded),
      client.tx.ownership.forceSetBalance(address, micronotsNeeded),
    ]),
  );
  const txSubmitter = new TxSubmitter(client, tx, new Keyring({ type: 'sr25519' }).createFromUri('//Alice'));
  await expect(txSubmitter.submit({ waitForBlock: true })).resolves.not.toThrow();

  // close the wallet overlay
  await Promise.all([waitForVisible('Received.argons', 10e3), waitForVisible('Received.argonots', 10e3)]);
  await waitAndClick('Receive.closeOverlay()');

  // open server connect
  await waitAndClick('FinalSetupChecklist.openServerConnectOverlay()');
  await waitAndClick("ServerConnectOverlay.selectedTab='local'");
  await waitAndClick('ServerConnectOverlay.connect()');

  // takes a second to create the local server
  const launchButton = await waitForVisible('FinalSetupChecklist.launchMiningBot()', 120e3);
  await launchButton.waitForClickable({ timeout: 60e3 });
  await launchButton.click();

  async function didFinishInstall() {
    if (await withTestid('Dashboard').isDisplayed()) {
      return true;
    }
    return await withTestid('FirstAuction').isDisplayed();
  }

  await $('.InstallProgress').waitForDisplayed();
  await browser.waitUntil(
    async () => {
      const steps = $$('.InstallProgressStep');
      if ((await steps.length) === 0) {
        return didFinishInstall();
      }
      await expect($('.InstallProgressStep.Failed')).not.toBeExisting();
      let incompleteSteps = 0;
      for await (const step of steps) {
        const status = await step.getAttribute('data-status');
        expect(status).not.toBe('Failed');
        const text = await step.getText();
        const bar = await step.$('.ProgressBar > div');
        if (!(await bar.isExisting())) {
          console.log(`Step ${text} has no progress bar, retry and check if we're done`);
          return didFinishInstall();
        }
        const progress = await bar.getAttribute('data-progress');
        console.log(`Step ${text} is ${status} (${progress}%)`);
        expect(Number.isNaN(progress)).toBe(false);
        if (parseInt(progress, 10) < 100) {
          incompleteSteps++;
        }
      }
      return incompleteSteps === 0;
    },
    { timeout: 10 * 60e3, interval: 1e3 },
  );

  await waitForVisible('Dashboard', 60e3);
  // should wait for a block mined?
  await browser.waitUntil(
    async () => {
      const elem = await waitForVisible('TotalBlocksMined');
      return parseInt(await elem.getText(), 10) > 0;
    },
    { timeout: 120e3, interval: 5e3, timeoutMsg: 'Expected at least 1 block to be mined after 120s' },
  );
}).timeout(30 * 60e3);

function makeTestidSelector(selector: string) {
  return `[data-testid="${selector}"]`;
}
function withTestid(selector: string) {
  return $(makeTestidSelector(selector));
}

async function waitAndClick(selector: string) {
  const elem = withTestid(selector);
  console.log('Waiting for clickable:', selector);
  await elem.waitForClickable();
  await elem.click();
  console.log('Clicked:', selector);
  return elem;
}

async function waitForVisible(selector: string, timeoutMs = 5e3, isTestId = true) {
  const elem = isTestId ? withTestid(selector) : $(selector);
  console.log('Waiting for visible:', selector);
  await elem.waitForDisplayed({ timeout: timeoutMs });
  console.log('Visible:', selector);
  return elem;
}
