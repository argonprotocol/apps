<!-- prettier-ignore -->
<template>
  <OverlayBase
    :isOpen="isOpen"
    data-testid="ArgonotCommitmentOverlay"
    @close="closeOverlay"
    @pressEsc="closeOverlay"
    class="w-[560px]">
    <template #title>
      <div class="grow text-2xl font-bold">Set Argonot Commitment</div>
    </template>

    <div class="px-6 py-5 text-slate-700">
      <div v-if="isLoading" class="py-10 text-center text-sm font-medium text-slate-500">
        Loading your current vault commitment...
      </div>

      <div v-else-if="txInfo" class="space-y-4">
        <div class="text-sm font-semibold text-slate-800">
          {{ progressError ? 'Commitment update needs attention' : progressPct >= 100 ? 'Commitment updated' : 'Updating commitment...' }}
        </div>

        <ProgressBar :progress="progressPct" :hasError="!!progressError" />

        <div class="text-sm text-slate-500">
          {{ progressMessage }}
        </div>

        <div v-if="progressError" class="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {{ progressError }}
        </div>

        <div class="flex justify-end gap-3 pt-2">
          <button
            v-if="progressError"
            type="button"
            class="rounded border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-50"
            @click="resetProgress">
            Try Again
          </button>
          <button
            type="button"
            class="bg-argon-button hover:bg-argon-button-hover rounded px-5 py-2 text-sm font-semibold text-white"
            @click="closeOverlay">
            Close
          </button>
        </div>
      </div>

      <div v-else-if="loadError" class="space-y-4">
        <div class="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {{ loadError }}
        </div>

        <div class="flex justify-end">
          <button
            type="button"
            class="rounded border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-50"
            @click="closeOverlay">
            Close
          </button>
        </div>
      </div>

      <div v-else class="space-y-5">
        <p class="text-sm leading-6 text-slate-500">
          Set how many Argonots to commit to your vault. These can serve as encumbered backing for collateralizing transfer requests to external chains like Ethereum.

          NOTE: this request does not activate a minting authority on it's own.
        </p>

        <div class="rounded-lg border border-slate-200 bg-white">
          <div class="border-b border-slate-200 px-4 py-3 text-sm font-semibold text-slate-800">Vault summary</div>

          <dl class="divide-y divide-slate-200">
            <div class="flex items-center justify-between gap-4 px-4 py-3">
              <dt class="text-sm text-slate-500">Currently committed</dt>
              <dd class="text-sm font-semibold text-slate-800">
                {{ micronotToArgonotNm(currentCommittedMicronots).format('0,0.[000000]') }} ARGNOT
              </dd>
            </div>

            <div class="flex items-center justify-between gap-4 px-4 py-3">
              <dt class="text-sm text-slate-500">Already encumbered</dt>
              <dd class="text-sm font-semibold text-slate-800">
                {{ micronotToArgonotNm(currentEncumberedMicronots).format('0,0.[000000]') }} ARGNOT
              </dd>
            </div>

            <div class="flex items-center justify-between gap-4 px-4 py-3">
              <dt class="text-sm text-slate-500">Wallet total</dt>
              <dd class="text-sm font-semibold text-slate-800">
                {{ micronotToArgonotNm(maxCommitmentMicronots).format('0,0.[000000]') }} ARGNOT
              </dd>
            </div>
          </dl>
        </div>

        <div class="rounded-lg border border-slate-200 bg-white px-4 py-4">
          <div class="text-sm font-semibold text-slate-800">Current minting authorities</div>
          <div class="mt-1 text-sm text-slate-500">
            These authorities are what currently encumber the crosschain backing shown above.
          </div>

          <div v-if="currentAuthorities.length === 0" class="mt-4 rounded-md border border-dashed border-slate-200 px-4 py-3 text-sm text-slate-500">
            No Ethereum minting authorities are currently registered for this vault operator.
          </div>

          <div v-else class="mt-4 space-y-3">
            <div
              v-for="authority in currentAuthorities"
              :key="authority.signer"
              class="rounded-md border border-slate-200 bg-slate-50 px-4 py-3">
              <div class="flex items-start justify-between gap-4">
                <div>
                  <div class="text-sm font-semibold text-slate-800">
                    {{ authority.authorityIndex != null ? `Signer #${authority.authorityIndex}` : 'External signer' }}
                  </div>
                  <div class="mt-1 break-all font-mono text-xs text-slate-500">
                    {{ authority.signer }}
                  </div>
                </div>

                <div class="text-right text-xs font-semibold uppercase tracking-wide text-slate-400">
                  {{
                    authority.isPendingActivation
                      ? 'Pending activation'
                      : authority.isDeactivating
                        ? 'Deactivating'
                        : authority.isActive
                          ? 'Active'
                          : 'Registered'
                  }}
                </div>
              </div>

              <div class="mt-3 grid grid-cols-2 gap-3 text-sm">
                <div>
                  <div class="text-xs font-semibold uppercase tracking-wide text-slate-400">ARGN</div>
                  <div class="mt-1 font-semibold text-slate-800">
                    {{ microgonToArgonNm(authority.microgonCollateral).format('0,0.[000000]') }}
                  </div>
                </div>

                <div>
                  <div class="text-xs font-semibold uppercase tracking-wide text-slate-400">ARGNOT</div>
                  <div class="mt-1 font-semibold text-slate-800">
                    {{ micronotToArgonotNm(authority.micronotCollateral).format('0,0.[000000]') }}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div>
          <label class="mb-1.5 block text-sm font-medium text-slate-600">Committed Argonots</label>
          <InputToken
            v-model="commitmentMicronots"
            data-testid="ArgonotCommitmentOverlay.commitmentMicronots"
            :min="currentEncumberedMicronots"
            :max="maxCommitmentMicronots"
            :dragBy="ONE_TOKEN"
            :dragByMin="ONE_TOKEN / 100n"
            :minDecimals="0"
            :maxDecimals="6"
            suffix=" ARGNOT"
          />
          <div class="mt-1 text-xs text-slate-400">
            Available to newly commit:
            {{ micronotToArgonotNm(maxAdditionalCommitmentMicronots).format('0,0.[000000]') }} ARGNOT
          </div>
        </div>

        <div v-if="validationMessage" class="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
          {{ validationMessage }}
        </div>

        <div v-if="submitError" class="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {{ submitError }}
        </div>

        <div class="flex justify-end gap-3 pt-1">
          <button
            type="button"
            class="rounded border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-50"
            @click="closeOverlay">
            Cancel
          </button>
          <button
            type="button"
            :disabled="isSubmitting || !!validationMessage"
            data-testid="ArgonotCommitmentOverlay.submit()"
            class="bg-argon-button hover:bg-argon-button-hover rounded px-5 py-2 text-sm font-semibold text-white disabled:cursor-default disabled:opacity-40"
            @click="submit">
            {{ isSubmitting ? 'Submitting...' : 'Update Commitment' }}
          </button>
        </div>
      </div>
    </div>
  </OverlayBase>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { MICROGONS_PER_ARGON } from '@argonprotocol/mainchain';
import InputToken from '../components/InputToken.vue';
import ProgressBar from '../components/ProgressBar.vue';
import OverlayBase from './OverlayBase.vue';
import basicEmitter from '../emitters/basicEmitter.ts';
import { type TransactionInfo } from '../lib/TransactionInfo.ts';
import { createNumeralHelpers } from '../lib/numeral.ts';
import { generateProgressLabel } from '../lib/Utils.ts';
import { getCurrency } from '../stores/currency.ts';
import { getFinalizedClient, getMainchainClient } from '../stores/mainchain.ts';
import { getMyVault } from '../stores/vaults.ts';
import { useWallets } from '../stores/wallets.ts';

const ONE_TOKEN = BigInt(MICROGONS_PER_ARGON);

const currency = getCurrency();
const myVault = getMyVault();
const wallets = useWallets();

const { microgonToArgonNm, micronotToArgonotNm } = createNumeralHelpers(currency);

const isOpen = Vue.ref(false);
const isLoading = Vue.ref(false);
const isSubmitting = Vue.ref(false);
const loadError = Vue.ref('');
const submitError = Vue.ref('');
const vaultId = Vue.ref<number>();

const currentCommittedMicronots = Vue.ref(0n);
const currentEncumberedMicronots = Vue.ref(0n);
const commitmentMicronots = Vue.ref(0n);
const currentAuthorities = Vue.ref<
  Array<{
    authorityIndex?: number;
    signer: string;
    isPendingActivation: boolean;
    isDeactivating: boolean;
    isActive: boolean;
    microgonCollateral: bigint;
    micronotCollateral: bigint;
  }>
>([]);

const txInfo = Vue.ref<TransactionInfo>();
const progressPct = Vue.ref(0);
const progressMessage = Vue.ref('');
const progressError = Vue.ref('');

let unsubProgress: (() => void) | undefined;

const maxCommitmentMicronots = Vue.computed(() => {
  return currentCommittedMicronots.value > wallets.vaultingWallet.totalMicronots
    ? currentCommittedMicronots.value
    : wallets.vaultingWallet.totalMicronots;
});

const maxAdditionalCommitmentMicronots = Vue.computed(() => {
  if (maxCommitmentMicronots.value <= currentCommittedMicronots.value) {
    return 0n;
  }
  return maxCommitmentMicronots.value - currentCommittedMicronots.value;
});

const validationMessage = Vue.computed(() => {
  if (!vaultId.value) {
    return 'Create your vault before setting an Argonot commitment.';
  }
  if (commitmentMicronots.value < currentEncumberedMicronots.value) {
    return 'Committed Argonots cannot be reduced below the backing already encumbered for crosschain use.';
  }
  if (commitmentMicronots.value === currentCommittedMicronots.value) {
    return 'No change yet.';
  }
  return '';
});

function closeOverlay() {
  isOpen.value = false;
}

function resetProgress() {
  unsubProgress?.();
  unsubProgress = undefined;
  txInfo.value = undefined;
  progressPct.value = 0;
  progressMessage.value = '';
  progressError.value = '';
  isSubmitting.value = false;
}

async function loadState() {
  resetProgress();
  isLoading.value = true;
  loadError.value = '';
  submitError.value = '';
  currentAuthorities.value = [];

  try {
    await Promise.all([wallets.isLoadedPromise, myVault.load()]);
    const [client, finalizedClient] = await Promise.all([getMainchainClient(false), getFinalizedClient()]);
    await myVault.mintingAuthorities.refresh(finalizedClient);

    if (!myVault.vaultId) {
      vaultId.value = undefined;
      currentCommittedMicronots.value = wallets.vaultingWallet.reservedMicronots;
      currentEncumberedMicronots.value = 0n;
      commitmentMicronots.value = currentCommittedMicronots.value;
      return;
    }

    vaultId.value = myVault.vaultId;

    const [commitmentOption] = await Promise.all([client.query.vaults.argonotCommitmentByVaultId(vaultId.value)]);

    if (commitmentOption.isSome) {
      const commitment = commitmentOption.unwrap();
      currentCommittedMicronots.value = commitment.committedMicronots.toBigInt();
      currentEncumberedMicronots.value = commitment.encumberedMicronots.toBigInt();
    } else {
      currentCommittedMicronots.value = wallets.vaultingWallet.reservedMicronots;
      currentEncumberedMicronots.value = 0n;
    }

    currentAuthorities.value = myVault.mintingAuthorities.data.authorities.map(
      ({
        gatewayRemainingMicrogonCollateral,
        pendingReservedMicrogonCollateral,
        gatewayRemainingMicronotCollateral,
        pendingReservedMicronotCollateral,
        ...authority
      }) => ({
        ...authority,
        microgonCollateral: gatewayRemainingMicrogonCollateral - pendingReservedMicrogonCollateral,
        micronotCollateral: gatewayRemainingMicronotCollateral - pendingReservedMicronotCollateral,
      }),
    );

    commitmentMicronots.value = currentCommittedMicronots.value;
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : 'Unable to load your current commitment.';
  } finally {
    isLoading.value = false;
  }
}

async function submit() {
  if (isSubmitting.value || validationMessage.value || !vaultId.value) {
    return;
  }

  submitError.value = '';
  isSubmitting.value = true;

  try {
    const info = await myVault.setCommittedArgonots(commitmentMicronots.value);

    txInfo.value = info;
    unsubProgress = info.subscribeToProgress((args, error) => {
      progressPct.value = args.progressPct;
      progressMessage.value =
        args.progressPct >= 100 && !error
          ? 'Committed Argonots updated for your vault operator account.'
          : generateProgressLabel(args.confirmations, args.expectedConfirmations);

      if (error) {
        progressError.value = error.message ?? 'Transaction failed.';
      }

      if (args.progressPct >= 100 && !error) {
        void loadState();
      }
    });
  } catch (error) {
    submitError.value = error instanceof Error ? error.message : 'Unable to update your commitment.';
    isSubmitting.value = false;
  }
}

basicEmitter.on('openArgonotCommitmentOverlay', () => {
  isOpen.value = true;
  void loadState();
});

Vue.onUnmounted(() => {
  unsubProgress?.();
});
</script>
