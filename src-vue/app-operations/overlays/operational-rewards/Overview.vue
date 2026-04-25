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
    <div v-if="errorMessage || infoMessage" class="mt-5 space-y-3">
      <div v-if="errorMessage" class="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
        {{ errorMessage }}
      </div>
      <div
        v-if="infoMessage"
        class="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
        {{ infoMessage }}
      </div>
    </div>

    <section ref="createSectionRef" class="mt-6 bg-white px-2">
      <div class="mt-5">
        <div StatsBox box class="mt-3 grid grid-cols-3 overflow-hidden text-center">
          <Tooltip v-for="stat in referralStats" :key="stat.label" asChild side="top" :content="stat.tooltip">
            <div StatWrapper class="border-r border-slate-200/70 px-4 py-4 last:border-r-0">
              <div Stat class="text-4xl! leading-none">{{ stat.value }}</div>
              <div class="mt-2 text-xs font-semibold tracking-widest text-slate-400 uppercase">
                {{ stat.label }}
              </div>
            </div>
          </Tooltip>
        </div>
        <div
          v-if="hasUnclaimedRewards"
          class="mt-5 flex items-center justify-between gap-4 text-sm leading-6 text-slate-500">
          <div class="min-w-0">
            You have
            <span class="font-semibold text-slate-700">{{ pendingRewardLabel }}</span>
            ready to claim in the Argon Treasury.
          </div>
          <button
            type="button"
            class="text-argon-700 bg-argon-600/5 hover:bg-argon-600/10 shrink-0 rounded-md px-3 py-1.5 text-sm font-semibold"
            @click="emit('goTo', 'claim')">
            Claim {{ pendingRewardLabel }}
          </button>
        </div>

        <div v-else class="text-md mt-5 text-slate-500">
          You can earn up to {{ operationalReferralRewardLabel }} from the Argon Treasury when you refer operators who
          achieve fully operational status. Every
          {{ controller.rewardConfig.referralBonusEveryXOperationalSponsees }} referred operators can trigger up to a
          {{ referralBonusRewardLabel }} bonus.
        </div>
      </div>

      <div class="mt-5 flex items-center justify-between gap-4 border-t border-slate-300 pt-5">
        <div class="text-lg font-semibold text-slate-800">Referral Codes</div>
        <div class="text-sm text-slate-500">
          {{ controller.inviteSlotProgress.unactivatedReferrals }} /
          {{ controller.rewardConfig.maxAvailableReferrals }} in flight
        </div>
      </div>

      <div class="pt-2 text-sm text-slate-500">
        When you create a referral code, you'll be given a personalized link that will bind a recruit to your account.
        Send it to a recruit any way you like.
      </div>

      <OperationalInviteSlots
        v-model:draftNamesBySlot="inviteNamesBySlot"
        class="mt-4"
        mode="overlay"
        :progress="controller.inviteSlotProgress"
        :rewardConfig="controller.rewardConfig"
        :invites="controller.operationalInvites"
        :inviteStatusesByCode="inviteStatusesByCode"
        :inviteLinksByCode="inviteLinksByCode"
        :isCreating="isCreatingInvite"
        @create="createInvite" />
    </section>

    <section ref="unlockSectionRef" class="mt-5 border-t border-slate-200/70 px-2 pt-4">
      <div class="text-sm font-semibold tracking-widest text-slate-400 uppercase">
        Progress Towards Your Next Referral Code
      </div>

      <div class="mt-3 grid gap-2">
        <div
          v-for="card in progressCards"
          :key="card.title"
          class="rounded-xl border border-slate-200/70 bg-slate-50/40 px-3 py-3">
          <div class="flex items-start justify-between gap-3">
            <div class="text-sm font-semibold text-slate-800">{{ card.title }}</div>
            <div class="text-argon-700/80 font-mono text-xs font-semibold">{{ card.value }}</div>
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
        class="mt-5 rounded-2xl border border-dashed border-slate-300 px-4 py-8 text-center text-sm text-slate-500">
        No completed referral history yet. Older referral codes will appear here after they are opened, expire, or
        become operational.
      </div>

      <div v-else class="mt-5 space-y-3">
        <Tooltip
          v-for="invite in historicalInvites"
          :key="invite.id"
          asChild
          side="top"
          :content="inviteHistoryTooltip(invite)">
          <div
            class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 rounded-xl border border-slate-200/70 bg-slate-50/40 px-3 py-3 transition hover:border-slate-300 hover:bg-white">
            <div class="min-w-0">
              <div class="font-semibold text-slate-800">{{ invite.name }}</div>
              <div class="mt-1 text-sm text-slate-500">{{ inviteHistorySummary(invite) }}</div>
              <div v-if="inviteStatus(invite).showRewardNote" class="mt-2 text-sm font-medium text-emerald-700">
                Both accounts earned claimable rewards.
              </div>
            </div>

            <div
              class="justify-self-end rounded-full px-3 py-1 text-xs font-semibold"
              :class="inviteStatus(invite).classes">
              {{ inviteStatus(invite).label }}
            </div>
          </div>
        </Tooltip>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import type { IOperationalUserInvite } from '@argonprotocol/apps-router';
import { InviteCodes, MICROGONS_PER_ARGON, NetworkConfig, UserRole } from '@argonprotocol/apps-core';
import Tooltip from '../../../components/Tooltip.vue';
import OperationalInviteSlots from '../../components/OperationalInviteSlots.vue';
import basicEmitter from '../../../emitters/basicEmitter.ts';
import { getConfig } from '../../../stores/config.ts';
import { getMyVault } from '../../../stores/vaults.ts';
import { InviteEnvelope } from '../../../lib/InviteEnvelope.ts';
import { useOperationsController } from '../../../stores/operationsController.ts';
import { createNumeralHelpers } from '../../../lib/numeral.ts';
import { getCurrency } from '../../../stores/currency.ts';
import { getMainchainClient } from '../../../stores/mainchain.ts';
import { getServerApiClient } from '../../../stores/server.ts';
import { getWalletKeys } from '../../../stores/wallets.ts';
import { clampProgressValue, getCappedPercent } from '../../../lib/Utils.ts';
import { signReferralSponsorGrant } from '../../../lib/OperationalAccount.ts';
import { UpstreamOperatorClient } from '../../../lib/UpstreamOperatorClient.ts';

type OperationalRewardsSection = 'create' | 'unlock' | 'outbound';
type IInviteStatus = {
  label: 'Not activated' | 'Activated' | 'Became operational' | 'Expired';
  classes: string;
  showRewardNote: boolean;
};

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
const invites = Vue.ref<IOperationalUserInvite[]>([]);
const inviteEnvelopesByInviteCode = Vue.ref<Record<string, string>>({});
const inviteStatusesByCode = Vue.ref<Record<string, IInviteStatus>>({});

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

const operationalReferralRewardLabel = Vue.computed(() => {
  return formatArgon(controller.rewardConfig.operationalReferralReward);
});

const referralBonusRewardLabel = Vue.computed(() => {
  return formatArgon(controller.rewardConfig.referralBonusReward);
});

const earnedReferralRewardLabel = Vue.computed(() => {
  return formatArgon(controller.inviteSlotProgress.rewardsEarnedAmount);
});

const claimedReferralRewardLabel = Vue.computed(() => {
  return formatArgon(controller.inviteSlotProgress.rewardsCollectedAmount);
});

const pendingRewardLabel = Vue.computed(() => {
  return formatArgon(controller.pendingRewardsAmount);
});

const hasUnclaimedRewards = Vue.computed(() => {
  return controller.pendingRewardsAmount > 0n;
});

const referralBonusProgressLabel = Vue.computed(() => {
  const bonusEvery = Math.max(controller.rewardConfig.referralBonusEveryXOperationalSponsees, 1);
  return `${controller.inviteSlotProgress.operationalReferralsCount % bonusEvery}/${bonusEvery}`;
});

const referralStats = Vue.computed(() => {
  return [
    {
      label: 'Earned',
      value: earnedReferralRewardLabel.value,
      tooltip: `${claimedReferralRewardLabel.value} has been claimed. ${pendingRewardLabel.value} is unclaimed.`,
    },
    {
      label: 'Next Bonus',
      value: referralBonusRewardLabel.value,
      tooltip: `Every ${controller.rewardConfig.referralBonusEveryXOperationalSponsees} referred operators earns this bonus.`,
    },
    {
      label: 'Bonus Progress',
      value: referralBonusProgressLabel.value,
      tooltip: 'Your progress toward the next referral bonus.',
    },
  ];
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
      value: `${formatArgon(clampProgressValue(btcCurrent, btcTarget))} / ${formatArgon(btcTarget)}`,
      copy:
        btcCurrent >= btcTarget
          ? 'Another referral code is ready from BTC lock progress.'
          : 'Lock another ₳5,000 worth of BTC',
      progressPct: getCappedPercent(btcCurrent, btcTarget),
    },
    {
      title: 'Mining seat progress',
      value: `${clampProgressValue(miningCurrent, miningTarget)} / ${miningTarget}`,
      copy:
        miningCurrent >= miningTarget
          ? 'Another referral code is ready from mining seats.'
          : `Win ${miningTarget} more mining seats`,
      progressPct: getCappedPercent(miningCurrent, miningTarget),
    },
    {
      title: 'Referral progress',
      value: `${referralCurrent} / 1`,
      copy: controller.inviteSlotProgress.referralPending
        ? 'Another referral code is ready from referrals.'
        : 'Get 1 more account fully operational',
      progressPct: getCappedPercent(referralCurrent, 1),
    },
  ];
});

const inviteLinksByCode = Vue.computed(() => {
  return Object.fromEntries(
    Object.entries(inviteEnvelopesByInviteCode.value).map(([inviteCode, inviteEnvelope]) => [
      inviteCode,
      `${NetworkConfig.get().websiteHost}/operational-invite/${inviteEnvelope}`,
    ]),
  );
});

const historicalInvites = Vue.computed(() => {
  return invites.value.filter(invite => !isActiveInvite(invite));
});

function updateProfileOverlay() {
  basicEmitter.emit('openProfileOverlay');
}

function openServerOverlay() {
  basicEmitter.emit('openServerOverlay');
}

function inviteStatus(invite: IOperationalUserInvite): IInviteStatus {
  return (
    inviteStatusesByCode.value[invite.inviteCode] ?? {
      label: 'Not activated',
      classes: 'border border-slate-200 bg-slate-100 text-slate-600',
      showRewardNote: false,
    }
  );
}

function inviteHistorySummary(invite: IOperationalUserInvite) {
  if (invite.accountId) return `Claimed by ${shortInviteCode(invite.accountId)}`;
  if (invite.lastClickedAt) return 'Invite link opened';
  return `Issued as ${shortInviteCode(invite.inviteCode)}`;
}

function inviteHistoryTooltip(invite: IOperationalUserInvite) {
  const status = inviteStatus(invite).label;
  if (status === 'Became operational')
    return `${invite.name} became fully operational, so referral rewards can become claimable.`;
  if (status === 'Activated')
    return `${invite.name} opened the referral link and this code is no longer waiting in an active slot.`;
  if (status === 'Expired') return `${invite.name}'s referral code is no longer active.`;
  return `${invite.name}'s referral record is kept here for history.`;
}

function isActiveInvite(invite: IOperationalUserInvite) {
  return inviteStatus(invite).label === 'Not activated';
}

async function loadInvites() {
  errorMessage.value = null;
  if (!config.serverDetails.ipAddress) {
    invites.value = [];
    controller.setOperationalInvites([]);
    inviteStatusesByCode.value = {};
    return;
  }

  try {
    const nextInvites = await controller.loadOperationalInvites();
    invites.value = nextInvites;

    await loadInviteStatuses(nextInvites);
  } catch {
    invites.value = [];
    controller.setOperationalInvites([]);
    inviteStatusesByCode.value = {};
    errorMessage.value = 'Unable to load referral codes right now. Please try again.';
  }
}

async function loadInviteStatuses(nextInvites: IOperationalUserInvite[]) {
  if (!nextInvites.length) {
    inviteStatusesByCode.value = {};
    return;
  }

  const client = await getMainchainClient(false);

  const accountInvites = nextInvites.filter(invite => invite.accountId);
  const operationalAccounts = accountInvites.length
    ? await client.query.operationalAccounts.operationalAccounts.multi(accountInvites.map(invite => invite.accountId!))
    : [];

  const operationalInviteCodes = new Set(
    accountInvites
      .filter(
        (_invite, index) =>
          operationalAccounts[index].isSome && operationalAccounts[index].unwrap().isOperational.toPrimitive(),
      )
      .map(invite => invite.inviteCode),
  );

  const entries = nextInvites.map(invite => {
    if (operationalInviteCodes.has(invite.inviteCode)) {
      return [
        invite.inviteCode,
        {
          label: 'Became operational',
          classes: 'border border-emerald-200 bg-emerald-50 text-emerald-700',
          showRewardNote: true,
        },
      ] as const;
    }

    if (invite.lastClickedAt) {
      return [
        invite.inviteCode,
        {
          label: 'Activated',
          classes: 'border border-amber-200 bg-amber-50 text-amber-700',
          showRewardNote: false,
        },
      ] as const;
    }

    return [
      invite.inviteCode,
      {
        label: 'Not activated',
        classes: 'border border-slate-200 bg-slate-100 text-slate-600',
        showRewardNote: false,
      },
    ] as const;
  });

  inviteStatusesByCode.value = Object.fromEntries(entries);
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

    const invite = await serverApiClient.createOperationalInvite({
      name,
      fromName,
      inviteCode,
      ...operationalReferral,
    });

    const nextInvites = [invite, ...invites.value.filter(x => x.id !== invite.id)];

    invites.value = nextInvites;
    controller.setOperationalInvites(nextInvites);

    inviteEnvelopesByInviteCode.value = {
      ...inviteEnvelopesByInviteCode.value,
      [invite.inviteCode]: inviteEnvelope,
    };

    await navigator.clipboard
      .writeText(`${NetworkConfig.get().websiteHost}/operational-invite/${inviteEnvelope}`)
      .catch(() => undefined);

    infoMessage.value = 'Invite link copied. Save it now, since the full invite link is only available at creation.';
    inviteNamesBySlot.value[slotNumber] = '';

    await loadInvites();
  } catch (error: any) {
    errorMessage.value = error?.message ?? 'Unable to create invite.';
  } finally {
    isCreatingInvite.value = false;
  }
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

function formatArgon(amount: bigint) {
  const wholeArgon = BigInt(MICROGONS_PER_ARGON);
  return `₳${microgonToArgonNm(amount).format(amount % wholeArgon === 0n ? '0,0' : '0,0.00')}`;
}

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
