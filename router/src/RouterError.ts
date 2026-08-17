export class RouterError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
    public readonly code?: string,
    public readonly minimumDesktopVersion?: string,
  ) {
    super(message);
  }
}
