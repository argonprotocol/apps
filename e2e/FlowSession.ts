import { AppSession, type AppSessionOptions } from './AppSession.ts';

export class FlowSession extends AppSession {
  public static async start(this: void, options: AppSessionOptions = {}): Promise<FlowSession> {
    const session = new FlowSession(options);
    await session.initialize();
    return session;
  }

  private constructor(options: AppSessionOptions) {
    super(options);
  }

  public async run(
    flowName: string,
    input: Record<string, unknown> = {},
  ): Promise<{ elapsedMs: number; data: Record<string, unknown> }> {
    const { runFlow } = await import('./flows/index.ts');
    const startedAt = Date.now();
    try {
      const result = await runFlow(this.driver, flowName, {
        input,
        initialData: this.sessionData,
      });
      return {
        elapsedMs: Date.now() - startedAt,
        data: result.data,
      };
    } catch (error) {
      await this.reportFlowFailure(flowName, error);
      throw error;
    }
  }
}
