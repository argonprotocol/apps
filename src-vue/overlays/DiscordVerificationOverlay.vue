<!-- prettier-ignore -->
<template>
  <OverlayBase
    :isOpen="isOpen"
    title="Connect to Discord"
    class="w-7/12 max-w-2xl"
    @close="closeOverlay"
    @pressEsc="closeOverlay"
  >
    <div class="px-10 pt-4 pb-8 text-slate-700">
      <template v-if="(state === 'connected' || state === 'updated') && result">
        <div class="text-base leading-6 font-light text-slate-900">
          <div class="font-bold">{{ state === 'connected' ? 'Discord account connected' : 'Discord role updated' }}</div>
          <p class="mt-2">
            Your Discord account now shows:
          </p>
          <div v-for="role in result.roles.slice(-1)" :key="role" class="mt-2 font-bold text-argon-600">
            {{ roleLabels[role] }}
          </div>
        </div>
        <div v-if="errorMessage" class="mt-4 text-sm text-amber-700">
          {{ errorMessage }}
        </div>
        <div class="mt-7 flex justify-end border-t border-slate-200 pt-5">
          <button class="cursor-pointer rounded-md border border-argon-button-hover bg-argon-button px-5 py-2 font-bold text-white inner-button-shadow hover:bg-argon-button-hover focus:outline-none" @click="closeOverlay">
            Done
          </button>
        </div>
      </template>

      <template v-else-if="config.hasConnectedDiscord">
        <div class="text-base leading-6 font-light text-slate-900">
          <div class="font-bold">Connected to Discord</div>
          <p class="mt-2">
            Update Discord to show your current Argon certification.
          </p>
        </div>

        <div v-if="errorMessage" class="mt-4 text-sm text-amber-700">
          {{ errorMessage }}
        </div>

        <div class="mt-7 flex justify-end gap-3 border-t border-slate-200 pt-5">
          <button type="button" :disabled="isSubmitting" class="cursor-pointer rounded-md border border-argon-600/20 bg-white px-5 py-2 font-bold text-argon-600 inner-button-shadow hover:bg-argon-600/10 focus:outline-none disabled:cursor-default disabled:opacity-50" @click="closeOverlay">
            Done
          </button>
          <button
            type="button"
            :disabled="isSubmitting"
            class="cursor-pointer rounded-md border border-argon-button-hover bg-argon-button px-5 py-2 font-bold text-white inner-button-shadow hover:bg-argon-button-hover focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
            @click="submit('update')"
          >
            {{ state === 'updating' ? 'Updating…' : 'Update Discord role' }}
          </button>
        </div>
      </template>

      <template v-else>
        <p class="text-base leading-6 font-light text-slate-900">
          To connect your Discord account, run <span class="font-mono">/connect-desktop-app</span> in Discord and paste its private one-time code below.
        </p>

        <form class="mt-5" @submit.prevent="submit('connect')">
          <label for="discord-verification-code" class="block text-sm font-medium text-slate-700">Verification code</label>
          <input
            id="discord-verification-code"
            v-model="verificationCode"
            name="verification-code"
            autocomplete="off"
            spellcheck="false"
            placeholder="ARGON-…"
            class="inner-input-shadow mt-2 w-full rounded-lg border border-slate-400/70 bg-white px-2.5 py-1.5 font-mono text-lg font-normal text-slate-700 placeholder:text-slate-300 outline-none transition focus:border-argon-500 focus:ring-2 focus:ring-argon-500/15"
            :disabled="isSubmitting"
          />

          <div v-if="errorMessage" class="mt-4 text-sm text-amber-700">
            {{ errorMessage }}
          </div>

          <div class="mt-5 flex justify-end gap-3">
            <button type="button" :disabled="isSubmitting" class="cursor-pointer rounded-md border border-argon-600/20 bg-white px-5 py-2 font-bold text-argon-600 inner-button-shadow hover:bg-argon-600/10 focus:outline-none disabled:cursor-default disabled:opacity-50" @click="closeOverlay">
              Cancel
            </button>
            <button
              type="submit"
              class="cursor-pointer rounded-md border border-argon-button-hover bg-argon-button px-5 py-2 font-bold text-white inner-button-shadow hover:bg-argon-button-hover focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="isSubmitting || !verificationCode.trim()"
            >
              {{ state === 'connecting' ? 'Connecting…' : 'Connect Discord' }}
            </button>
          </div>

        </form>

        <p class="mt-5 border-t border-slate-200 pt-4 text-xs text-slate-500">
          Only use a code generated privately by the Argon Verifier app installed to the Argon Server in Discord.
        </p>
      </template>
    </div>
  </OverlayBase>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import {
  DISCORD_ROLE_ORDER,
  DISCORD_VERIFICATION_CONFIG,
  fetch,
  signDiscordRoleProof,
  signDiscordRoleUpdateProof,
  type DiscordEarnedRole,
} from '@argonprotocol/apps-core';
import basicEmitter from '../emitters/basicEmitter.ts';
import { useBasics } from '../stores/basics.ts';
import { getConfig } from '../stores/config.ts';
import { getWalletKeys } from '../stores/wallets.ts';
import { getUpstreamOperatorClient } from '../stores/upstreamOperator.ts';
import OverlayBase from './OverlayBase.vue';

interface IDiscordVerificationResult {
  discordUserId: string;
  roles: DiscordEarnedRole[];
}

const basics = useBasics();
const config = getConfig();
const isOpen = Vue.ref(false);
const state = Vue.ref<'ready' | 'connecting' | 'updating' | 'connected' | 'updated'>('ready');
const verificationCode = Vue.ref('');
const errorMessage = Vue.ref('');
const result = Vue.ref<IDiscordVerificationResult>();
const roleLabels: Record<DiscordEarnedRole, string> = {
  treasuryUser: 'Treasury User',
  treasuryCertified: 'Treasury Certified',
  operationallyCertified: 'Operationally Certified',
};
const isSubmitting = Vue.computed(() => state.value === 'connecting' || state.value === 'updating');
let requestId = 0;

function openDiscordVerificationOverlay(): void {
  ++requestId;
  isOpen.value = true;
  basics.overlayIsOpen = true;
  state.value = 'ready';
  verificationCode.value = '';
  errorMessage.value = '';
  result.value = undefined;
}

basicEmitter.on('openDiscordVerificationOverlay', openDiscordVerificationOverlay);
Vue.onUnmounted(() => basicEmitter.off('openDiscordVerificationOverlay', openDiscordVerificationOverlay));

async function submit(action: 'connect' | 'update'): Promise<void> {
  if (isSubmitting.value) return;
  const currentRequest = ++requestId;
  state.value = action === 'connect' ? 'connecting' : 'updating';
  errorMessage.value = '';
  try {
    let path: string;
    let requestBody: object;

    if (action === 'connect') {
      const code = verificationCode.value.trim();
      if (!/^ARGON-[0-9a-f]{32}$/.test(code)) {
        throw new Error('Invalid Discord verification code.');
      }

      path = '/role-proofs';
      const operationalKey = await getWalletKeys().getOperationalKeypair();
      const roleClaim = {
        discordApplicationId: DISCORD_VERIFICATION_CONFIG.applicationId,
        verificationCode: code,
        operationalAccountId: operationalKey.address,
      } as const;
      const operationalProof = {
        version: 1,
        ...roleClaim,
      } as const;

      const treasuryMemberSeal = await getUpstreamOperatorClient()
        .getTreasuryMemberSeal(roleClaim)
        .catch(() => undefined);
      if (currentRequest !== requestId) return;

      requestBody = {
        version: 2,
        ...roleClaim,
        signature: signDiscordRoleProof(operationalKey, operationalProof),
        treasuryMemberSeal,
      };
    } else {
      const operationalKey = await getWalletKeys().getOperationalKeypair();
      const proof = {
        version: 1,
        discordApplicationId: DISCORD_VERIFICATION_CONFIG.applicationId,
        signedAt: Date.now(),
        operationalAccountId: operationalKey.address,
      } as const;

      path = '/role-updates';
      requestBody = { ...proof, signature: signDiscordRoleUpdateProof(operationalKey, proof) };
    }

    if (currentRequest !== requestId) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    const response = await fetch(`${DISCORD_VERIFICATION_CONFIG.serviceUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));

    const body = (await response.json().catch(() => undefined)) as
      | (Partial<IDiscordVerificationResult> & { error?: unknown })
      | undefined;

    if (currentRequest !== requestId) return;

    if (!response.ok) {
      if (action === 'update' && response.status === 404) {
        config.hasConnectedDiscord = false;
        await config.save().catch(() => undefined);
      }
      throw new Error(
        typeof body?.error === 'string' ? body.error : `Discord verification failed (${response.status}).`,
      );
    }

    const roles = body?.roles;
    if (
      !/^\d{17,20}$/.test(body?.discordUserId ?? '') ||
      !Array.isArray(roles) ||
      roles.length === 0 ||
      roles.some(role => !DISCORD_ROLE_ORDER.includes(role))
    ) {
      throw new Error('Discord verification returned an invalid response.');
    }
    if (action === 'connect') {
      config.hasConnectedDiscord = true;
      await config.save().catch(async () => {
        config.hasConnectedDiscord = false;
        await config.save().catch(() => undefined);
        errorMessage.value = 'Discord connected, but this app could not remember the connection.';
      });
      if (currentRequest !== requestId) return;
    }
    result.value = body as IDiscordVerificationResult;
    state.value = action === 'connect' ? 'connected' : 'updated';
  } catch (error) {
    if (currentRequest !== requestId) return;
    errorMessage.value = error instanceof Error ? error.message : 'Discord verification failed.';
    state.value = 'ready';
  }
}

function closeOverlay(): void {
  ++requestId;
  isOpen.value = false;
  basics.overlayIsOpen = false;
}
</script>
