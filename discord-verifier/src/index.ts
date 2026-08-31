import { loadEnvFile } from 'node:process';
import { decodeAddress } from '@polkadot/util-crypto';
import { DISCORD_VERIFICATION_CONFIG } from '../../core/src/DiscordVerification.ts';
import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { DiscordBot } from './DiscordBot.ts';
import { logApiRequests, logError, logInfo } from './Log.ts';
import { Verifier } from './Verifier.ts';

try {
  loadEnvFile(new URL('../.env', import.meta.url));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}

const environment = z
  .object({
    DISCORD_BOT_TOKEN: z.string().min(1),
    ARGON_RPC_URL: z.string().url(),
    DATABASE_PATH: z.string().min(1),
    HOST: z.string().default('0.0.0.0'),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    CODE_TTL_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(5 * 60_000),
  })
  .passthrough()
  .parse(process.env);

const verifier = new Verifier(
  environment.DATABASE_PATH,
  DISCORD_VERIFICATION_CONFIG.applicationId,
  environment.CODE_TTL_MS,
  environment.ARGON_RPC_URL,
);
const bot = new DiscordBot(verifier, {
  guildId: DISCORD_VERIFICATION_CONFIG.guildId,
  roleIds: DISCORD_VERIFICATION_CONFIG.roleIds,
  developerIds: new Set(DISCORD_VERIFICATION_CONFIG.developerIds),
});

await bot.start(environment.DISCORD_BOT_TOKEN);
const app = express();
app.disable('x-powered-by');
app.use((_request, response, next) => {
  response.set({
    'Cache-Control': 'no-store, max-age=0',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  next();
});
app.use(logApiRequests);
app.use(express.json({ limit: '8kb' }));
app.get('/health', (_request, response) => response.json({ status: 'ok' }));
app.post('/role-proofs', async (request, response, next) => {
  try {
    const input = roleProofSchema.parse(request.body);
    const { operationalAccountId, verificationCode, accessProof } = input;
    const upstreamAccountId = accessProof?.upstreamAccount;
    if (
      !isValidArgonAccountAddress(operationalAccountId) ||
      (upstreamAccountId && !isValidArgonAccountAddress(upstreamAccountId))
    ) {
      response.status(400).json({ error: 'Invalid Argon account address.' });
      return;
    }
    verifier.getCode(verificationCode);
    let evidence;
    try {
      evidence = await verifier.checkRoleEvidence(operationalAccountId, upstreamAccountId);
    } catch (error) {
      logError('chain_evidence_failed', error, { operation: 'connect' });
      response.status(503).json({ error: 'Finalized Argon state is temporarily unavailable.' });
      return;
    }
    const verification = verifier.completeCode(input, accessProof, evidence);
    try {
      await bot.grantRoles(verification.discordUserId, verification.roles);
    } catch (error) {
      logError('discord_role_grant_failed', error, { operation: 'connect' });
      response.status(503).json({
        error: 'Your account was connected, but Discord could not add the role. Run /connect-desktop-app again.',
      });
      return;
    }
    response.json(verification);
  } catch (error) {
    next(error);
  }
});
app.post('/role-updates', async (request, response, next) => {
  try {
    const input = roleUpdateSchema.parse(request.body);
    const { operationalAccountId } = input;
    if (!isValidArgonAccountAddress(operationalAccountId)) {
      response.status(400).json({ error: 'Invalid Argon account address.' });
      return;
    }
    verifier.getUpdateBinding(input);
    let evidence;
    try {
      evidence = await verifier.checkRoleEvidence(operationalAccountId);
    } catch (error) {
      logError('chain_evidence_failed', error, { operation: 'update' });
      response.status(503).json({ error: 'Finalized Argon state is temporarily unavailable.' });
      return;
    }
    const verification = verifier.completeUpdate(input, evidence.candidate);
    try {
      await bot.grantRoles(verification.discordUserId, verification.roles);
    } catch (error) {
      logError('discord_role_grant_failed', error, { operation: 'update' });
      response.status(503).json({
        error: 'Your role was updated, but Discord could not apply it. Try updating again.',
      });
      return;
    }
    response.json(verification);
  } catch (error) {
    next(error);
  }
});
app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  if (error instanceof z.ZodError) {
    response.status(400).json({ error: 'Request body is invalid.' });
    return;
  }
  const message = error instanceof Error ? error.message : 'Request failed.';
  let status = 400;
  if (message.includes('not found')) status = 404;
  else if (message.includes('not connected')) status = 404;
  else if (message.includes('expired')) status = 410;
  else if (message.includes('already bound')) status = 409;
  logError('api_request_failed', error, { method: _request.method, path: _request.path, status });
  response.status(status).json({ error: message });
});
const server = app.listen(environment.PORT, environment.HOST, () => {
  logInfo('server_started', { port: environment.PORT });
});

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await new Promise<void>(resolve => server.close(() => resolve()));
  await bot.close();
  await verifier.close();
  logInfo('server_stopped');
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void shutdown().finally(() => process.exit(0));
  });
}

const roleProofSchema = z
  .object({
    version: z.literal(1),
    discordApplicationId: z.string().regex(/^\d{17,20}$/),
    verificationCode: z.string().regex(/^ARGON-[0-9a-f]{32}$/),
    operationalAccountId: z.string().min(1),
    signature: z.string().regex(/^0x[0-9a-f]+$/i),
    accessProof: z
      .object({
        upstreamAccount: z.string().min(1),
        signature: z.string().regex(/^0x[0-9a-f]+$/i),
      })
      .strict()
      .optional(),
  })
  .strict();

const roleUpdateSchema = z
  .object({
    version: z.literal(1),
    discordApplicationId: z.string().regex(/^\d{17,20}$/),
    signedAt: z.number().int().positive(),
    operationalAccountId: z.string().min(1),
    signature: z.string().regex(/^0x[0-9a-f]+$/i),
  })
  .strict();

function isValidArgonAccountAddress(address: string): boolean {
  try {
    decodeAddress(address);
    return true;
  } catch {
    return false;
  }
}
