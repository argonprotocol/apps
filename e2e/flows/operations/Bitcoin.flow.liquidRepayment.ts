import { readFile, writeFile } from 'node:fs/promises';
import { Contract, JsonRpcProvider, Wallet } from 'ethers';
import { createPublicClient, erc20Abi, getAddress, http, type Hex } from 'viem';
import { createArgonClient, StabilizerBuyContracts } from '@argonprotocol/apps-core';
import { EvmContracts, getClient } from '@argonprotocol/mainchain';
import { DEV_ETHEREUM_ADMIN_ACCOUNT, readDevEthereumRuntimeState } from '../../devEthereum.ts';
import { setDevEthereumPoolPrice } from '../../devEthereumStabilization.ts';
import { createBitcoinFlowContext, type IBitcoinFlowContext } from '../contexts/bitcoinContext.ts';
import { createVaultingFlowContext } from '../contexts/vaultingContext.ts';
import type { IE2EOperationInspectState } from '../types.ts';
import bitcoinActivateTab from './Bitcoin.op.activateTab.ts';
import bitcoinCreateLiquid from './Bitcoin.op.createLiquid.ts';
import bitcoinFundLockExact from './Bitcoin.op.fundLockExact.ts';
import bitcoinReadLockFundingDetails from './Bitcoin.op.readLockFundingDetails.ts';
import bitcoinStartBitcoinLock from './Bitcoin.op.startBitcoinLock.ts';
import bitcoinWaitUnlockReady from './Bitcoin.op.waitUnlockReady.ts';
import vaultingOnboarding from './Vaulting.flow.onboarding.ts';
import { OperationalFlow } from './index.ts';

type RepaymentState = IE2EOperationInspectState<
  { liquidId?: number; isPending: boolean; repaidMicrogons: string },
  { detailVisible: boolean; canClose: boolean; canRatchet: boolean }
>;

export default new OperationalFlow<IBitcoinFlowContext, RepaymentState>(import.meta, {
  description: 'Keep a Liquid open while an Ethereum purchase repays it, then restore its actions after settlement.',
  defaultTimeoutMs: 30_000,
  createContext: createBitcoinFlowContext,
  async inspect({ flow }) {
    const [current, detail, close, ratchet] = await Promise.all([
      flow.queryApp(refs => {
        const fissions = refs.getBitcoinFissions();
        const liquid = fissions.getLiquids()[0];
        const repaid =
          liquid?.fissions
            .flatMap(fission => fission.repayments)
            .reduce((sum, repayment) => sum + repayment.liquidityRepaid, 0n) ?? 0n;
        return {
          liquidId: liquid?.liquidId,
          isPending: liquid ? fissions.data.pendingRepaymentLiquidIds.has(liquid.liquidId) : false,
          repaidMicrogons: repaid.toString(),
        };
      }),
      flow.isVisible('BitcoinLiquidDetailOverlay'),
      flow.isVisible('BitcoinLiquidDetailOverlay.openCloseReview'),
      flow.isVisible('BitcoinLiquidDetailOverlay.openRatchetReview'),
    ]);
    const chainState = current ?? { isPending: false, repaidMicrogons: '0' };
    return {
      chainState,
      uiState: { detailVisible: detail.visible, canClose: close.enabled, canRatchet: ratchet.enabled },
      state: BigInt(chainState.repaidMicrogons) > 0n && !chainState.isPending ? 'complete' : 'runnable',
      blockers: [],
    };
  },
  async run({ flow, flowName }) {
    await flow.run(createVaultingFlowContext(flow, flowName), vaultingOnboarding);
    await flow.run(bitcoinStartBitcoinLock);
    await flow.run(bitcoinReadLockFundingDetails);
    await flow.run(bitcoinFundLockExact);
    await flow.run(bitcoinWaitUnlockReady);
    await flow.run(bitcoinActivateTab);
    await flow.run(bitcoinCreateLiquid);

    const connection = await flow.queryApp(refs => ({
      argonAddress: refs.defaultArgonAddress,
      executionRpcUrl: refs.getEthereumOutboundTransferTracker().executionRpcUrl,
      liquidId: refs.getBitcoinFissions().getLiquids()[0].liquidId,
    }));
    if (!connection?.executionRpcUrl) throw new Error('The test app has no Ethereum execution RPC.');
    const ethereum = await readDevEthereumRuntimeState(
      connection.executionRpcUrl,
      flow.getData('devEthereumRuntimeStateDir'),
    );
    const deployment = ethereum?.stabilization?.deployment;
    if (!ethereum || ethereum.setupStatus !== 'ready' || !deployment)
      throw new Error('The Ethereum purchase fixture is not ready.');
    const archiveUrl = flow.getData<string>('sessionArchiveUrl');
    const pricePath = flow.getData<string>('priceIndexFilePath');
    if (!archiveUrl || !pricePath) throw new Error('The isolated test network has no archive or oracle price file.');

    const provider = new JsonRpcProvider(ethereum.executionRpcUrl, undefined, { cacheTimeout: -1 });
    const rawClient = await getClient(archiveUrl);
    try {
      const admin = new Wallet(DEV_ETHEREUM_ADMIN_ACCOUNT.privateKey, provider);
      await setDevEthereumPoolPrice({ signer: admin, ethereum, priceUsdc: '0.60' });
      await flow.poll(this, state => state.uiState.canClose, {
        timeoutMs: 60_000,
        timeoutMessage: 'Close was not available before the repayment purchase.',
      });
      const prices = JSON.parse(await readFile(pricePath, 'utf8'));
      prices.argon_usd_price = 'UNISWAP';
      prices.btc_usd_price = 150_000;
      await writeFile(pricePath, JSON.stringify(prices, null, 2));
      await flow.poll(this, state => state.uiState.canRatchet, {
        timeoutMs: 90_000,
        timeoutMessage: 'Ratchet was not available at the qualifying Bitcoin price before repayment.',
      });

      const client = createArgonClient(rawClient);
      const readyAfterTick = (await client.query.ticks.currentTick()) + 2;
      await flow.poll(this, async () => (await client.query.ticks.currentTick()) >= readyAfterTick, {
        timeoutMs: 30_000,
        timeoutMessage: 'The Liquid is too new to repay.',
      });

      const signed = await flow.command<{ signature: Hex }>('app.signLiquidRepayment', { buyer: admin.address });
      const publicClient = createPublicClient({ transport: http(ethereum.executionRpcUrl) });
      const contracts = new StabilizerBuyContracts(() => publicClient);
      let quote: Awaited<ReturnType<StabilizerBuyContracts['quote']>> | undefined;
      await flow.poll(
        this,
        async () => {
          try {
            quote = await contracts.quote({
              client,
              maxUsdcIn: 100_000_000n,
              slippageBps: 50,
              deadline: (await publicClient.getBlock()).timestamp + 3600n,
              destinationAddress: connection.argonAddress,
              sourceAddress: admin.address,
              quoterAddress: getAddress(deployment.contracts.uniswapV4PriceQuoter.address),
            });
            return true;
          } catch {
            return false;
          }
        },
        { timeoutMs: 60_000, timeoutMessage: 'The below-target repayment quote did not become ready.' },
      );
      if (!quote) throw new Error('The repayment quote is unavailable.');

      const usdc = new Contract(ethereum.usdcTokenAddress, erc20Abi, admin);
      await (await usdc.getFunction('approve')(quote.adapterAddress, quote.request.maxUsdcIn)).wait();
      const adapter = new Contract(quote.adapterAddress, EvmContracts.argonBuyAndTransferAbi, admin);
      const request = {
        ...quote.request,
        repayLiquidId: BigInt(connection.liquidId),
        repaySignature: signed.signature,
      };
      await (await adapter.getFunction('buyAndTransfer')(request, quote.poolKey, '0x')).wait();

      await flow.poll(this, state => state.chainState.isPending, {
        timeoutMs: 180_000,
        timeoutMessage: 'Argon did not admit the authenticated Liquid repayment.',
      });
      const pending = await flow.inspect<RepaymentState, IBitcoinFlowContext>(this);
      if (!pending.uiState.detailVisible || pending.uiState.canClose || pending.uiState.canRatchet) {
        throw new Error('The mounted Liquid detail must disable Close and Ratchet while repayment is pending.');
      }
      await flow.poll(
        this,
        state =>
          !state.chainState.isPending &&
          BigInt(state.chainState.repaidMicrogons) > 0n &&
          state.uiState.canClose &&
          state.uiState.canRatchet,
        {
          timeoutMs: 20 * 60_000,
          timeoutMessage: 'The Liquid did not publish its repayment and restore its actions after settlement.',
        },
      );
    } finally {
      provider.destroy();
      await rawClient.disconnect();
    }
  },
});
