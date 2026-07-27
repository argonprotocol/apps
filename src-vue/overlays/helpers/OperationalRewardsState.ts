export type IOperationalCompletionState = {
  hasLoadedInitialProgress: boolean;
  isFullyOperational: boolean;
};

export function shouldAutoOpenCertificationComplete(
  currentState: IOperationalCompletionState,
  previousState: IOperationalCompletionState,
): boolean {
  return (
    currentState.hasLoadedInitialProgress &&
    previousState.hasLoadedInitialProgress &&
    currentState.isFullyOperational &&
    !previousState.isFullyOperational
  );
}
