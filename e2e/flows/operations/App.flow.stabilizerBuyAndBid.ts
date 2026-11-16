import { readFile, writeFile } from 'node:fs/promises';
import { Contract, JsonRpcProvider, Wallet, type ContractTransactionResponse } from 'ethers';
import { createPublicClient, erc20Abi, getAddress, http, toHex } from 'viem';
import { createArgonClient, StabilizerBuy } from '@argonprotocol/apps-core';
import { getClient } from '@argonprotocol/mainchain';
import type { AppSessionOptions } from '../../AppSession.ts';
import { DEV_ETHEREUM_ADMIN_ACCOUNT, readDevEthereumRuntimeState } from '../../devEthereum.ts';
import { setDevEthereumPoolPrice } from '../../devEthereumStabilization.ts';
import { sudoFundWallet } from '../helpers/sudoFundWallet.ts';
import type { IE2EFlowRuntime, IE2EOperationInspectState } from '../types.ts';
import appPrepareAccess from './App.op.prepareAccess.ts';
import { OperationalFlow } from './index.ts';

export const stabilizerBuySessionOptions = {
  ticksBetweenSlots: 60,
  appEnv: { ARGON_DEV_ETHEREUM: '1', STORYBOOK: 'false' },
} satisfies AppSessionOptions;

type BuyAndBidState = IE2EOperationInspectState<
  {
    buyId?: string;
    admissionFrame?: number;
    biddingOpen: boolean;
    latestBid?: number;
    bidCount?: number;
    liquidId?: number;
  },
  { screenVisible: boolean }
>;

export default new OperationalFlow<{ flow: IE2EFlowRuntime; liquidId?: number }, BuyAndBidState>(import.meta, {
  description: 'Buy ARGN below target through the desktop, then submit and revise a native reward bid.',
  defaultTimeoutMs: 30_000,
  createContext: flow => ({ flow }),
  async inspect({ flow, liquidId }) {
    const [current, screen] = await Promise.all([
      flow.queryApp(refs => {
        const buys = refs.getStabilizerBuys();
        const buy = buys.data.buys[0];
        const rewards = buys.data.frameRewards.find(rewards => rewards.admissionFrame === buy?.admissionFrame);
        const position = buys.data.positions.find(position => position.admissionFrame === buy?.admissionFrame);

        return {
          buyId: buy?.id,
          admissionFrame: buy?.admissionFrame,
          biddingOpen: position?.isBiddingOpen(buys.data.currentFrameId) ?? false,
          latestBid: rewards?.latestBid,
          bidCount: rewards?.bidCount,
          liquidId: buy?.repayLiquidId,
        };
      }),
      flow.isVisible('MarketStabilizers'),
    ]);

    const chainState: BuyAndBidState['chainState'] = current ?? { biddingOpen: false };
    const expectedBid = liquidId === undefined ? 40 : 100;
    const expectedBidCount = liquidId === undefined ? 2 : 0;
    const isComplete =
      chainState.latestBid === expectedBid &&
      chainState.bidCount === expectedBidCount &&
      chainState.liquidId === liquidId;
    return {
      chainState,
      uiState: { screenVisible: screen.visible },
      state: isComplete ? 'complete' : 'runnable',
      blockers: [],
    };
  },
  async run({ flow, liquidId }) {
    await flow.run(appPrepareAccess);
    await flow.command('app.waitForReady', { timeoutMs: 120_000 });

    const connection = await flow.queryApp(refs => ({
      argonAddress: refs.defaultArgonAddress,
      ethereumAddress: refs.coreEthereumAddress,
      executionRpcUrl: refs.getEthereumOutboundTransferTracker().executionRpcUrl,
    }));
    if (!connection?.executionRpcUrl) throw new Error('The test app has no Ethereum execution RPC.');

    const ethereum = await readDevEthereumRuntimeState(
      connection.executionRpcUrl,
      flow.getData<string>('devEthereumRuntimeStateDir'),
    );
    if (ethereum?.setupStatus !== 'ready') throw new Error('The local Stabilizer Ethereum fixture is not ready.');

    const provider = new JsonRpcProvider(ethereum.executionRpcUrl, undefined, { cacheTimeout: -1 });
    const publicClient = createPublicClient({ transport: http(ethereum.executionRpcUrl) });
    const buyerAddress = getAddress(connection.ethereumAddress);
    const nonceBefore = await publicClient.getTransactionCount({ address: buyerAddress });
    let poolSqrtPriceX96: bigint;
    try {
      const admin = new Wallet(DEV_ETHEREUM_ADMIN_ACCOUNT.privateKey, provider);
      const usdc = new Contract(ethereum.usdcTokenAddress, erc20Abi, admin);
      const funding: ContractTransactionResponse = await usdc.getFunction('transfer')(
        connection.ethereumAddress,
        100_000_000n,
      );
      await funding.wait();
      await (await admin.sendTransaction({ to: connection.ethereumAddress, value: 10n ** 17n })).wait();
      const poolPrice = await setDevEthereumPoolPrice({ signer: admin, ethereum, priceUsdc: '0.75' });
      poolSqrtPriceX96 = poolPrice.sqrtPriceX96;
    } finally {
      provider.destroy();
    }

    await flow.queryApp(refs => refs.wallets.load());
    await flow.poll(
      this,
      async () => {
        const isDiscovered = await flow.queryApp(refs =>
          refs.wallets.ethereumWallets.persistedWallets.some(
            wallet => wallet.address.toLowerCase() === refs.coreEthereumAddress.toLowerCase(),
          ),
        );
        return isDiscovered ?? false;
      },
      {
        timeoutMs: 30_000,
        timeoutMessage: 'The funded Ethereum wallet was not discovered.',
      },
    );

    if (liquidId === undefined) {
      await sudoFundWallet({
        address: connection.argonAddress,
        archiveUrl: flow.getData<string>('sessionArchiveUrl'),
        microgons: 10_000_000n,
        micronots: 0n,
      });
    }

    const pricePath = flow.getData<string>('priceIndexFilePath');
    if (!pricePath) throw new Error('The isolated test network has no oracle price file.');
    const prices = JSON.parse(await readFile(pricePath, 'utf8'));
    prices.argon_usd_price = 0.75;
    prices.stabilizer_pool_sqrt_price_x96 = toHex(poolSqrtPriceX96);
    await writeFile(pricePath, JSON.stringify(prices, null, 2));
    await flow.poll(
      this,
      async () =>
        (await flow.queryApp(
          (refs, args: { sqrtPriceX96: string }) => {
            const price = refs.getStabilizerBuys().data.market?.prices;
            return (
              price?.argonUsdPrice.eq(0.75) &&
              'stabilizerPoolSqrtPriceX96' in price &&
              price.stabilizerPoolSqrtPriceX96 === BigInt(args.sqrtPriceX96)
            );
          },
          { args: { sqrtPriceX96: poolSqrtPriceX96.toString() } },
        )) ?? false,
      {
        pollMs: 1_000,
        timeoutMs: 180_000,
        timeoutMessage: 'The network did not publish the discounted purchase and pool prices.',
      },
    );

    await flow.click('LeftBar.goto(TopTab.MarketStabilizers)');
    await flow.waitFor('MarketStabilizers');
    await flow.click({
      selector: '[data-testid="MarketStabilizers"] [data-testid="BlankSlate.emit(\'create\')"]',
    });

    const alertInputs = '[data-testid="StabilizerBuyAlertOverlay"] [data-testid="input-number"]';
    await flow.type({ selector: alertInputs, index: 0 }, '0', { clear: true });
    await flow.click('StabilizerBuyAlertOverlay.saveAlert()');
    await flow.poll(
      this,
      async () => {
        const isSaved = await flow.queryApp(async refs => {
          const config = await refs.db.configTable.fetchAllAsObject();
          return config.stabilizerBuyAlert !== undefined;
        });
        return isSaved ?? false;
      },
      {
        timeoutMs: 30_000,
        timeoutMessage: 'The buy alert was not saved for the background watcher.',
      },
    );
    await flow.waitFor('StabilizerBuyOpportunity', { timeoutMs: 180_000 });

    await flow.click({ selector: 'button[aria-label^="Needs attention"]' });
    await flow.click("AlertDetailRow.emit('open')");

    const purchaseInput =
      '[data-testid="StabilizerPurchaseOverlay"] [aria-label="USDC purchase amount"] [data-testid="input-number"]';
    await flow.type({ selector: purchaseInput }, '80', { clear: true });
    if (liquidId !== undefined) {
      const attach = { selector: '[data-testid="StabilizerPurchaseOverlay"] button[aria-label="Attach a Liquid"]' };
      const change = {
        selector: '[data-testid="StabilizerPurchaseOverlay"] button[aria-label="Change Attached Liquid"]',
      };
      const liquidOption = { selector: '[aria-label="Attach a Liquid"] button[aria-pressed]' };
      await flow.click(attach);
      await flow.waitFor(liquidOption, { state: 'clickable', timeoutMs: 60_000 });
      await flow.click(liquidOption);
      await flow.waitFor(change);

      // The selected row is also how the user removes the attachment.
      await flow.click(change);
      await flow.waitFor({ selector: '[aria-label="Attach a Liquid"] button[aria-pressed="true"]' });
      await flow.click(liquidOption);
      await flow.waitFor(attach);
      await flow.click(attach);
      await flow.click(liquidOption);
      await flow.waitFor(change);
    }
    const purchaseButton = {
      selector: '[data-testid="StabilizerPurchaseOverlay"] button[data-testid*="submitPurchase"]',
    };
    await flow.poll(this, async () => (await flow.getText(purchaseButton)).includes('Finalize Purchase'), {
      timeoutMs: 60_000,
      timeoutMessage: 'The below-target quote did not become ready.',
    });
    const purchaseText = await flow.getText('StabilizerPurchaseOverlay');
    if (!purchaseText.includes('30 DAYS'))
      throw new Error('The 30-day holding term must remain 30 days on the accelerated network.');

    await flow.waitFor(purchaseButton, { state: 'clickable', timeoutMs: 30_000 });
    await flow.click(purchaseButton);
    await flow.poll(this, next => !!next.chainState.buyId, {
      timeoutMs: 30_000,
      timeoutMessage: 'The accepted purchase was not saved.',
    });
    await flow.waitFor('StabilizerPurchaseOverlay', { state: 'missing', timeoutMs: 360_000 });
    await flow.waitFor('StabilizerBuyDetailOverlay', { timeoutMs: 30_000 });
    await flow.poll(this, next => next.chainState.biddingOpen, {
      timeoutMs: 360_000,
      timeoutMessage: 'The real Ethereum purchase was not admitted into an open reward-bid frame.',
    });
    if (liquidId === undefined) {
      const bidInput = { selector: '[data-testid="StabilizerBuyDetailOverlay"] [data-testid="input-number"]' };
      const bidButton = 'StabilizerBuyDetailOverlay.submitBid()';
      for (const [index, percent] of [60, 40].entries()) {
        await flow.type(bidInput, String(percent), { clear: true });
        await flow.waitFor(bidButton, { state: 'clickable', timeoutMs: 30_000 });
        await flow.click(bidButton);
        await flow.poll(this, next => next.chainState.latestBid === percent && next.chainState.bidCount === index + 1, {
          timeoutMs: 60_000,
          timeoutMessage: 'The submitted reward bid did not reach the finalized native purchase.',
        });
      }
    }

    const result = await flow.queryApp(async refs => {
      const record = await refs.db.stabilizerBuysTable.fetchAll(refs.defaultArgonAddress);
      const buy = record.buys[0];
      const rewards = record.frameRewards.find(rewards => rewards.admissionFrame === buy.admissionFrame)!;

      return {
        accountAddress: refs.defaultArgonAddress,
        buyId: buy.id,
        admissionFrame: buy.admissionFrame,
        ethereumTxHash: buy.ethereumTxHash,
        spentMicrogons: buy.spentMicrogons?.toString(),
        principal: buy.principal?.toString(),
        latestBid: rewards.latestBid,
        bidCount: rewards.bidCount,
        liquidId: buy.repayLiquidId,
        approvalTxHash: buy.usdcApprovalTxHash,
      };
    });
    if (!result?.ethereumTxHash) throw new Error('The Ethereum purchase transaction was not recorded.');
    if (!result.principal || !result.spentMicrogons)
      throw new Error('The purchase principal and USDC cost were not recorded.');
    if (BigInt(result.principal) <= BigInt(result.spentMicrogons))
      throw new Error('The purchase did not acquire ARGN below target.');
    if (result.liquidId !== liquidId) throw new Error('The Liquid selected in the purchase form was not admitted.');
    if (result.approvalTxHash) throw new Error('The purchase submitted a separate USDC approval transaction.');
    if ((await publicClient.getTransactionCount({ address: buyerAddress })) !== nonceBefore + 1)
      throw new Error('USDC authorization and purchase must use one Ethereum transaction.');

    const client = createArgonClient(await getClient(flow.getData<string>('sessionArchiveUrl')!));
    try {
      const native = await StabilizerBuy.getForAccount(client, result.accountAddress);
      const position = native.positions.find(position => position.admissionFrame === result.admissionFrame);
      if (!position) throw new Error('The purchase is not held in its native admission frame.');
      if (position.heldPrincipal !== BigInt(result.principal))
        throw new Error('The recorded purchase principal does not match native storage.');
      const expectedBid = liquidId === undefined ? 0.4 : 1;
      const expectedBidCount = liquidId === undefined ? 2 : 0;
      if (position.purchase.bidRate.toNumber() !== expectedBid)
        throw new Error('The selected reward bid was not recorded on chain.');
      if (position.purchase.positiveBidCount !== expectedBidCount)
        throw new Error('The reward bid counter does not match the desktop submissions.');
      if (liquidId !== undefined) {
        const repayment = position.liquidRepayments.find(repayment => repayment.liquidId === liquidId);
        if (!repayment) throw new Error('The desktop purchase did not create a native Liquid repayment.');
        // $0.75 / $1.06 must be captured at purchase for the expected refundable premium.
        if (!repayment.purchaseRValue.eq('0.707547169811320754'))
          throw new Error('The Liquid purchase did not capture the expected discounted network price.');
      }
    } finally {
      await client.disconnect();
    }
    flow.setData('stabilizerBuy', result);
  },
});
