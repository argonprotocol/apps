export function createDeferred<T = void>(isRunning: boolean = true): IDeferred<T> {
  let resolve!: (value: T | Promise<T>) => void;
  let reject!: (reason?: unknown) => void;
  let isResolved = false;
  let isRejected = false;

  const promise = new Promise<T>((res, rej) => {
    resolve = (value: T | Promise<T>) => {
      isResolved = true;
      isRunning = false;
      res(value);
    };
    reject = (reason?: unknown) => {
      isRejected = true;
      isRunning = false;
      rej(reason);
    };
  });

  const setIsRunning = (x: boolean) => (isRunning = x);

  // Create the object with arrow functions to avoid 'this' binding issues

  return {
    resolve: (value: T | Promise<T>) => resolve(value),
    reject: (reason?: unknown) => reject(reason),
    promise,
    setIsRunning,
    get isResolved() {
      return isResolved;
    },
    get isRejected() {
      return isRejected;
    },
    get isRunning() {
      return isRunning;
    },
    get isSettled() {
      return isResolved || isRejected;
    },
  };
}

export type IDeferred<T = void> = {
  resolve(this: void, value: T | Promise<T>): void;
  reject(this: void, reason?: unknown): void;
  setIsRunning(this: void, isRunning: boolean): void;
  promise: Promise<T>;
  readonly isResolved: boolean;
  readonly isRejected: boolean;
  readonly isRunning: boolean;
  readonly isSettled: boolean;
};
