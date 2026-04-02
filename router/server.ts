import express, { type Request, type Response } from 'express';
import { ArgonApis } from './src/ArgonApis';
import { LOCAL_NODE_URL, MAIN_NODE_URL, PORT } from './src/env';
import { BitcoinApis } from './src/BitcoinApis';
import { CapitalUsers } from './src/CapitalUsers.ts';
import { Profile } from './src/Profile.ts';
import { JsonExt } from '@argonprotocol/apps-core';

function sendJson(res: Response, data: unknown, status = 200): void {
  res.status(status).type('application/json').send(JsonExt.stringify(data));
}

function safeJsonRoute(
  handler: (req: Request, res: Response) => Promise<unknown>,
): (req: Request, res: Response) => Promise<void> {
  return async (req: Request, res: Response) => {
    try {
      const data = await handler(req, res);
      if (!res.headersSent) {
        sendJson(res, data);
      }
    } catch (err) {
      console.error('Route error:', err);
      if (!res.headersSent) {
        sendJson(res, { error: String(err) }, 500);
      }
    }
  };
}

console.log('Starting router server on port', PORT, {
  LOCAL_NODE_URL,
  MAIN_NODE_URL,
  BITCOIN_CHAIN: process.env.BITCOIN_CHAIN,
});

const app = express();

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }

  next();
});

app.get(
  '/',
  safeJsonRoute(async () => ({
    status: 'ok',
    localNodeUrl: LOCAL_NODE_URL,
    mainNodeUrl: MAIN_NODE_URL,
    bitcoinConfig: process.env.BITCOIN_CONFIG,
    serverRoot: process.env.SERVER_ROOT,
  })),
);

app.get(
  '/argon/iscomplete',
  safeJsonRoute(async (_req, res) => {
    const response = await ArgonApis.isComplete();
    sendJson(res, response, typeof response === 'boolean' ? 200 : 500);
  }),
);

app.get('/argon/latestblocks', safeJsonRoute(async () => await ArgonApis.latestBlocks()));
app.get('/argon/syncstatus', safeJsonRoute(async () => await ArgonApis.syncStatus()));
app.get('/bitcoin/getblockchaininfo', safeJsonRoute(async () => await BitcoinApis.blockchainInfo()));
app.get('/bitcoin/latestblocks', safeJsonRoute(async () => await BitcoinApis.latestBlocks()));
app.get('/bitcoin/syncstatus', safeJsonRoute(async () => await BitcoinApis.syncStatus()));
app.get(
  '/bitcoin/recentblocks',
  safeJsonRoute(async (req: Request) => {
    const blockCount = Number(String(req.query.blockCount ?? '10'));
    return BitcoinApis.recentBlocks(blockCount);
  }),
);

app.post(
  '/capital-users/create',
  express.text({ type: '*/*' }),
  safeJsonRoute(async (req: Request, res: Response) => {
    const rawBody = req.body;
    if (!rawBody) {
      sendJson(res, { error: 'Missing JSON body' }, 400);
      return;
    }

    const payload = JsonExt.parse(rawBody);
    const user = CapitalUsers.createUser(payload);

    return { success: true, user };
  }),
);

app.get(
  '/capital-users/invites',
  safeJsonRoute(async () => {
    return CapitalUsers.fetchInvites();
  }),
);

app.get(
  '/capital-users/members',
  safeJsonRoute(async () => {
    return CapitalUsers.fetchMembers();
  }),
);

app.get(
  '/capital-users/register',
  safeJsonRoute(async () => {
    return { success: true };
  }),
);

app.get(
  '/capital-users/:inviteCode',
  safeJsonRoute(async (req: Request, res: Response) => {
    const profile = Profile.fetch();
    const inviteCode = req.params.inviteCode;
    const invite = CapitalUsers.setClickedAt(inviteCode);
    if (!invite) {
      sendJson(res, { error: 'Invite not found' }, 404);
      return;
    }

    return {
      success: true,
      fromName: profile.name,
      invite
    };
  }),
);

app.post(
  '/capital-users/:inviteCode/register-app',
  safeJsonRoute(async (req: Request, res: Response) => {
    const profile = Profile.fetch();
    const inviteCode = req.params.inviteCode;
    const invite = CapitalUsers.setRegisteredAppAt(inviteCode);
    if (!invite) {
      sendJson(res, { error: 'Invite not found' }, 404);
      return;
    }

    return {
      success: true,
      fromName: profile.name,
      invite
    };
  }),
);

app.post(
  '/profile',
  express.text({ type: '*/*' }),
  safeJsonRoute(async (req: Request, res: Response) => {
    const rawBody = req.body;
    if (!rawBody) {
      sendJson(res, { error: 'Missing JSON body' }, 400);
      return;
    }

    const payload = JsonExt.parse(rawBody);
    const profile = Profile.save(payload);

    return { success: true, profile };
  }),
);


app.get(
  '/profile',
  safeJsonRoute(async (_req: Request, _res: Response) => {
    const profile = Profile.fetch();

    return { success: true, profile };
  }),
);

app.use((_req, res) => {
  res.status(404).send('Not Found');
});

app.listen(Number(PORT), () => {
  console.log(`Router server is running on port ${PORT}`);
});
