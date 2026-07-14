import { MoveToken } from '@argonprotocol/apps-core';
import { fundDevEthereumWallet } from '../helpers/fundDevEthereumWallet.ts';
import { parsePositiveBigIntInput } from '../helpers/utils.ts';
import { Operation } from './index.ts';
import type { IE2EFlowRuntime, IE2EOperationInspectState } from '../types.ts';
import { WalletType } from '../types/srcVue.ts';
import type { IAppQueryRefs, IEthereumMoveToken, IArgonWalletType } from '../types/srcVue.ts';

const ETHEREUM_MOVE_TIMEOUT_MS = 6 * 60_000;
const EMPTY_FUNDING_STATE = {
  ethereumAddress: '',
  archiveUrl: '',
  ethereumRpcUrl: '',
  ethereumChainConfigReady: false,
  ethereumFetchErrorMsg: '',
  ethereumMicrogons: 0n,
  ethereumMicronots: 0n,
  argnMoveSettled: false,
  argnotMoveSettled: false,
  argnMoveError: '',
  argnotMoveError: '',
};

type IAppFundWalletFromEthereumContext = {
  flow: IE2EFlowRuntime;
  flowName: string;
  input: {
    targetWalletType?: IArgonWalletType;
    extraMicrogons?: bigint | number | string;
  };
};

type IAppFundWalletFromEthereumState = IE2EOperationInspectState<
  Awaited<ReturnType<typeof readEthereumFundingState>>,
  { walletOverlayVisible: boolean }
>;

export default new Operation<IAppFundWalletFromEthereumContext, IAppFundWalletFromEthereumState>(import.meta, {
  inputs: [
    {
      key: 'targetWalletType',
      required: true,
      description: 'Target Argon wallet type: defaultArgon.',
    },
    {
      key: 'extraMicrogons',
      description: 'Optional extra microgons to add on top of the wallet overlay funding requirement.',
    },
  ],
  async inspect(context: IAppFundWalletFromEthereumContext) {
    const targetWalletType = parseTargetWalletType(context.input.targetWalletType);
    const walletOverlay = await context.flow.isVisible('WalletOverlay');
    const chainState = targetWalletType
      ? await readEthereumFundingState(context.flow, targetWalletType)
      : EMPTY_FUNDING_STATE;

    const blockers: string[] = [];
    if (!targetWalletType) {
      blockers.push('Ethereum funding target wallet type is not configured.');
    }
    if (!walletOverlay.visible) {
      blockers.push('Wallet overlay is not visible.');
    }
    if (targetWalletType && walletOverlay.visible && !chainState.ethereumChainConfigReady) {
      blockers.push('Ethereum chain config is still loading on the local Argon network.');
    }
    const fundingRunStarted = context.flow.getData<boolean>('App.op.fundWalletFromEthereum.started') ?? false;
    const isComplete = fundingRunStarted && !walletOverlay.visible;
    const canRun = !!targetWalletType && walletOverlay.visible && chainState.ethereumChainConfigReady;

    return {
      chainState,
      uiState: {
        walletOverlayVisible: walletOverlay.visible,
      },
      state: isComplete ? 'complete' : canRun ? 'runnable' : 'processing',
      blockers: canRun ? [] : blockers,
    };
  },
  async run(context: IAppFundWalletFromEthereumContext, state) {
    if (!state.uiState.walletOverlayVisible) {
      return;
    }

    const targetWalletType = parseTargetWalletType(context.input.targetWalletType);
    if (!targetWalletType) {
      throw new Error('Ethereum funding target wallet type is required.');
    }
    if (!state.chainState.ethereumChainConfigReady) {
      throw new Error('Ethereum chain config is still loading on the local Argon network.');
    }

    context.flow.setData('App.op.fundWalletFromEthereum.started', true);

    const flowName = context.flowName;
    await context.flow.waitFor('WalletOverlay.microgonsNeeded', { timeoutMs: 10_000 });
    await context.flow.waitFor('WalletOverlay.micronotsNeeded', { timeoutMs: 10_000 });

    const microgonsRaw = await context.flow.getAttribute('WalletOverlay.microgonsNeeded', 'data-value', {
      timeoutMs: 1_000,
    });
    const micronotsRaw = await context.flow.getAttribute('WalletOverlay.micronotsNeeded', 'data-value', {
      timeoutMs: 1_000,
    });
    if (!microgonsRaw || !micronotsRaw) {
      throw new Error('Unable to read wallet funding requirements from the wallet overlay.');
    }

    const extraMicrogons = parsePositiveBigIntInput(context.input.extraMicrogons, 'extraMicrogons') ?? 0n;
    const microgons = BigInt(microgonsRaw);
    const micronots = BigInt(micronotsRaw);
    const requiredMicrogons = microgons + extraMicrogons;
    const requiredMicronots = micronots;
    const initialState = await context.flow.inspect<IAppFundWalletFromEthereumState>();

    if (requiredMicrogons > 0n || requiredMicronots > 0n) {
      await fundDevEthereumWallet({
        to: initialState.chainState.ethereumAddress,
        archiveUrl: initialState.chainState.archiveUrl,
        ethereumRpcUrl: initialState.chainState.ethereumRpcUrl,
        microgons: requiredMicrogons > 0n ? requiredMicrogons : undefined,
        micronots: requiredMicronots > 0n ? requiredMicronots : undefined,
      });

      await context.flow.click('WalletOverlay.chooseEthereumWallet()', { timeoutMs: 15_000 });

      await context.flow.poll<IAppFundWalletFromEthereumState>(
        nextState =>
          nextState.chainState.ethereumMicrogons >= initialState.chainState.ethereumMicrogons + requiredMicrogons &&
          nextState.chainState.ethereumMicronots >= initialState.chainState.ethereumMicronots + requiredMicronots,
        {
          timeoutMs: 120_000,
          timeoutMessage: `${flowName}: Ethereum wallet did not load minted ARGN/ARGNOT balances in time.`,
        },
      );

      if (requiredMicrogons > 0n) {
        await startMoveAndWaitForSettlement(context, {
          moveToken: MoveToken.ARGN,
          targetWalletType,
        });
      }

      if (requiredMicronots > 0n) {
        await startMoveAndWaitForSettlement(context, {
          moveToken: MoveToken.ARGNOT,
          targetWalletType,
        });
      }
    }

    console.info(`[E2E] ${flowName} funded ${targetWalletType} wallet through Ethereum`, {
      requestedMicrogons: requiredMicrogons.toString(),
      requestedMicronots: requiredMicronots.toString(),
    });

    const overlayCloseButton = await context.flow.isVisible('OverlayBase.clickClose()');
    if (overlayCloseButton.clickable) {
      await context.flow.click('OverlayBase.clickClose()', { timeoutMs: 8_000 });
    }

    await context.flow.poll<IAppFundWalletFromEthereumState>(nextState => !nextState.uiState.walletOverlayVisible, {
      timeoutMs: 20_000,
      timeoutMessage: `${flowName}: wallet overlay did not close after Ethereum funding.`,
    });
  },
});

async function startMoveAndWaitForSettlement(
  context: IAppFundWalletFromEthereumContext,
  args: {
    moveToken: IEthereumMoveToken;
    targetWalletType: IArgonWalletType;
  },
): Promise<void> {
  const flowName = context.flowName;
  const moveTestId = `EthereumTop.startMoveFromEthereum(${args.moveToken})`;

  await context.flow.waitFor(moveTestId, { timeoutMs: 30_000 });
  await context.flow.click(moveTestId, { timeoutMs: 30_000 });
  await context.flow.waitFor('WalletTransferOverlay.submitTransfer()', { timeoutMs: 30_000 });
  await context.flow.click('WalletTransferOverlay.submitTransfer()', { timeoutMs: 30_000 });

  await context.flow.poll<IAppFundWalletFromEthereumState>(
    nextState => {
      const moveError =
        args.moveToken === MoveToken.ARGN ? nextState.chainState.argnMoveError : nextState.chainState.argnotMoveError;
      if (moveError) {
        throw new Error(
          `${flowName}: Ethereum ${args.moveToken} move failed for ${args.targetWalletType}: ${moveError}`,
        );
      }

      return args.moveToken === MoveToken.ARGN
        ? nextState.chainState.argnMoveSettled
        : nextState.chainState.argnotMoveSettled;
    },
    {
      timeoutMs: ETHEREUM_MOVE_TIMEOUT_MS,
      timeoutMessage: `${flowName}: Ethereum ${args.moveToken} move did not settle for ${args.targetWalletType} in time.`,
    },
  );

  await context.flow.waitFor('WalletTransferOverlay.close()', { timeoutMs: 120_000 });
  await context.flow.click('WalletTransferOverlay.close()', { timeoutMs: 15_000 });
}

async function readEthereumFundingState(flow: IE2EFlowRuntime, targetWalletType: IArgonWalletType) {
  const state = await flow.queryApp(
    async (
      refs: IAppQueryRefs,
      args: {
        targetWalletType: IArgonWalletType;
        argnMoveToken: IEthereumMoveToken;
        argnotMoveToken: IEthereumMoveToken;
      },
    ) => {
      await refs.wallets.load().catch(() => undefined);
      const mainchainClient = await refs.getMainchainClient(false).catch(() => undefined);
      const ethereumMoveTracker = refs.getEthereumMoveTracker();
      const archiveUrl =
        (mainchainClient as { _options?: { provider?: { endpoint?: string } } } | undefined)?._options?.provider
          ?.endpoint ?? '';
      const ethereumChainConfigReady = mainchainClient
        ? await mainchainClient.query.crosschainTransfer
            .chainConfigBySourceChain('Ethereum')
            .then(config => config.isSome && config.unwrap().isEvm)
            .catch(() => false)
        : false;
      const argnTransfer = ethereumMoveTracker.getTransferStateForToken(args.argnMoveToken);
      const argnotTransfer = ethereumMoveTracker.getTransferStateForToken(args.argnotMoveToken);

      return {
        ethereumAddress: refs.wallets.ethereumWallet.address,
        archiveUrl,
        ethereumRpcUrl: refs.getEthereumOutboundTransferTracker().executionRpcUrl ?? '',
        ethereumChainConfigReady,
        ethereumFetchErrorMsg: refs.wallets.ethereumWallet.fetchErrorMsg,
        ethereumMicrogons: refs.wallets.ethereumWallet.availableMicrogons.toString(),
        ethereumMicronots: refs.wallets.ethereumWallet.availableMicronots.toString(),
        argnMoveSettled:
          !argnTransfer.isSubmitting &&
          !argnTransfer.hasPersistedTransfer &&
          argnTransfer.progress.overallProgressPct === 100 &&
          argnTransfer.targetWalletType === args.targetWalletType,
        argnotMoveSettled:
          !argnotTransfer.isSubmitting &&
          !argnotTransfer.hasPersistedTransfer &&
          argnotTransfer.progress.overallProgressPct === 100 &&
          argnotTransfer.targetWalletType === args.targetWalletType,
        argnMoveError: argnTransfer.error,
        argnotMoveError: argnotTransfer.error,
      };
    },
    {
      args: {
        targetWalletType,
        argnMoveToken: MoveToken.ARGN,
        argnotMoveToken: MoveToken.ARGNOT,
      },
      timeoutMs: 30_000,
    },
  );

  if (!state?.ethereumAddress) {
    throw new Error('Unable to read Ethereum funding state from the app.');
  }

  return {
    ethereumAddress: state.ethereumAddress,
    archiveUrl: state.archiveUrl,
    ethereumRpcUrl: state.ethereumRpcUrl,
    ethereumChainConfigReady: state.ethereumChainConfigReady,
    ethereumFetchErrorMsg: state.ethereumFetchErrorMsg,
    ethereumMicrogons: BigInt(state.ethereumMicrogons),
    ethereumMicronots: BigInt(state.ethereumMicronots),
    argnMoveSettled: state.argnMoveSettled,
    argnotMoveSettled: state.argnotMoveSettled,
    argnMoveError: state.argnMoveError,
    argnotMoveError: state.argnotMoveError,
  };
}

function parseTargetWalletType(value: unknown): IArgonWalletType | undefined {
  if (value === WalletType.defaultArgon) {
    return WalletType.defaultArgon;
  }
}
