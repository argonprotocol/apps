export default interface IDeferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: any) => void;
  isRunning: boolean;
  isSettled: boolean;
  isResolved: boolean;
  isRejected: boolean;
  setIsRunning: (isRunning: boolean) => void;
}
