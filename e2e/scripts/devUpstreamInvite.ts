import {
  Currency,
  JsonExt,
  MainchainClients,
  MICROGONS_PER_ARGON,
  NetworkConfig,
  UnitOfMeasurement,
} from '@argonprotocol/apps-core';
import { waitFor } from '@argonprotocol/apps-core/__test__/helpers/waitFor.ts';
import { BitcoinLock, Vault } from '@argonprotocol/mainchain';
import { InviteEnvelope } from 'src-vue/lib/InviteEnvelope.ts';
import { ServerAuthClient } from 'src-vue/lib/ServerAuthClient.ts';
import {
  createDevUpstreamWalletKeys,
  getDevUpstreamComposeContext,
  readComposePortWithRetry,
  readDevUpstreamServerPorts,
} from './devUpstreamServer.ts';

NetworkConfig.setNetwork('dev-docker');

const composeContext = getDevUpstreamComposeContext();
const archivePort = await readComposePortWithRetry({
  context: composeContext,
  service: 'archive-node',
  port: 9944,
  timeoutMs: 45_000,
});
const { botPort, gatewayPort, routerPort } = await readDevUpstreamServerPorts(composeContext);
const operatorHost = `http://127.0.0.1:${routerPort}`;
const botHost = `http://127.0.0.1:${botPort}`;
const gatewayHost = `https://127.0.0.1:${gatewayPort}`;
const walletKeys = await createDevUpstreamWalletKeys();
const clients = new MainchainClients(`ws://127.0.0.1:${archivePort}`, () => false);

try {
  const currency = new Currency(clients);
  await currency.load(true);

  const client = await clients.get(false);
  const vaultId = await client.query.vaults.vaultIdByOperator(walletKeys.vaultingAddress);
  if (vaultId.isNone) {
    throw new Error('The upstream server is not invite-ready yet. Start the upstream server first.');
  }

  const vault = await Vault.get(client, vaultId.unwrap().toNumber());
  const inviteLiquidityMicrogons = 1_000n * BigInt(MICROGONS_PER_ARGON);
  const maxSatoshis = BitcoinLock.satoshisRequiredForRedemptionAmount(
    currency.priceIndex,
    inviteLiquidityMicrogons < vault.availableBitcoinSpace() ? inviteLiquidityMicrogons : vault.availableBitcoinSpace(),
  );
  const fullLockAmount = BitcoinLock.calculateRedemptionAmountFromSatoshis(currency.priceIndex, maxSatoshis);
  const estimatedGiftUsd = Number(
    currency.convertMicrogonTo(vault.calculateBitcoinFee(fullLockAmount), UnitOfMeasurement.USD),
  );
  const btcPctFee = vault.terms.bitcoinAnnualPercentRate.times(100).toNumber();
  const fromName = vault.name || 'Testing';

  const serverAuthClient = new ServerAuthClient(() => walletKeys);
  await waitFor(45e3, 'upstream bot ready', async () => {
    const response = await fetch(`${botHost}/is-ready`).catch(() => undefined);
    if (!response?.ok) {
      return;
    }

    const body = await response.text();
    return body.trim() === 'true' ? true : undefined;
  });
  await waitFor(30e3, 'upstream router ready', async () => {
    const response = await fetch(`${operatorHost}/`).catch(() => undefined);
    return response?.ok ? true : undefined;
  });

  const sessionId = await serverAuthClient.getAdminOperatorSessionId(operatorHost);
  const url = new URL(`${operatorHost}/invites/create`);
  url.searchParams.set('sessionId', sessionId);

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JsonExt.stringify({
      name: 'Casey',
      fromName,
      vaultId: vault.vaultId,
      maxSatoshis,
      estimatedGiftUsd,
      btcPctFee,
      expiresAfterTicks: 10 * NetworkConfig.rewardTicksPerFrame,
    }),
  });
  const rawBody = await response.text();
  if (!response.ok) {
    throw new Error(rawBody || `Router request failed (${response.status})`);
  }

  const body = JsonExt.parse<{ invite: { inviteCode: string } }>(rawBody);
  const inviteEnvelope = InviteEnvelope.encode({
    host: '127.0.0.1',
    port: gatewayPort,
    inviteCode: body.invite.inviteCode,
  });
  const websiteHost = NetworkConfig.get().websiteHost.replace(/\/$/, '');

  console.info('');
  console.info('[dev-upstream-invite] Dev upstream operator is ready.');
  console.info(`[dev-upstream-invite] Gateway: ${gatewayHost}`);
  console.info(`[dev-upstream-invite] Router: ${operatorHost}`);
  console.info(`[dev-upstream-invite] Vault: ${fromName} (#${vault.vaultId})`);
  console.info(`[dev-upstream-invite] Invite code: ${inviteEnvelope}`);
  console.info(`[dev-upstream-invite] Raw invite id: ${body.invite.inviteCode}`);
  console.info(`[dev-upstream-invite] Share URL: ${websiteHost}/invite/${inviteEnvelope}`);
} catch (error) {
  console.error(`[dev-upstream-invite] ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  await clients.disconnect().catch(() => undefined);
}

process.exit(process.exitCode ?? 0);
