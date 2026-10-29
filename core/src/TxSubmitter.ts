// Source: @argonprotocol/mainchain 1.4.12, the last release that exported this model.
import { waitForLoad } from '@argonprotocol/mainchain';
import type { SignerOptions } from '@polkadot/api-base/types';
import type { SubmittableExtrinsic } from '@polkadot/api/promise/types';
import type { KeyringPair } from '@polkadot/keyring/types';
import type { SignerPayloadJSON } from '@polkadot/types/types';
import { numberToHex } from '@polkadot/util';
import { BlockWatch } from './BlockWatch.js';
import { type ITxProgressCallback, type ITxStatusCallback, TxResult } from './TxResult.js';
import type { ArgonClient } from './MainchainClients.js';

const MINIMUM_MORTAL_PERIOD = 4;
const MAXIMUM_MORTAL_PERIOD = 65_536;
const MAXIMUM_AUTOMATIC_MORTAL_PERIOD = 4096;

export type TxSigningAccount = KeyringPair | { address: string; signer: NonNullable<SignerOptions['signer']> };

export type ISubmittableOptions = Partial<Omit<SignerOptions, 'signer'>> & {
  tip?: bigint;
  logResults?: boolean;
  useLatestNonce?: boolean;
  txProgressCallback?: ITxProgressCallback;
  txStatusCallback?: ITxStatusCallback;
  disableAutomaticTxTracking?: boolean;
};

export class TxSubmitter {
  public readonly address: string;

  constructor(
    public readonly client: ArgonClient,
    public tx: SubmittableExtrinsic,
    public readonly account: TxSigningAccount,
    private readonly blockWatch?: BlockWatch,
  ) {
    this.address = account.address;
  }

  public async feeEstimate(tip?: bigint): Promise<bigint> {
    const { partialFee } = await this.tx.paymentInfo(this.address, { tip });
    return partialFee.toBigInt();
  }

  public async canAfford(
    options: {
      tip?: bigint;
      unavailableBalance?: bigint;
      includeExistentialDeposit?: boolean;
    } = {},
  ): Promise<{ canAfford: boolean; availableBalance: bigint; txFee: bigint }> {
    const { tip, unavailableBalance } = options;
    const account = await this.client.query.system.account(this.address);
    let availableBalance = account.data.free;
    const userBalance = availableBalance;
    if (unavailableBalance) {
      availableBalance -= unavailableBalance;
    }
    const existentialDeposit = options.includeExistentialDeposit ? this.client.consts.balances.existentialDeposit : 0n;
    const fees = await this.feeEstimate(tip);
    const totalCharge = fees + (tip ?? 0n);
    const canAfford = availableBalance >= totalCharge + existentialDeposit;
    return { canAfford, availableBalance: userBalance, txFee: fees };
  }

  public async sign(options: ISubmittableOptions = {}): Promise<SubmittableExtrinsic> {
    const apiOptions = { ...options };
    const { useLatestNonce } = apiOptions;
    delete apiOptions.useLatestNonce;
    delete apiOptions.logResults;
    delete apiOptions.txProgressCallback;
    delete apiOptions.txStatusCallback;
    delete apiOptions.disableAutomaticTxTracking;
    await waitForLoad();
    if (useLatestNonce && apiOptions.nonce === undefined) {
      apiOptions.nonce = await this.client.rpc.system.accountNextIndex(this.address);
    }

    let signingBlockNumber: SignerPayloadJSON['blockNumber'] | undefined;
    if (apiOptions.era === undefined || (typeof apiOptions.era === 'number' && apiOptions.era > 0)) {
      if (this.blockWatch) await this.blockWatch.start();
      const { finalizedBlockHeader: finalized, bestBlockHeader: best } =
        this.blockWatch ?? (await BlockWatch.readCurrentHeaders(this.client));
      // Era 0 skips header lookup; a supplied nonce also avoids a nonce RPC.
      const info = await this.client.derive.tx.signingInfo(this.address, apiOptions.nonce, 0);
      const finalizedNumber = finalized.blockNumber;
      const bestNumber = best.blockNumber;
      const lag = Math.max(0, bestNumber - finalizedNumber);
      const requestedPeriod = typeof apiOptions.era === 'number' ? apiOptions.era : info.mortalLength;
      const era = this.client.registry.createType('ExtrinsicEra', {
        current: finalizedNumber,
        period: Math.min(lag + requestedPeriod, MAXIMUM_AUTOMATIC_MORTAL_PERIOD),
      });
      const validationHeight = Math.max(bestNumber, finalizedNumber) + 1;
      if (validationHeight >= era.asMortalEra.death(finalizedNumber)) {
        throw new Error('Finality is too far behind for transaction mortality. Wait for finality and retry.');
      }
      if (finalizedNumber > 0 && validationHeight - finalizedNumber > this.client.consts.system.blockHashCount) {
        throw new Error('Finalized checkpoint is outside the retained block history. Wait for finality and retry.');
      }

      apiOptions.era = era;
      apiOptions.blockHash = finalized.blockHash;
      apiOptions.nonce = info.nonce;
      signingBlockNumber = numberToHex(finalizedNumber, 32);
    }

    if ('signer' in this.account) {
      const externalSigner = this.account.signer;
      const { signPayload, update } = externalSigner;
      const blockNumber = signingBlockNumber;
      let signer = externalSigner;
      if (blockNumber && signPayload) {
        // Native signing omits this metadata when given an explicit era and checkpoint.
        signer = {
          signPayload: payload => signPayload.call(externalSigner, { ...payload, blockNumber }),
        };
        if (update) signer.update = update.bind(externalSigner);
      }
      return await this.tx.signAsync(this.address, { ...apiOptions, signer });
    }

    return await this.tx.signAsync(this.account, apiOptions);
  }

  public static replacementTip(pendingTip: bigint, minimumIncrease: bigint): bigint {
    const increase = pendingTip / 10n + 1n;
    return pendingTip + (increase > minimumIncrease ? increase : minimumIncrease);
  }

  public async signMortal(args: {
    blockWatch: BlockWatch;
    bestBlockNumber: number;
    validForBlocks: number;
    tip: bigint;
    replacement?: { pendingResult: TxResult; pendingTip: bigint; minimumTipIncrease: bigint };
  }): Promise<{ signedTx: SubmittableExtrinsic; birthBlock: number; deathBlock: number; tip: bigint }> {
    const { blockWatch, bestBlockNumber, validForBlocks, tip: requestedTip, replacement } = args;
    const deathBlock = bestBlockNumber + validForBlocks;
    const finalized = blockWatch.finalizedBlockHeader;
    if (finalized.blockNumber > bestBlockNumber) {
      throw new Error('Finalized signing snapshot is ahead of the best block');
    }

    // Substrate mortal eras only encode power-of-two periods, starting at four blocks.
    let period = MINIMUM_MORTAL_PERIOD;
    while (period < deathBlock - finalized.blockNumber) period *= 2;
    const birthBlock = deathBlock - period;
    if (
      birthBlock < 0 ||
      period > MAXIMUM_MORTAL_PERIOD ||
      bestBlockNumber - birthBlock >= this.client.consts.system.blockHashCount
    ) {
      throw new Error('Cannot sign with the requested deadline against a retained finalized block');
    }

    // Polkadot.js can anchor a numeric era to best's parent when finality lags; use a finalized ancestor explicitly.
    let blockHash = finalized.blockHash;
    if (birthBlock !== finalized.blockNumber) {
      blockHash = await blockWatch.getFinalizedHash(birthBlock);
    }

    const era = this.client.registry.createType('ExtrinsicEra', { current: birthBlock, period });
    if (
      era.asMortalEra.birth(bestBlockNumber) !== birthBlock ||
      era.asMortalEra.death(bestBlockNumber) !== deathBlock
    ) {
      throw new Error('Transaction mortality could not preserve the requested best-block deadline');
    }

    let tip = requestedTip;
    const signingOptions: ISubmittableOptions = { blockHash, era, tip };
    if (replacement) {
      const account = await this.client.query.system.account(this.address);
      // A consumed nonce needs a new submission; an unconsumed nonce can replace the pending transaction.
      if (account.nonce <= replacement.pendingResult.extrinsic.nonce) {
        signingOptions.nonce = replacement.pendingResult.extrinsic.nonce;
        tip = TxSubmitter.replacementTip(replacement.pendingTip, replacement.minimumTipIncrease);
        signingOptions.tip = tip;
      }
    }

    if (signingOptions.nonce === undefined) signingOptions.useLatestNonce = true;

    const signedTx = await this.sign(signingOptions);
    if (
      signedTx.era.asMortalEra.birth(bestBlockNumber) !== birthBlock ||
      signedTx.era.asMortalEra.death(bestBlockNumber) !== deathBlock
    ) {
      throw new Error('Signed transaction mortality differs from the finalized signing snapshot');
    }

    return { signedTx, birthBlock, deathBlock, tip };
  }

  public async submitSigned(signedTx: SubmittableExtrinsic, options: ISubmittableOptions = {}): Promise<TxResult> {
    const blockHeight = await this.client.rpc.chain.getHeader().then(h => h.number.toNumber());
    if (options.logResults) {
      this.logRequest();
    }
    const txHash = signedTx.hash.toHex();
    const result = new TxResult({
      signedHash: txHash,
      method: signedTx.method.toHuman(),
      accountAddress: this.address,
      submittedTime: new Date(),
      submittedAtBlockNumber: blockHeight,
      nonce: signedTx.nonce.toNumber(),
      mortalityPeriod: signedTx.era.isMortalEra ? signedTx.era.asMortalEra.period.toNumber() : 0,
    });
    result.txProgressCallback = options.txProgressCallback;
    result.txStatusCallback = options.txStatusCallback;
    if (options.disableAutomaticTxTracking !== true) {
      await signedTx.send(result.onSubscriptionResult.bind(result, this.client));
    } else {
      try {
        await signedTx.send();
        result.isBroadcast = true;
      } catch (error) {
        result.submissionError = error as Error;
      }
    }
    return result;
  }

  public async submit(options: ISubmittableOptions = {}): Promise<TxResult> {
    const signedTx = await this.sign(options);
    return await this.submitSigned(signedTx, options);
  }

  private logRequest() {
    let toHuman = (this.tx.toHuman() as any).method;
    const txString = [];
    let api = formatCall(toHuman);
    const args: any[] = [];
    if (api === 'proxy.proxy') {
      toHuman = toHuman.args.call;
      txString.push('Proxy');
      api = formatCall(toHuman);
    }
    if (api.startsWith('utility.batch')) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      const calls = toHuman.args.calls.map(formatCall).join(', ');
      txString.push(`Batch[${calls}]`);
    } else {
      txString.push(api);
      args.push(toHuman.args);
    }
    args.unshift(txString.join('->'));
    console.log('Submitting transaction from %s:', this.address, ...args);
  }
}

function formatCall(call: any): string {
  return `${call.section}.${call.method}`;
}
