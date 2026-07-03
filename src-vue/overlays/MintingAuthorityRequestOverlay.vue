<!-- prettier-ignore -->
<template>
  <OverlayBase
    :isOpen="isOpen"
    data-testid="MintingAuthorityRequestOverlay"
    @close="closeOverlay"
    @pressEsc="closeOverlay"
    class="w-[640px]">
    <template #title>
      <div class="grow text-2xl font-bold">Create Minting Authority Request</div>
    </template>

    <div class="px-6 py-5 text-slate-700">
      <div v-if="isLoading" class="py-10 text-center text-sm font-medium text-slate-500">
        Loading your minting-authority collateral...
      </div>

      <div v-else-if="txInfo" class="space-y-4">
        <div class="text-sm font-semibold text-slate-800">
          {{
            progressError
              ? 'Minting authority request needs attention'
              : progressPct >= 100
                ? 'Minting authority request submitted'
                : 'Submitting minting authority request...'
          }}
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
          Request a new Ethereum minting authority using the bond-backed Argons in your vault operator account and the
          Argonots you have explicitly committed for minting-authority work.
        </p>

        <div
          v-if="relayDelegateNeedsSetup"
          class="rounded-lg border border-amber-200 bg-amber-50 px-4 py-4">
          <div class="flex items-start justify-between gap-4">
            <div class="grow">
              <div class="text-sm font-semibold text-amber-900">Relay Delegate Needs Setup</div>
              <div class="mt-1 text-sm leading-6 text-amber-800">
                Your server can't send Ethereum relays for this vault yet because the relay delegate isn't set up.
              </div>

              <div class="mt-4 grid grid-cols-3 gap-3 text-sm">
                <div class="rounded-md border border-amber-200 bg-white/70 px-3 py-2">
                  <div class="text-xs font-semibold uppercase tracking-wide text-amber-700">Current Balance</div>
                  <div class="mt-1 font-semibold text-amber-950">
                    {{ microgonToArgonNm(relayDelegateBalance).format('0,0.[000000]') }} ARGN
                  </div>
                </div>

                <div class="rounded-md border border-amber-200 bg-white/70 px-3 py-2">
                  <div class="text-xs font-semibold uppercase tracking-wide text-amber-700">Minimum Balance</div>
                  <div class="mt-1 font-semibold text-amber-950">
                    {{ microgonToArgonNm(minimumVaultDelegateBalance).format('0,0.[000000]') }} ARGN
                  </div>
                </div>

                <div class="rounded-md border border-amber-200 bg-white/70 px-3 py-2">
                  <div class="text-xs font-semibold uppercase tracking-wide text-amber-700">Setup Funding</div>
                  <div class="mt-1 font-semibold text-amber-950">
                    {{ microgonToArgonNm(targetVaultDelegateBalance).format('0,0.[000000]') }} ARGN
                  </div>
                </div>
              </div>
            </div>

            <button
              type="button"
              :disabled="isSubmitting || isUpdatingRelayDelegate"
              data-testid="MintingAuthorityRequestOverlay.updateRelayDelegate()"
              class="bg-argon-button hover:bg-argon-button-hover shrink-0 rounded px-4 py-2 text-sm font-semibold text-white disabled:cursor-default disabled:opacity-40"
              @click="updateRelayDelegate">
              <template v-if="isUpdatingRelayDelegate">Setting Up...</template>
              <template v-else>Set Up Relay Delegate</template>
            </button>
          </div>
        </div>

        <div
          v-else-if="relayDelegateTopUpAmount > 0n"
          class="rounded-lg border border-amber-200 bg-amber-50 px-4 py-4">
          <div class="flex items-start justify-between gap-4">
            <div class="grow">
              <div class="text-sm font-semibold text-amber-900">Relay Delegate Needs Funds</div>
              <div class="mt-1 text-sm leading-6 text-amber-800">
                Your server's relay delegate is low on funds. Top it up here so your server can keep sending Ethereum
                relays for this vault.
              </div>

              <div class="mt-4 grid grid-cols-3 gap-3 text-sm">
                <div class="rounded-md border border-amber-200 bg-white/70 px-3 py-2">
                  <div class="text-xs font-semibold uppercase tracking-wide text-amber-700">Current Balance</div>
                  <div class="mt-1 font-semibold text-amber-950">
                    {{ microgonToArgonNm(relayDelegateBalance).format('0,0.[000000]') }} ARGN
                  </div>
                </div>

                <div class="rounded-md border border-amber-200 bg-white/70 px-3 py-2">
                  <div class="text-xs font-semibold uppercase tracking-wide text-amber-700">Minimum Balance</div>
                  <div class="mt-1 font-semibold text-amber-950">
                    {{ microgonToArgonNm(minimumVaultDelegateBalance).format('0,0.[000000]') }} ARGN
                  </div>
                </div>

                <div class="rounded-md border border-amber-200 bg-white/70 px-3 py-2">
                  <div class="text-xs font-semibold uppercase tracking-wide text-amber-700">Top-Up Needed</div>
                  <div class="mt-1 font-semibold text-amber-950">
                    {{ microgonToArgonNm(relayDelegateTopUpAmount).format('0,0.[000000]') }} ARGN
                  </div>
                </div>
              </div>
            </div>

            <button
              type="button"
              :disabled="isSubmitting || isUpdatingRelayDelegate"
              data-testid="MintingAuthorityRequestOverlay.updateRelayDelegate()"
              class="bg-argon-button hover:bg-argon-button-hover shrink-0 rounded px-4 py-2 text-sm font-semibold text-white disabled:cursor-default disabled:opacity-40"
              @click="updateRelayDelegate">
              <template v-if="isUpdatingRelayDelegate">Topping Up...</template>
              <template v-else>Top Up Relay Delegate</template>
            </button>
          </div>
        </div>

        <div class="grid grid-cols-2 gap-3">
          <div class="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
            <div class="text-xs font-semibold uppercase tracking-wide text-slate-400">Council signing key</div>
            <div class="mt-2 break-all font-mono text-sm text-slate-700">
              {{ councilSigner || 'Loading council signer...' }}
            </div>
          </div>

          <div class="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3">
            <div class="text-xs font-semibold uppercase tracking-wide text-emerald-700">New authority signing key</div>
            <div class="mt-1 text-sm font-semibold text-emerald-900">
              {{ nextAuthorityIndex != null ? `Signer #${nextAuthorityIndex}` : 'Preparing signer...' }}
            </div>
            <div class="mt-2 break-all font-mono text-sm text-emerald-800">
              {{ nextAuthoritySigner || 'Loading a fresh minting-authority signer...' }}
            </div>
          </div>
        </div>

        <div class="rounded-lg border border-slate-200 bg-white px-4 py-4">
          <div class="text-sm font-semibold text-slate-800">Current minting authorities</div>
          <div class="mt-1 text-sm text-slate-500">
            These are the Ethereum signing keys currently attached to your vault operator account.
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

        <div class="grid grid-cols-2 gap-3">
          <div class="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
            <div class="text-xs font-semibold uppercase tracking-wide text-slate-400">Epoch Argonot Conversion</div>
            <div class="mt-1 text-lg font-semibold text-slate-800">
              {{ microgonToArgonNm(epochMicrogonsPerArgonot).format('0,0.[000000]') }} ARGN / ARGNOT
            </div>
          </div>

          <div class="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
            <div class="text-xs font-semibold uppercase tracking-wide text-slate-400">Minimum request value</div>
            <div class="mt-1 text-lg font-semibold text-slate-800">
              {{ microgonToArgonNm(minimumRequiredMicrogons).format('0,0.[000000]') }} ARGN
            </div>
          </div>

          <div class="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
            <div class="text-xs font-semibold uppercase tracking-wide text-slate-400">Bond-backed ARGN available</div>
            <div class="mt-1 text-lg font-semibold text-slate-800">
              {{ microgonToArgonNm(remainingBondMicrogons).format('0,0.[000000]') }} ARGN
            </div>
          </div>

          <div class="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
            <div class="text-xs font-semibold uppercase tracking-wide text-slate-400">Committed ARGNOT available</div>
            <div class="mt-1 text-lg font-semibold text-slate-800">
              {{ micronotToArgonotNm(remainingCommittedMicronots).format('0,0.[000000]') }} ARGNOT
            </div>
          </div>
        </div>

        <div class="rounded-lg border border-slate-200 bg-white px-4 py-4">
          <div class="text-sm font-semibold text-slate-800">Request collateral</div>
          <div class="mt-1 text-sm text-slate-500">
            Defaults are maxed to your currently available bond-backed Argons and remaining committed Argonots.
          </div>

          <div class="mt-4 grid grid-cols-2 gap-4">
            <div>
              <label class="mb-1.5 block text-sm font-medium text-slate-600">Bond-backed Argons</label>
              <InputToken
                v-model="microgonCollateral"
                data-testid="MintingAuthorityRequestOverlay.microgonCollateral"
                :min="0n"
                :max="remainingBondMicrogons"
                :dragBy="ONE_TOKEN"
                :dragByMin="ONE_TOKEN / 100n"
                :minDecimals="0"
                :maxDecimals="6"
                suffix=" ARGN"
              />
            </div>

            <div>
              <label class="mb-1.5 block text-sm font-medium text-slate-600">Committed Argonots</label>
              <InputToken
                v-model="micronotCollateral"
                data-testid="MintingAuthorityRequestOverlay.micronotCollateral"
                :min="0n"
                :max="remainingCommittedMicronots"
                :dragBy="ONE_TOKEN"
                :dragByMin="ONE_TOKEN / 100n"
                :minDecimals="0"
                :maxDecimals="6"
                suffix=" ARGNOT"
              />
            </div>
          </div>

          <div class="mt-4 rounded-md border border-slate-200 bg-slate-50 px-4 py-3">
            <div class="text-xs font-semibold uppercase tracking-wide text-slate-400">Total request value</div>
            <div class="mt-1 text-2xl font-semibold text-slate-800">
              {{ microgonToArgonNm(requestValueMicrogons).format('0,0.[000000]') }} ARGN
            </div>
            <div class="mt-1 text-xs text-slate-500">
              This combines your direct bond-backed ARGN with committed ARGNOT converted at the current council value.
            </div>
          </div>
        </div>

        <div v-if="validationMessage" class="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
          {{ validationMessage }}
        </div>

        <div
          v-if="activationRelayError"
          class="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {{ activationRelayError }}
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
            :disabled="isSubmitting || isUpdatingRelayDelegate || !!validationMessage"
            data-testid="MintingAuthorityRequestOverlay.submit()"
            class="bg-argon-button hover:bg-argon-button-hover rounded px-5 py-2 text-sm font-semibold text-white disabled:cursor-default disabled:opacity-40"
            @click="submit">
            {{ isSubmitting ? 'Submitting...' : 'Create Request' }}
          </button>
        </div>
      </div>
    </div>
  </OverlayBase>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import {
  BondLot,
  minimumVaultDelegateBalance,
  targetVaultDelegateBalance,
  TreasuryBonds,
} from '@argonprotocol/apps-core';
import { MICROGONS_PER_ARGON } from '@argonprotocol/mainchain';
import InputToken from '../components/InputToken.vue';
import ProgressBar from '../components/ProgressBar.vue';
import OverlayBase from './OverlayBase.vue';
import basicEmitter from '../emitters/basicEmitter.ts';
import { type TransactionInfo } from '../lib/TransactionInfo.ts';
import { createNumeralHelpers } from '../lib/numeral.ts';
import { generateProgressLabel } from '../lib/Utils.ts';
import { getCurrency } from '../stores/currency.ts';
import { getEthereumGatewayPauseReason, getFinalizedClient } from '../stores/mainchain.ts';
import { getMyVault } from '../stores/vaults.ts';
import { getWalletKeys, useWallets } from '../stores/wallets.ts';

const ONE_TOKEN = BigInt(MICROGONS_PER_ARGON);
const MINIMUM_REQUEST_VALUE_MICROGONS = 10_000n * ONE_TOKEN;

const currency = getCurrency();
const myVault = getMyVault();
const walletKeys = getWalletKeys();
const wallets = useWallets();

const { microgonToArgonNm, micronotToArgonotNm } = createNumeralHelpers(currency);

const isOpen = Vue.ref(false);
const isLoading = Vue.ref(false);
const isSubmitting = Vue.ref(false);
const isUpdatingRelayDelegate = Vue.ref(false);
const loadError = Vue.ref('');
const submitError = Vue.ref('');
const vaultId = Vue.ref<number>();

const remainingBondMicrogons = Vue.ref(0n);
const remainingCommittedMicronots = Vue.ref(0n);
const minimumRequiredMicrogons = Vue.ref(MINIMUM_REQUEST_VALUE_MICROGONS);
const epochMicrogonsPerArgonot = Vue.ref(0n);
const relayDelegateAddress = Vue.ref('');
const relayDelegateBalance = Vue.ref(0n);
const relayDelegateTopUpAmount = Vue.ref(0n);

const microgonCollateral = Vue.ref(0n);
const micronotCollateral = Vue.ref(0n);

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
const councilSigner = Vue.ref('');
const nextAuthoritySigner = Vue.ref('');
const nextAuthorityIndex = Vue.ref<number>();

const txInfo = Vue.ref<TransactionInfo>();
const progressPct = Vue.ref(0);
const progressMessage = Vue.ref('');
const progressError = Vue.ref('');
const activationRelayError = Vue.ref('');

let unsubProgress: (() => void) | undefined;

const maximumRequestValueMicrogons = Vue.computed(() => {
  return (
    remainingBondMicrogons.value + (remainingCommittedMicronots.value * epochMicrogonsPerArgonot.value) / ONE_TOKEN
  );
});

const requestValueMicrogons = Vue.computed(() => {
  return microgonCollateral.value + (micronotCollateral.value * epochMicrogonsPerArgonot.value) / ONE_TOKEN;
});

const relayDelegateNeedsSetup = Vue.computed(() => {
  if (!relayDelegateAddress.value) return false;

  return myVault.createdVault?.delegateAccountId !== relayDelegateAddress.value;
});

const validationMessage = Vue.computed(() => {
  if (!vaultId.value) {
    return 'Create your vault before creating a minting authority request.';
  }
  if (epochMicrogonsPerArgonot.value <= 0n) {
    return 'The current council Argonot value is not available yet for Ethereum.';
  }
  if (!nextAuthoritySigner.value || nextAuthorityIndex.value == null) {
    return 'A new minting-authority signing key is still being prepared.';
  }
  if (remainingBondMicrogons.value <= 0n && remainingCommittedMicronots.value <= 0n) {
    return 'No bond-backed Argons or committed Argonots are currently available for a minting authority request.';
  }
  if (maximumRequestValueMicrogons.value < minimumRequiredMicrogons.value) {
    return `Available collateral totals ${microgonToArgonNm(maximumRequestValueMicrogons.value).format('0,0.[000000]')} ARGN, which is below the ${microgonToArgonNm(minimumRequiredMicrogons.value).format('0,0.[000000]')} ARGN minimum.`;
  }
  if (requestValueMicrogons.value <= 0n) {
    return 'Add bond-backed ARGN, committed ARGNOT, or both.';
  }
  if (requestValueMicrogons.value < minimumRequiredMicrogons.value) {
    return `Minting authority collateral must be at least ${microgonToArgonNm(minimumRequiredMicrogons.value).format('0,0.[000000]')} ARGN in total value.`;
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
  vaultId.value = undefined;
  currentAuthorities.value = [];
  councilSigner.value = '';
  nextAuthoritySigner.value = '';
  nextAuthorityIndex.value = undefined;
  activationRelayError.value = '';
  remainingBondMicrogons.value = 0n;
  remainingCommittedMicronots.value = 0n;
  minimumRequiredMicrogons.value = MINIMUM_REQUEST_VALUE_MICROGONS;
  epochMicrogonsPerArgonot.value = 0n;
  relayDelegateAddress.value = '';
  relayDelegateBalance.value = 0n;
  relayDelegateTopUpAmount.value = 0n;
  microgonCollateral.value = 0n;
  micronotCollateral.value = 0n;

  try {
    await Promise.all([wallets.isLoadedPromise, myVault.load()]);

    if (!myVault.vaultId) {
      return;
    }

    vaultId.value = myVault.vaultId;

    const [[localCouncilSigner], delegateKeypair, finalizedClient] = await Promise.all([
      walletKeys.getEthereumAddresses([walletKeys.councilSignerEthereumHdPath]),
      walletKeys.getVaultDelegateKeypair(),
      getFinalizedClient(),
    ]);
    relayDelegateAddress.value = delegateKeypair.address;
    await Promise.all([
      myVault.mintingAuthorities.refresh(finalizedClient),
      myVault.globalCouncil.refresh(finalizedClient),
    ]);
    const [
      commitmentOption,
      bondLots,
      encumberedBondMicrogons,
      activeCouncilHashOption,
      minimumMintingAuthorityValue,
      relayDelegateAccount,
    ] = await Promise.all([
      finalizedClient.query.vaults.argonotCommitmentByVaultId(vaultId.value),
      TreasuryBonds.getBondLots(finalizedClient, vaultId.value, walletKeys.vaultingAddress),
      finalizedClient.query.treasury.encumberedBondMicrogonsByAccount(walletKeys.vaultingAddress),
      finalizedClient.query.crosschainTransfer.activeGlobalIssuanceCouncilByDestinationChain('Ethereum'),
      finalizedClient.query.crosschainTransfer.minimumMintingAuthorityValueByDestinationChain('Ethereum'),
      finalizedClient.query.system.account(delegateKeypair.address),
    ]);

    if (commitmentOption.isSome) {
      const commitment = commitmentOption.unwrap();
      const committedMicronots = BigInt(commitment.committedMicronots.toString());
      const encumberedMicronots = BigInt(commitment.encumberedMicronots.toString());
      remainingCommittedMicronots.value = bigintMax(committedMicronots - encumberedMicronots, 0n);
    }

    const bondTotals = BondLot.getTotals(bondLots);
    remainingBondMicrogons.value = bigintMax(bondTotals.activeBondMicrogons - encumberedBondMicrogons.toBigInt(), 0n);

    minimumRequiredMicrogons.value = minimumMintingAuthorityValue.toBigInt();
    relayDelegateBalance.value = relayDelegateAccount.data.free.toBigInt();
    relayDelegateTopUpAmount.value =
      relayDelegateBalance.value >= minimumVaultDelegateBalance
        ? 0n
        : targetVaultDelegateBalance - relayDelegateBalance.value;

    councilSigner.value = myVault.globalCouncil.data.councilSigner ?? localCouncilSigner;

    if (activeCouncilHashOption.isSome) {
      const councilOption = await finalizedClient.query.crosschainTransfer.globalIssuanceCouncilByHash(
        activeCouncilHashOption.unwrap().toHex(),
      );
      if (councilOption.isSome) {
        epochMicrogonsPerArgonot.value = councilOption.unwrap().epochMicrogonsPerArgonot.toBigInt();
      }
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

    if (currentAuthorities.value.some(authority => authority.isPendingActivation)) {
      activationRelayError.value = (await getEthereumGatewayPauseReason(finalizedClient)) ?? '';
    }

    const nextSigner = await myVault.mintingAuthorities.getNextSigner(councilSigner.value);

    nextAuthoritySigner.value = nextSigner.signer;
    nextAuthorityIndex.value = nextSigner.authorityIndex;

    microgonCollateral.value = remainingBondMicrogons.value;
    micronotCollateral.value = remainingCommittedMicronots.value;
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : 'Unable to load minting authority collateral.';
  } finally {
    isLoading.value = false;
  }
}

async function submit() {
  if (isSubmitting.value || validationMessage.value || !vaultId.value || nextAuthorityIndex.value == null) {
    return;
  }

  submitError.value = '';
  isSubmitting.value = true;

  try {
    const relaySetupTx = await myVault.ensureDelegatedBitcoinSigner();
    await relaySetupTx?.waitForPostProcessing;

    const info = await myVault.mintingAuthorities.register({
      microgonCollateral: microgonCollateral.value,
      micronotCollateral: micronotCollateral.value,
      authorityIndex: nextAuthorityIndex.value!,
      signer: nextAuthoritySigner.value,
      councilSigner: councilSigner.value,
    });

    txInfo.value = info;
    void info.waitForPostProcessing.then(loadState).catch(() => undefined);

    unsubProgress = info.subscribeToProgress((args, error) => {
      progressPct.value = args.progressPct;
      progressMessage.value =
        args.progressPct >= 100 && !error
          ? 'Minting authority request submitted for council approval.'
          : generateProgressLabel(args.confirmations, args.expectedConfirmations);

      if (error) {
        progressError.value = error.message ?? 'Transaction failed.';
      }
    });
  } catch (error) {
    submitError.value = error instanceof Error ? error.message : 'Unable to create a minting authority request.';
    isSubmitting.value = false;
  }
}

async function updateRelayDelegate() {
  if (isUpdatingRelayDelegate.value || isSubmitting.value || !vaultId.value) {
    return;
  }

  submitError.value = '';
  isUpdatingRelayDelegate.value = true;

  try {
    const relaySetupTx = await myVault.ensureDelegatedBitcoinSigner();
    await relaySetupTx?.waitForPostProcessing;
    await loadState();
  } catch (error) {
    submitError.value = error instanceof Error ? error.message : 'Unable to update the relay delegate.';
  } finally {
    isUpdatingRelayDelegate.value = false;
  }
}

function bigintMax(left: bigint, right: bigint) {
  return left > right ? left : right;
}

basicEmitter.on('openMintingAuthorityRequestOverlay', () => {
  isOpen.value = true;
  void loadState();
});

Vue.onUnmounted(() => {
  unsubProgress?.();
});
</script>
