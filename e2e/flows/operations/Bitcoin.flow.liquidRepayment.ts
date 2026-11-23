import { readFile, writeFile } from 'node:fs/promises';
import { JsonRpcProvider, Wallet } from 'ethers';
import BigNumber from 'bignumber.js';
import { toHex } from 'viem';
import { DEV_ETHEREUM_ADMIN_ACCOUNT, readDevEthereumRuntimeState } from '../../devEthereum.ts';
import { setDevEthereumPoolPrice } from '../../devEthereumStabilization.ts';
import { createBitcoinFlowContext, type IBitcoinFlowContext } from '../contexts/bitcoinContext.ts';
import { sudoFundWallet } from '../helpers/sudoFundWallet.ts';
import type { IE2EOperationInspectState } from '../types.ts';
import appStabilizerBuyAndBid from './App.flow.stabilizerBuyAndBid.ts';
import bitcoinActivateTab from './Bitcoin.op.activateTab.ts';
import bitcoinCreateLiquid from './Bitcoin.op.createLiquid.ts';
import bitcoinFundLockExact from './Bitcoin.op.fundLockExact.ts';
import bitcoinReadLockFundingDetails from './Bitcoin.op.readLockFundingDetails.ts';
import bitcoinStartBitcoinLock from './Bitcoin.op.startBitcoinLock.ts';
import bitcoinWaitUnlockReady from './Bitcoin.op.waitUnlockReady.ts';
import { OperationalFlow } from './index.ts';

type RepaymentState = IE2EOperationInspectState<
  {
    liquidId?: number;
    isPending: boolean;
    purchaseComplete: boolean;
    principal: string;
    repaidMicrogons: string;
    returnedMicrogons: string;
    returnedSatoshis: string;
    remainingSatoshis: string;
    bonus: string;
  },
  { detailVisible: boolean; canClose: boolean; canRatchet: boolean }
>;

export default new OperationalFlow<IBitcoinFlowContext, RepaymentState>(import.meta, {
  description: 'Attach a Liquid in the desktop buy form, follow its pending paydown, and verify the completed payout.',
  defaultTimeoutMs: 30_000,
  createContext: createBitcoinFlowContext,
  async inspect({ flow }) {
    const [current, detail, close, ratchet] = await Promise.all([
      flow.queryApp(refs => {
        const fissions = refs.getBitcoinFissions();
        const liquid = fissions.getLiquids()[0];
        const buys = refs.getStabilizerBuys();
        const buy = buys.data.buys.find(buy => liquid && buy.repayLiquidId === liquid.liquidId);
        const rewards = buys.data.frameRewards.find(rewards => rewards.admissionFrame === buy?.admissionFrame);
        const returnedSatoshis =
          liquid?.fissions
            .flatMap(fission => fission.repayments)
            .reduce((sum, repayment) => sum + repayment.satoshis, 0n) ?? 0n;
        return {
          liquidId: liquid?.liquidId,
          isPending: liquid ? fissions.data.pendingRepaymentLiquidIds.has(liquid.liquidId) : false,
          purchaseComplete: String(buy?.status) === 'Complete',
          principal: (buy?.principal ?? 0n).toString(),
          repaidMicrogons: (buy?.liquidRepaymentEvent?.microgonsBurned ?? 0n).toString(),
          returnedMicrogons: (buy?.releasedPrincipal ?? 0n).toString(),
          returnedSatoshis: returnedSatoshis.toString(),
          remainingSatoshis: (liquid?.satoshis ?? 0n).toString(),
          bonus: (rewards?.repaymentRewards?.reduce((sum, reward) => sum + reward.amount, 0n) ?? 0n).toString(),
        };
      }),
      flow.isVisible('BitcoinLiquidDetailOverlay'),
      flow.isVisible('BitcoinLiquidDetailOverlay.openCloseReview'),
      flow.isVisible('BitcoinLiquidDetailOverlay.openRatchetReview'),
    ]);
    if (!current) throw new Error('The desktop Liquid state is unavailable.');
    const isComplete = current.purchaseComplete && BigInt(current.repaidMicrogons) > 0n && !current.isPending;
    return {
      chainState: current,
      uiState: { detailVisible: detail.visible, canClose: close.enabled, canRatchet: ratchet.enabled },
      state: isComplete ? 'complete' : 'runnable',
      blockers: [],
    };
  },
  async run({ flow }) {
    const address = await flow.queryApp(refs => refs.defaultArgonAddress);
    if (!address) throw new Error('The desktop test account is not ready.');
    await sudoFundWallet({
      address,
      archiveUrl: flow.getData<string>('sessionArchiveUrl'),
      microgons: 10_000_000_000n,
      micronots: 0n,
    });

    await flow.run(bitcoinStartBitcoinLock);
    const channelRpcStats = await flow.command('app.getRpcStats', { timeoutMs: 5_000 });
    flow.setData('bitcoinChannelRpcStats', channelRpcStats);
    console.info('[E2E] Bitcoin channel RPC statistics:', JSON.stringify(channelRpcStats));

    await flow.run(bitcoinReadLockFundingDetails);
    await flow.run(bitcoinFundLockExact);
    await flow.run(bitcoinWaitUnlockReady);
    await flow.run(bitcoinActivateTab);
    await flow.run(bitcoinCreateLiquid);

    const connection = await flow.queryApp(refs => {
      const liquid = refs.getBitcoinFissions().getLiquids()[0];
      return {
        executionRpcUrl: refs.getEthereumOutboundTransferTracker().executionRpcUrl,
        liquidId: liquid.liquidId,
        satoshis: liquid.satoshis.toString(),
      };
    });
    if (!connection?.executionRpcUrl) throw new Error('The test app has no Ethereum execution RPC.');
    const ethereum = await readDevEthereumRuntimeState(
      connection.executionRpcUrl,
      flow.getData('devEthereumRuntimeStateDir'),
    );
    if (ethereum?.setupStatus !== 'ready') throw new Error('The Ethereum purchase fixture is not ready.');
    const pricePath = flow.getData<string>('priceIndexFilePath');
    if (!pricePath) throw new Error('The isolated test network has no oracle price file.');
    const prices = JSON.parse(await readFile(pricePath, 'utf8'));
    await flow.poll(this, state => state.uiState.canClose, {
      timeoutMs: 90_000,
      timeoutMessage: 'The Liquid must allow Close before the purchase.',
    });
    await flow.click({
      selector: '[data-testid="BitcoinLiquidDetailOverlay"] [data-testid="OverlayBase.clickClose()"]',
    });
    await flow.waitFor('BitcoinLiquidDetailOverlay', { state: 'missing' });

    await flow.run({ flow, liquidId: connection.liquidId }, appStabilizerBuyAndBid);
    const paydownPanel = { selector: '[data-testid="StabilizerBuyDetailOverlay"] details', index: 0 };
    await flow.waitFor(paydownPanel);
    if ((await flow.getAttribute(paydownPanel, 'open')) !== null)
      throw new Error('Liquid Paydown must be collapsed while bidding is open.');

    await flow.click("StabilizerBuyDetailOverlay.emit('liquid', liquid)");
    await flow.waitFor('BitcoinLiquidDetailOverlay');
    await flow.waitFor('StabilizerBuyDetailOverlay', { state: 'missing' });
    const pending = await flow.poll(this, state => state.chainState.isPending, {
      timeoutMs: 30_000,
      timeoutMessage: 'The attached Liquid did not show its pending repayment.',
    });
    if (!pending.uiState.detailVisible || pending.uiState.canClose || pending.uiState.canRatchet)
      throw new Error('The Liquid must disable Close and Ratchet while the desktop purchase is pending.');
    if (!(await flow.isVisible('MarketStabilizers')).exists)
      throw new Error('Opening the Liquid must keep the Stabilizers tab active.');

    const viewPaydown = "BitcoinLiquidHistoryRow.emit('viewPaydown', entry.paydown.buy.admissionFrame)";
    await flow.click(viewPaydown);
    await flow.waitFor('StabilizerBuyDetailOverlay');
    await flow.click({ selector: '[data-testid="StabilizerBuyDetailOverlay"] button[aria-label="Back"]' });
    await flow.waitFor('BitcoinLiquidDetailOverlay');
    await flow.click({ selector: '[data-testid="BitcoinLiquidDetailOverlay"] button[aria-label="Back"]' });
    await flow.waitFor('StabilizerBuyDetailOverlay');
    await flow.click("StabilizerBuyDetailOverlay.emit('liquid', liquid)");
    await flow.waitFor('BitcoinLiquidDetailOverlay');

    const provider = new JsonRpcProvider(ethereum.executionRpcUrl, undefined, { cacheTimeout: -1 });
    try {
      const admin = new Wallet(DEV_ETHEREUM_ADMIN_ACCOUNT.privateKey, provider);
      // R=0.95 gives the cheapest quote on the current curve; retain it for settlement.
      const recoveryUsdPrice = new BigNumber(prices.argon_usd_target_price).times('0.95');
      const recovery = await setDevEthereumPoolPrice({
        signer: admin,
        ethereum,
        priceUsdc: recoveryUsdPrice.toFixed(),
      });
      prices.argon_usd_price = recoveryUsdPrice.toNumber();
      prices.stabilizer_pool_sqrt_price_x96 = toHex(recovery.sqrtPriceX96);
      await writeFile(pricePath, JSON.stringify(prices, null, 2));
      await flow.poll(
        this,
        async () =>
          (await flow.queryApp(refs =>
            refs
              .getStabilizerBuys()
              .data.positions.flatMap(position => position.liquidRepayments)
              .some(repayment => repayment.observedRValueHighWater?.minus('0.95').abs().lt('0.000000000001')),
          )) ?? false,
        {
          pollMs: 1_000,
          timeoutMs: 180_000,
          timeoutMessage: 'The pending desktop paydown did not retain the cheapest quote.',
        },
      );

      const pullback = await setDevEthereumPoolPrice({ signer: admin, ethereum, priceUsdc: '0.75' });
      prices.argon_usd_price = 0.75;
      prices.stabilizer_pool_sqrt_price_x96 = toHex(pullback.sqrtPriceX96);
      await writeFile(pricePath, JSON.stringify(prices, null, 2));
    } finally {
      provider.destroy();
    }

    const settled = await flow.poll(this, state => state.chainState.purchaseComplete && !state.chainState.isPending, {
      pollMs: 1_000,
      timeoutMs: 20 * 60_000,
      timeoutMessage: 'The desktop Liquid paydown did not publish its completed payout.',
    });
    const result = settled.chainState;
    const principal = BigInt(result.principal);
    const burned = BigInt(result.repaidMicrogons);
    const returned = BigInt(result.returnedMicrogons);
    const returnedSatoshis = BigInt(result.returnedSatoshis);
    if (principal <= 0n || burned <= 0n || returned <= 0n || burned + returned !== principal)
      throw new Error('The completed purchase must split into Liquid repayment and unused ARGN returned.');
    // At $0.75 versus a $1.06 target, settlement at R=0.95 refunds about 15.12%.
    if (Math.abs(Number(returned) / Number(principal) - 0.151193571) > 0.001)
      throw new Error('The completed refund did not retain the independently expected recovery benefit.');
    if (BigInt(result.bonus) !== (burned * 5n) / 100n)
      throw new Error('The default full bid must earn the separate 5% bonus on the amount applied.');
    if (returnedSatoshis <= 0n || BigInt(result.remainingSatoshis) + returnedSatoshis !== BigInt(connection.satoshis))
      throw new Error('The released BTC must reconcile with the Liquid’s remaining BTC.');

    await flow.poll(
      this,
      async state => {
        if (!state.uiState.canClose) return false;
        return (await flow.getText(viewPaydown)).includes('View Paydown');
      },
      {
        timeoutMs: 30_000,
        timeoutMessage: 'The mounted Liquid did not restore Close and show its completed paydown.',
      },
    );
    await flow.click({ selector: '[data-testid="BitcoinLiquidDetailOverlay"] button[aria-label="Back"]' });
    await flow.waitFor('StabilizerBuyDetailOverlay');

    if ((await flow.getAttribute(paydownPanel, 'open')) === null)
      throw new Error('The completed Liquid Paydown must show its payout.');
    const payoutText = (await flow.getText(paydownPanel)).replace(/\s+/g, ' ');
    const appliedText = (Number(burned) / 1_000_000).toLocaleString('en-US', { maximumFractionDigits: 2 });
    const returnedText = (Number(returned) / 1_000_000).toLocaleString('en-US', { maximumFractionDigits: 2 });
    const bitcoinText = (Number(returnedSatoshis) / 100_000_000).toLocaleString('en-US', { maximumFractionDigits: 8 });
    if (
      !payoutText.includes(`₳${appliedText} of your purchase paid down this Liquid.`) ||
      !payoutText.includes(`₳${returnedText} unused and ${bitcoinText} BTC returned to your Internal App Wallet.`)
    )
      throw new Error('The completed paydown must display the actual ARGN applied, unused ARGN, and BTC returned.');
  },
});
