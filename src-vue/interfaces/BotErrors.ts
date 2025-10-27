import type { IBotStateError, IBotStateStarting } from '@argonprotocol/apps-core';

export class BotServerIsLoading extends Error {
  constructor(public data: IBotStateStarting) {
    super(`Bot is not ready: ${JSON.stringify(data)}`);
  }
}

export class BotServerIsSyncing extends Error {
  constructor(public progress: number) {
    super(`Bot is syncing: ${progress}`);
  }
}

export class BotServerError extends Error {
  constructor(public data: IBotStateError) {
    super(`Bot blew up: ${JSON.stringify(data)}`);
  }
}
