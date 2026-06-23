import { TxResult, TxSubmitter } from '@argonprotocol/mainchain';

export const SubmissionStatusErrorCode = {
  Dropped: 'SubmissionStatus.Dropped',
  Invalid: 'SubmissionStatus.Invalid',
  Usurped: 'SubmissionStatus.Usurped',
} as const;

export type SubmissionStatusErrorCode = (typeof SubmissionStatusErrorCode)[keyof typeof SubmissionStatusErrorCode];

export class SubmissionStatusError extends Error {
  constructor(
    public readonly code: SubmissionStatusErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export function isSubmissionStatusError(
  error: unknown,
  ...codes: SubmissionStatusErrorCode[]
): error is SubmissionStatusError {
  if (!(error instanceof SubmissionStatusError)) {
    return false;
  }

  return codes.length === 0 || codes.includes(error.code);
}

export type IWatchedSubmission = {
  signedTx: Awaited<ReturnType<TxSubmitter['sign']>>;
  result: TxResult;
};

export async function submitWithTerminalStatusWatch(
  submitter: TxSubmitter,
  options: {
    nonce: number;
  },
): Promise<IWatchedSubmission> {
  const signedTx = await submitter.sign(options);
  const submittedAtBlockNumber = await submitter.client.rpc.chain.getHeader().then(header => header.number.toNumber());
  const result = new TxResult(submitter.client, {
    signedHash: signedTx.hash.toHex(),
    method: signedTx.method.toHuman(),
    accountAddress: submitter.address,
    submittedTime: new Date(),
    submittedAtBlockNumber,
    nonce: signedTx.nonce.toNumber(),
  });

  let unsubscribe: (() => void) | undefined;
  let shouldUnsubscribe = false;

  const stopWatching = () => {
    if (!unsubscribe) {
      shouldUnsubscribe = true;
      return;
    }

    unsubscribe();
    unsubscribe = undefined;
  };

  unsubscribe = await signedTx.send(subscriptionResult => {
    result.onSubscriptionResult(subscriptionResult);
    const status = subscriptionResult.status;
    if (status.isUsurped) {
      result.submissionError = new SubmissionStatusError(
        SubmissionStatusErrorCode.Usurped,
        `Transaction was usurped by ${status.asUsurped.toHex()}.`,
      );
      stopWatching();
      return;
    }
    if (status.isDropped) {
      result.submissionError = new SubmissionStatusError(
        SubmissionStatusErrorCode.Dropped,
        'Transaction was dropped before it was included in a block.',
      );
      stopWatching();
      return;
    }
    if (status.isInvalid) {
      result.submissionError = new SubmissionStatusError(
        SubmissionStatusErrorCode.Invalid,
        'Transaction was rejected as invalid by the node.',
      );
      stopWatching();
      return;
    }
    if (subscriptionResult.isFinalized) {
      stopWatching();
    }
  });

  if (shouldUnsubscribe) {
    unsubscribe();
    unsubscribe = undefined;
  }

  return { signedTx, result };
}
