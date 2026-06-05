import {
  getEthereumFinalityMillis,
  getGatewayActivityWaitEstimateMs,
  getTransferToArgonWaitEstimateMs,
} from './EthereumClient.ts';

export type ICrosschainTransferStepStatus = 'pending' | 'active' | 'complete';

export interface ICrosschainTransferStepProgress {
  title: string;
  status: ICrosschainTransferStepStatus;
  progressPct: number;
  startedAt?: number;
  completedAt?: number;
  estimatedDurationMs?: number;
  detail?: string;
  hint?: string;
  confirmations?: number;
  expectedConfirmations?: number;
  approvalPercent?: number;
  remainingMintingAuthorizationMicrogons?: bigint;
}

export interface ICrosschainTransferProgress {
  totalSteps: number;
  currentStep: number;
  overallProgressPct: number;
  currentStepLabel: string;
  currentStepDetail?: string;
  currentStepHint?: string;
  currentStepRemainingMintingAuthorizationMicrogons?: bigint;
  steps: ICrosschainTransferStepProgress[];
}

export const INBOUND_TRANSFER_STEP_TITLES = [
  'Finalizing on Ethereum',
  'Proving to Argon',
  'Finalizing on Argon',
] as const;
export const OUTBOUND_TRANSFER_STEP_TITLES = [
  'Finalizing on Argon',
  'Waiting for Minting Authorization',
  'Sending to Ethereum',
] as const;

export function createCrosschainTransferProgress(titles: readonly string[]): ICrosschainTransferProgress {
  return hydrateCrosschainTransferProgress(
    titles.map(title => ({
      title,
      status: 'pending',
      progressPct: 0,
    })),
  );
}

export function hydrateCrosschainTransferProgress(
  steps: ICrosschainTransferStepProgress[],
  nowMs: number = Date.now(),
): ICrosschainTransferProgress {
  const totalSteps = steps.length;
  const activeStepIndex = steps.findIndex(step => step.status === 'active');
  const pendingStepIndex = steps.findIndex(step => step.status === 'pending');
  const currentStepIndex =
    activeStepIndex !== -1 ? activeStepIndex : pendingStepIndex !== -1 ? pendingStepIndex : Math.max(0, totalSteps - 1);
  const currentStep = steps[currentStepIndex];

  let completedStepCount = 0;
  for (const step of steps) {
    if (step.status !== 'complete') {
      break;
    }
    completedStepCount += 1;
  }

  const activeStepProgress = getDisplayedStepProgress(currentStep, nowMs);
  const completedAllSteps = activeStepIndex === -1 && pendingStepIndex === -1;
  const overallProgressUnits = completedAllSteps ? completedStepCount : completedStepCount + activeStepProgress / 100;
  const overallProgressPct = totalSteps === 0 ? 0 : (overallProgressUnits / totalSteps) * 100;

  return {
    totalSteps,
    currentStep: currentStepIndex + 1,
    overallProgressPct,
    currentStepLabel: `Step ${currentStepIndex + 1} of ${totalSteps}: ${currentStep.title}`,
    currentStepDetail: currentStep.detail,
    currentStepHint: currentStep.hint,
    currentStepRemainingMintingAuthorizationMicrogons: currentStep.remainingMintingAuthorizationMicrogons,
    steps,
  };
}

export function formatCrosschainBlockStepDetail(args: {
  blockType: 'Argon' | 'Ethereum';
  confirmations: number;
  expectedConfirmations: number;
}) {
  const { blockType, confirmations, expectedConfirmations } = args;
  const totalConfirmations = Math.max(1, expectedConfirmations);
  const currentConfirmation = Math.min(totalConfirmations, Math.max(0, confirmations + 1));

  return `${blockType} confirmation ${currentConfirmation} of ${totalConfirmations}`;
}

function pendingStep(step: ICrosschainTransferStepProgress): ICrosschainTransferStepProgress {
  return {
    ...step,
    status: 'pending',
    progressPct: 0,
    detail: undefined,
    hint: undefined,
  };
}

function completeStep(step: ICrosschainTransferStepProgress): ICrosschainTransferStepProgress {
  return {
    ...step,
    status: 'complete',
    progressPct: 100,
    completedAt: step.completedAt ?? Date.now(),
  };
}

export function setInboundEthereumStepProgress(
  progress: ICrosschainTransferProgress,
  args: {
    progressPct: number;
    detail: string;
    confirmations?: number;
    expectedConfirmations?: number;
  },
) {
  return replaceCrosschainTransferProgress(progress, steps => {
    steps[0] = {
      ...steps[0],
      status: 'active',
      progressPct: args.progressPct,
      startedAt: steps[0].startedAt ?? Date.now(),
      estimatedDurationMs: steps[0].estimatedDurationMs ?? getEthereumFinalityMillis(),
      detail: args.detail,
      confirmations: args.confirmations,
      expectedConfirmations: args.expectedConfirmations,
    };
    steps[1] = {
      ...pendingStep(steps[1]),
      hint: 'Usually a few minutes once finalized Ethereum state reaches Argon.',
      estimatedDurationMs: getTransferToArgonWaitEstimateMs(),
    };
    steps[2] = pendingStep(steps[2]);
  });
}

export function setInboundRelayStepProgress(
  progress: ICrosschainTransferProgress,
  args: {
    progressPct: number;
    detail: string;
    hint?: string;
  },
) {
  return replaceCrosschainTransferProgress(progress, steps => {
    steps[0] = completeStep(steps[0]);
    steps[1] = {
      ...steps[1],
      status: 'active',
      progressPct: args.progressPct,
      startedAt: steps[1].startedAt ?? Date.now(),
      estimatedDurationMs: steps[1].estimatedDurationMs ?? getTransferToArgonWaitEstimateMs(),
      detail: args.detail,
      hint: args.hint ?? 'Usually a few minutes once finalized Ethereum state reaches Argon.',
    };
    steps[2] = pendingStep(steps[2]);
  });
}

export function setInboundArgonStepProgress(
  progress: ICrosschainTransferProgress,
  args: {
    progressPct: number;
    detail: string;
    hint?: string;
  },
) {
  return replaceCrosschainTransferProgress(progress, steps => {
    steps[0] = completeStep(steps[0]);
    steps[1] = completeStep(steps[1]);
    steps[2] = {
      ...steps[2],
      status: 'active',
      progressPct: args.progressPct,
      startedAt: steps[2].startedAt ?? Date.now(),
      detail: args.detail,
      hint: args.hint,
    };
  });
}

export function completeInboundTransferProgress(progress: ICrosschainTransferProgress, detail: string) {
  return completeCrosschainTransferProgress(progress, detail);
}

export function setOutboundArgonStepProgress(
  progress: ICrosschainTransferProgress,
  args: {
    progressPct: number;
    detail: string;
    confirmations?: number;
    expectedConfirmations?: number;
  },
) {
  return replaceCrosschainTransferProgress(progress, steps => {
    steps[0] = {
      ...steps[0],
      status: 'active',
      progressPct: args.progressPct,
      startedAt: steps[0].startedAt ?? Date.now(),
      detail: args.detail,
      confirmations: args.confirmations,
      expectedConfirmations: args.expectedConfirmations,
    };
    steps[1] = {
      ...pendingStep(steps[1]),
      hint: 'Usually about an hour, and sometimes up to a day.',
      estimatedDurationMs: getGatewayActivityWaitEstimateMs(),
      approvalPercent: undefined,
      remainingMintingAuthorizationMicrogons: undefined,
    };
    steps[2] = pendingStep(steps[2]);
  });
}

export function setOutboundMintingAuthorizationStepProgress(
  progress: ICrosschainTransferProgress,
  args: {
    progressPct: number;
    detail: string;
    hint?: string;
    confirmations?: number;
    expectedConfirmations?: number;
    approvalPercent?: number;
    remainingMintingAuthorizationMicrogons?: bigint;
  },
) {
  return replaceCrosschainTransferProgress(progress, steps => {
    steps[0] = completeStep(steps[0]);
    steps[1] = {
      ...steps[1],
      status: 'active',
      progressPct: args.progressPct,
      startedAt: steps[1].startedAt ?? Date.now(),
      estimatedDurationMs: steps[1].estimatedDurationMs ?? getGatewayActivityWaitEstimateMs(),
      detail: args.detail,
      hint: args.hint ?? 'Usually about an hour, and sometimes up to a day.',
      confirmations: args.confirmations,
      expectedConfirmations: args.expectedConfirmations,
      approvalPercent: args.approvalPercent,
      remainingMintingAuthorizationMicrogons: args.remainingMintingAuthorizationMicrogons,
    };
    steps[2] = pendingStep(steps[2]);
  });
}

export function setOutboundEthereumStepProgress(
  progress: ICrosschainTransferProgress,
  args: {
    progressPct: number;
    detail: string;
    hint?: string;
    confirmations?: number;
    expectedConfirmations?: number;
  },
) {
  return replaceCrosschainTransferProgress(progress, steps => {
    steps[0] = completeStep(steps[0]);
    steps[1] = completeStep(steps[1]);
    steps[2] = {
      ...steps[2],
      status: 'active',
      progressPct: args.progressPct,
      startedAt: steps[2].startedAt ?? Date.now(),
      detail: args.detail,
      hint: args.hint,
      confirmations: args.confirmations,
      expectedConfirmations: args.expectedConfirmations,
    };
  });
}

export function completeOutboundTransferProgress(progress: ICrosschainTransferProgress, detail: string) {
  return completeCrosschainTransferProgress(progress, detail);
}

function replaceCrosschainTransferProgress(
  progress: ICrosschainTransferProgress,
  mutate: (steps: ICrosschainTransferStepProgress[]) => void,
) {
  const steps = progress.steps.map(step => ({ ...step }));
  mutate(steps);
  return hydrateCrosschainTransferProgress(steps);
}

function completeCrosschainTransferProgress(progress: ICrosschainTransferProgress, detail: string) {
  return replaceCrosschainTransferProgress(progress, steps => {
    for (const [index, step] of steps.entries()) {
      steps[index] = completeStep(step);
    }

    steps[steps.length - 1].detail = detail;
    steps[steps.length - 1].hint = undefined;
  });
}

function getDisplayedStepProgress(step: ICrosschainTransferStepProgress, nowMs: number): number {
  if (step.status === 'complete') {
    return 100;
  }

  const actualProgressPct = Math.max(0, Math.min(100, step.progressPct));
  if (
    step.status !== 'active' ||
    step.startedAt == null ||
    step.estimatedDurationMs == null ||
    actualProgressPct >= 99
  ) {
    return actualProgressPct;
  }

  const elapsedMs = Math.max(0, nowMs - step.startedAt);
  const estimatedProgressPct = Math.min(99, (elapsedMs / step.estimatedDurationMs) * 100);
  return Math.max(actualProgressPct, estimatedProgressPct);
}
