<template>
  <div v-if="!config.isServerInstalled" class="my-16 text-center text-slate-700/50">
    You must wait for your
    <br />
    <a @click="openServerOverlay" class="cursor-pointer">server to finish installing</a>
    .
  </div>

  <div v-else-if="!hasProfileName" class="my-16 text-center text-slate-700/50">
    You must
    <a @click="updateProfileOverlay" class="cursor-pointer">set your profile name</a>
    before
    <br />
    creating referral codes.
  </div>

  <div v-else class="px-6 text-slate-700">
    <section ref="createSectionRef" class="mt-6 bg-white px-2">
      <div class="mt-5">
        <div StatsBox box class="mt-3 grid grid-cols-3 overflow-hidden text-center">
          <Tooltip asChild side="top" content="Claimed and unclaimed referral rewards.">
            <div StatWrapper class="border-r border-slate-200/70 px-4 py-4">
              <div Stat class="text-4xl! leading-none">
                ₳{{ microgonToArgonNm(controller.inviteSlotProgress.rewardsEarnedAmount).format('0,0.[00]') }}
              </div>
              <div class="mt-2 text-xs font-semibold tracking-widest text-slate-400 uppercase">Earned</div>
            </div>
          </Tooltip>

          <Tooltip
            asChild
            side="top"
            :content="`Every ${controller.rewardConfig.referralBonusEveryXOperationalSponsees} referred operators earns this bonus.`"
          >
            <div StatWrapper class="border-r border-slate-200/70 px-4 py-4">
              <div Stat class="text-4xl! leading-none">
                ₳{{ microgonToArgonNm(controller.rewardConfig.referralBonusReward).format('0,0.[00]') }}
              </div>
              <div class="mt-2 text-xs font-semibold tracking-widest text-slate-400 uppercase">Next Bonus</div>
            </div>
          </Tooltip>

          <Tooltip asChild side="top" content="Your progress toward the next referral bonus.">
            <div StatWrapper class="px-4 py-4">
              <div Stat class="text-4xl! leading-none">{{ referralBonusProgressLabel }}</div>
              <div class="mt-2 text-xs font-semibold tracking-widest text-slate-400 uppercase">Bonus Progress</div>
            </div>
          </Tooltip>
        </div>
        <div
          v-if="hasUnclaimedRewards"
          class="mt-5 flex items-center justify-between gap-4 text-sm leading-6 text-slate-500"
        >
          <div class="min-w-0">
            You have
            <span class="font-semibold text-slate-700">
              ₳{{ microgonToArgonNm(controller.pendingRewardsAmount).format('0,0.[00]') }}
            </span>
            ready to claim in the Argon Treasury.
          </div>
          <button
            type="button"
            class="text-argon-700 bg-argon-600/5 hover:bg-argon-600/10 shrink-0 rounded-md px-3 py-1.5 text-sm font-semibold"
            @click="emit('goTo', 'claim')"
          >
            Claim ₳{{ microgonToArgonNm(controller.pendingRewardsAmount).format('0,0.[00]') }}
          </button>
        </div>

        <div v-else class="text-md mt-5 text-slate-500">
          You receive ₳{{ microgonToArgonNm(controller.rewardConfig.operationalReferralReward).format('0,0.[00]') }}
          when someone you refer finishes their operator setup. Every
          {{ controller.rewardConfig.referralBonusEveryXOperationalSponsees }} successful referrals triggers a ₳{{
            microgonToArgonNm(controller.rewardConfig.referralBonusReward).format('0,0.[00]')
          }}
          bonus.
        </div>
      </div>

      <div class="mt-5 flex items-center justify-between gap-4 border-t border-slate-300 pt-5">
        <div class="text-lg font-semibold text-slate-800">Referral Codes</div>
        <div class="text-sm text-slate-500">{{ controller.activeOperationalInviteCount }} active</div>
      </div>

      <div class="pt-2 text-sm text-slate-500">
        When you create a referral code, you'll be given a personalized link that will bind a recruit to your account.
        Send it to a recruit any way you like.
      </div>

      <div v-if="errorMessage || infoMessage" class="mt-4 space-y-3">
        <div v-if="errorMessage" class="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {{ errorMessage }}
        </div>
        <div
          v-if="infoMessage"
          class="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700"
        >
          {{ infoMessage }}
        </div>
      </div>

      <OperationalInviteSlots
        v-model:draftNamesBySlot="inviteNamesBySlot"
        class="mt-4"
        mode="overlay"
        :progress="controller.inviteSlotProgress"
        :rewardConfig="controller.rewardConfig"
        :invites="controller.operationalInvites"
        :inviteStatusesByCode="controller.operationalInviteStatusesByCode"
        :inviteLinksByCode="inviteLinksByCode"
        :isCreating="isCreatingInvite"
        @create="createInvite"
        @regenerate="regenerateInviteLink"
      />
    </section>

    <section ref="unlockSectionRef" class="mt-5 border-t border-slate-200/70 px-2 pt-4">
      <div class="text-sm font-semibold tracking-widest text-slate-400 uppercase">
        Progress Towards Your Next Referral Code
      </div>

      <div class="mt-3 grid gap-2">
        <div
          v-for="card in progressCards"
          :key="card.title"
          class="rounded-xl border border-slate-200/70 bg-slate-50/40 px-3 py-3"
        >
          <div class="flex items-start justify-between gap-3">
            <div class="text-sm font-semibold text-slate-800">{{ card.title }}</div>
            <div class="text-argon-700/80 font-mono text-xs font-semibold">
              <template v-if="card.microgonValue">
                ₳{{ microgonToArgonNm(card.currentMicrogons).format('0,0.[00]') }} / ₳{{
                  microgonToArgonNm(card.targetMicrogons).format('0,0.[00]')
                }}
              </template>
              <template v-else>{{ card.value }}</template>
            </div>
          </div>
          <div class="mt-2 h-1.5 rounded-full bg-slate-200/80">
            <div class="bg-argon-600 h-full rounded-full transition-all" :style="{ width: `${card.progressPct}%` }" />
          </div>
          <div class="mt-2 text-xs leading-5 text-slate-500">{{ card.copy }}</div>
        </div>
      </div>
    </section>

    <section ref="outboundSectionRef" class="mt-5 scroll-mt-6 border-t border-slate-200/70 px-2 pt-4">
      <div class="flex items-center justify-between gap-4">
        <div class="text-sm font-semibold tracking-widest text-slate-400 uppercase">Referral History</div>
        <div class="text-sm text-slate-500">{{ historicalInvites.length }} total</div>
      </div>

      <div
        v-if="historicalInvites.length === 0"
        class="mt-5 rounded-2xl border border-dashed border-slate-300 px-4 py-8 text-center text-sm text-slate-500"
      >
        No completed referral history yet. Older referral codes will appear here after they expire or become
        operational.
      </div>

      <div v-else class="mt-5 space-y-3">
        <Tooltip
          v-for="invite in historicalInvites"
          :key="invite.id"
          asChild
          side="top"
          :content="inviteHistoryTooltip(invite)"
        >
          <div
            class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 rounded-xl border border-slate-200/70 bg-slate-50/40 px-3 py-3 transition hover:border-slate-300 hover:bg-white"
          >
            <div class="min-w-0">
              <div class="font-semibold text-slate-800">{{ invite.name }}</div>
              <div class="mt-1 text-sm text-slate-500">{{ inviteHistorySummary(invite) }}</div>
              <div v-if="inviteStatus(invite).showRewardNote" class="mt-2 text-sm font-medium text-emerald-700">
                Both accounts earned claimable rewards.
              </div>
            </div>

            <div
              class="justify-self-end rounded-full px-3 py-1 text-xs font-semibold"
              :class="inviteStatusClasses(inviteStatus(invite).label)"
            >
              {{ inviteStatus(invite).label }}
            </div>
          </div>
        </Tooltip>
      </div>
    </section>
  </div>
</template>

<script lang="ts">
const createdInviteEnvelopesByCode: Record<string, string> = {};
</script>

<script setup lang="ts">
import * as Vue from 'vue';
import type { IOperationalUserInvite } from '@argonprotocol/apps-router';
import { InviteCodes, NetworkConfig, UserRole } from '@argonprotocol/apps-core';
import Tooltip from '../../../components/Tooltip.vue';
import OperationalInviteSlots from '../../components/OperationalInviteSlots.vue';
import basicEmitter from '../../../emitters/basicEmitter.ts';
import { getConfig } from '../../../stores/config.ts';
import { getMyVault } from '../../../stores/vaults.ts';
import { InviteEnvelope } from '../../../lib/InviteEnvelope.ts';
import {
  type IOperationalInviteStatus,
  type IOperationalInviteStatusLabel,
  useOperationsController,
} from '../../../stores/operationsController.ts';
import { createNumeralHelpers } from '../../../lib/numeral.ts';
import { getCurrency } from '../../../stores/currency.ts';
import { getMainchainClient } from '../../../stores/mainchain.ts';
import { getServerApiClient } from '../../../stores/server.ts';
import { getWalletKeys } from '../../../stores/wallets.ts';
import { clampProgressValue, getCappedPercent } from '../../../lib/Utils.ts';
import { signReferralSponsorGrant } from '../../../lib/OperationalAccount.ts';
import { UpstreamOperatorClient } from '../../../lib/UpstreamOperatorClient.ts';

type OperationalRewardsSection = 'create' | 'unlock' | 'outbound';

const props = defineProps<{
  isActive: boolean;
  section?: OperationalRewardsSection;
  sectionRequestId: number;
}>();

const emit = defineEmits<{
  goTo: [screen: 'claim'];
}>();

const config = getConfig();
const myVault = getMyVault();
const controller = useOperationsController();

const currency = getCurrency();
const serverApiClient = getServerApiClient();
const walletKeys = getWalletKeys();

const { microgonToArgonNm } = createNumeralHelpers(currency);

const isCreatingInvite = Vue.ref(false);

const createSectionRef = Vue.ref<HTMLElement>();
const unlockSectionRef = Vue.ref<HTMLElement>();
const outboundSectionRef = Vue.ref<HTMLElement>();

const errorMessage = Vue.ref<string | null>(null);
const infoMessage = Vue.ref<string | null>(null);

const inviteNamesBySlot = Vue.ref<Record<number, string>>({});
const inviteLinksRevision = Vue.ref(0);

let scrollAnimationFrame: number | undefined;

const currentVaultName = Vue.computed(() => {
  return myVault.createdVault?.name ?? '';
});

const hasProfileName = Vue.computed(() => {
  return !!currentVaultName.value;
});

const canCreateInvite = Vue.computed(() => {
  return controller.inviteSlotProgress.availableReferrals > 0;
});

const hasUnclaimedRewards = Vue.computed(() => {
  return controller.pendingRewardsAmount > 0n;
});

const referralBonusProgressLabel = Vue.computed(() => {
  const bonusEvery = Math.max(controller.rewardConfig.referralBonusEveryXOperationalSponsees, 1);
  return `${controller.inviteSlotProgress.operationalReferralsCount % bonusEvery}/${bonusEvery}`;
});

const progressCards = Vue.computed(() => {
  const btcCurrent = controller.inviteSlotProgress.bitcoinAccrual;
  const btcTarget = controller.rewardConfig.bitcoinLockSizeForReferral;

  const miningCurrent = controller.inviteSlotProgress.miningSeatAccrual;
  const miningTarget = controller.rewardConfig.miningSeatsPerReferral;

  const referralCurrent = controller.inviteSlotProgress.referralPending ? 1 : 0;

  return [
    {
      title: 'BTC lock progress',
      value: '',
      microgonValue: true,
      currentMicrogons: clampProgressValue(btcCurrent, btcTarget),
      targetMicrogons: btcTarget,
      copy:
        btcCurrent >= btcTarget
          ? 'Another referral code is ready from BTC lock progress.'
          : 'Lock another ₳5,000 worth of BTC',
      progressPct: getCappedPercent(btcCurrent, btcTarget),
    },
    {
      title: 'Mining seat progress',
      value: `${clampProgressValue(miningCurrent, miningTarget)} / ${miningTarget}`,
      microgonValue: false,
      currentMicrogons: 0n,
      targetMicrogons: 0n,
      copy:
        miningCurrent >= miningTarget
          ? 'Another referral code is ready from mining seats.'
          : `Win ${miningTarget} more mining seats`,
      progressPct: getCappedPercent(miningCurrent, miningTarget),
    },
    {
      title: 'Referral progress',
      value: `${referralCurrent} / 1`,
      microgonValue: false,
      currentMicrogons: 0n,
      targetMicrogons: 0n,
      copy: controller.inviteSlotProgress.referralPending
        ? 'Another referral code is ready from referrals.'
        : 'Get 1 more account fully operational',
      progressPct: getCappedPercent(referralCurrent, 1),
    },
  ];
});

const inviteLinksByCode = Vue.computed(() => {
  inviteLinksRevision.value;
  return Object.fromEntries(
    Object.entries(createdInviteEnvelopesByCode).map(([inviteCode, inviteEnvelope]) => [
      inviteCode,
      getOperationalInviteUrl(inviteEnvelope),
    ]),
  );
});

const historicalInvites = Vue.computed(() => {
  return controller.operationalInvites.filter(invite => !isActiveInvite(invite));
});

function updateProfileOverlay() {
  basicEmitter.emit('openProfileOverlay');
}

function openServerOverlay() {
  basicEmitter.emit('openServerOverlay');
}

function inviteStatus(invite: IOperationalUserInvite): IOperationalInviteStatus {
  const status = controller.operationalInviteStatusesByCode[invite.inviteCode];
  if (status?.label === 'Became operational' || status?.label === 'Expired') return status;
  if (invite.accountId) return { label: 'Registered', showRewardNote: false };
  return status ?? { label: 'Not opened', showRewardNote: false };
}

function inviteStatusClasses(label: IOperationalInviteStatusLabel) {
  if (label === 'Opened') return 'border border-amber-200 bg-amber-50 text-amber-700';
  if (label === 'Registered') return 'border border-sky-200 bg-sky-50 text-sky-700';
  if (label === 'Became operational') return 'border border-emerald-200 bg-emerald-50 text-emerald-700';
  if (label === 'Expired') return 'border border-slate-200 bg-slate-100 text-slate-500';
  return 'border border-slate-200 bg-slate-100 text-slate-600';
}

function inviteHistorySummary(invite: IOperationalUserInvite) {
  if (invite.accountId) return `Registered as ${shortInviteCode(invite.accountId)}`;
  if (invite.lastClickedAt) return 'Invite link opened';
  return `Issued as ${shortInviteCode(invite.inviteCode)}`;
}

function inviteHistoryTooltip(invite: IOperationalUserInvite) {
  const status = inviteStatus(invite).label;
  if (status === 'Became operational')
    return `${invite.name} became fully operational, so referral rewards can become claimable.`;
  if (status === 'Registered')
    return `${invite.name} registered from your referral link and still needs to complete the Argon Operational Certification.`;
  if (status === 'Opened')
    return `${invite.name} opened the referral link and still needs to complete the Argon Operational Certification.`;
  if (status === 'Expired') return `${invite.name}'s referral code is no longer active.`;
  return `${invite.name}'s referral record is kept here for history.`;
}

function isActiveInvite(invite: IOperationalUserInvite) {
  const status = inviteStatus(invite).label;
  return status !== 'Became operational' && status !== 'Expired';
}

async function loadInvites() {
  errorMessage.value = null;
  if (!config.serverDetails.ipAddress) {
    controller.setOperationalInvites([]);
    return;
  }

  try {
    await controller.loadOperationalInvites();
  } catch {
    controller.setOperationalInvites([]);
    errorMessage.value = 'Unable to load referral codes right now. Please try again.';
  }
}

async function createInvite({ slotNumber, name }: { slotNumber: number; name: string }) {
  if (isCreatingInvite.value) return;

  if (!name) {
    errorMessage.value = 'Enter a name for the invite.';
    return;
  }
  if (!config.serverDetails.ipAddress) {
    errorMessage.value = 'No server is available to create an invite.';
    return;
  }
  if (!canCreateInvite.value) {
    errorMessage.value = 'You do not have a referral code ready to issue yet.';
    return;
  }

  try {
    errorMessage.value = null;
    infoMessage.value = null;
    isCreatingInvite.value = true;
    await myVault.load();

    const fromName = currentVaultName.value.trim();
    if (!fromName) {
      throw new Error('Set your profile name before creating referral codes.');
    }

    const { inviteCode, inviteEnvelope, operationalReferral } = await buildOperationalInviteLink();

    const invite = await serverApiClient.createOperationalInvite({
      name,
      fromName,
      inviteCode,
      ...operationalReferral,
    });

    const nextInvites = [invite, ...controller.operationalInvites.filter(x => x.id !== invite.id)];
    controller.setOperationalInvites(nextInvites);

    createdInviteEnvelopesByCode[invite.inviteCode] = inviteEnvelope;
    inviteLinksRevision.value += 1;

    await navigator.clipboard.writeText(getOperationalInviteUrl(inviteEnvelope)).catch(() => undefined);

    infoMessage.value = 'Invite link copied.';
    inviteNamesBySlot.value[slotNumber] = '';

    await loadInvites();
  } catch (error: any) {
    errorMessage.value = error?.message ?? 'Unable to create invite.';
  } finally {
    isCreatingInvite.value = false;
  }
}

async function regenerateInviteLink({ inviteCode }: { inviteCode: string }) {
  if (isCreatingInvite.value) return;

  if (!config.serverDetails.ipAddress) {
    errorMessage.value = 'No server is available to regenerate this invite link.';
    return;
  }

  const existingInvite = controller.operationalInvites.find(invite => invite.inviteCode === inviteCode);
  if (!existingInvite || existingInvite.lastClickedAt || existingInvite.accountId) {
    errorMessage.value = 'This invite link has already been opened.';
    return;
  }

  try {
    errorMessage.value = null;
    infoMessage.value = null;
    isCreatingInvite.value = true;
    await myVault.load();

    const { inviteCode: newInviteCode, inviteEnvelope } = await buildOperationalInviteLink();
    const invite = await serverApiClient.regenerateOperationalInvite(inviteCode, {
      inviteCode: newInviteCode,
    });

    const nextInvites = [invite, ...controller.operationalInvites.filter(x => x.id !== invite.id)];
    controller.setOperationalInvites(nextInvites);

    delete createdInviteEnvelopesByCode[inviteCode];
    createdInviteEnvelopesByCode[invite.inviteCode] = inviteEnvelope;
    inviteLinksRevision.value += 1;

    await navigator.clipboard.writeText(getOperationalInviteUrl(inviteEnvelope)).catch(() => undefined);

    infoMessage.value = 'Invite link regenerated and copied.';

    await loadInvites();
  } catch (error: any) {
    errorMessage.value = error?.message ?? 'Unable to regenerate invite link.';
  } finally {
    isCreatingInvite.value = false;
  }
}

async function buildOperationalInviteLink() {
  const client = await getMainchainClient(false);
  const signer = await walletKeys.getOperationalKeypair();
  const currentFrameId = (await client.query.miningSlot.nextFrameId()).toNumber() - 1;
  const expiresAfterFrames = Math.ceil(
    (10 * 24 * 60 * 60 * 1000) / (NetworkConfig.rewardTicksPerFrame * NetworkConfig.tickMillis),
  );

  const { inviteSecret, inviteCode } = InviteCodes.create();
  const expiresAtFrame = currentFrameId + expiresAfterFrames;
  const sponsorSignature = signReferralSponsorGrant({
    sponsor: signer,
    inviteCode,
    expiresAtFrame,
  });
  const operationalReferral = {
    sponsor: signer.address,
    expiresAtFrame,
    sponsorSignature,
  };

  const inviteEnvelope = InviteEnvelope.encode({
    ...UpstreamOperatorClient.getInviteEndpoint(config.serverDetails),
    role: UserRole.OperationalPartner,
    secret: inviteSecret,
    operationalReferral,
  });

  return {
    inviteCode,
    inviteEnvelope,
    operationalReferral,
  };
}

function getOperationalInviteUrl(inviteEnvelope: string) {
  return `${NetworkConfig.get().websiteHost}/operational-invite/${inviteEnvelope}`;
}

Vue.watch(
  [() => props.isActive, () => config.isServerInstalled],
  ([isActive, isServerInstalled], _oldValue, onCleanup) => {
    if (!isActive || !isServerInstalled) return;

    void loadInvites();

    const interval = setInterval(
      () => {
        void loadInvites();
      },
      Math.max(5_000, NetworkConfig.tickMillis / 2),
    );

    onCleanup(() => clearInterval(interval));
  },
);

Vue.watch(
  [() => props.isActive, () => props.sectionRequestId],
  ([isActive]) => {
    if (!isActive) return;

    scrollToSection(props.section);
  },
  { immediate: true },
);

function shortInviteCode(inviteCode: string) {
  return `${inviteCode.slice(0, 12)}…${inviteCode.slice(-6)}`;
}

function scrollToSection(section?: OperationalRewardsSection) {
  if (!section) return;

  void Vue.nextTick(() => {
    const sections = {
      create: createSectionRef.value,
      unlock: unlockSectionRef.value,
      outbound: outboundSectionRef.value,
    };
    const sectionEl = sections[section];
    if (!sectionEl) return;

    animateScrollToSection(sectionEl, () => {
      if (section !== 'create') return;

      createSectionRef.value?.querySelector<HTMLInputElement>('[data-invite-name-input]')?.focus({
        preventScroll: true,
      });
    });
  });
}

function animateScrollToSection(sectionEl: HTMLElement, onComplete?: () => void) {
  const scroller = findScrollParent(sectionEl);
  if (!scroller) {
    sectionEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setTimeout(() => onComplete?.(), 600);
    return;
  }

  if (scrollAnimationFrame) {
    cancelAnimationFrame(scrollAnimationFrame);
  }

  const startTop = scroller.scrollTop;
  const scrollerRect = scroller.getBoundingClientRect();
  const sectionRect = sectionEl.getBoundingClientRect();
  const maxTop = scroller.scrollHeight - scroller.clientHeight;
  const endTop = Math.max(0, Math.min(maxTop, startTop + sectionRect.top - scrollerRect.top));
  const startedAt = performance.now();
  const durationMs = 850;

  const step = (now: number) => {
    const progress = Math.min(1, (now - startedAt) / durationMs);
    const easedProgress = progress < 0.5 ? 4 * progress ** 3 : 1 - (-2 * progress + 2) ** 3 / 2;
    scroller.scrollTop = startTop + (endTop - startTop) * easedProgress;

    if (progress < 1) {
      scrollAnimationFrame = requestAnimationFrame(step);
      return;
    }

    scrollAnimationFrame = undefined;
    onComplete?.();
  };

  scrollAnimationFrame = requestAnimationFrame(step);
}

function findScrollParent(el: HTMLElement): HTMLElement | undefined {
  let parent = el.parentElement;
  while (parent) {
    const overflowY = getComputedStyle(parent).overflowY;
    if ((overflowY === 'auto' || overflowY === 'scroll') && parent.scrollHeight > parent.clientHeight) {
      return parent;
    }
    parent = parent.parentElement;
  }
}

Vue.onUnmounted(() => {
  if (scrollAnimationFrame) {
    cancelAnimationFrame(scrollAnimationFrame);
  }
});
</script>
