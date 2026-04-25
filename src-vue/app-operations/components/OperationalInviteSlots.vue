<template>
  <div :class="mode === 'menu' ? 'space-y-2' : 'space-y-3'">
    <Tooltip
      v-for="slot in slots"
      :key="`${mode}:${slot.number}:${slot.type}:${slotKey(slot)}`"
      asChild
      :side="mode === 'menu' ? 'left' : 'top'"
      :content="slotTooltip(slot)">
      <component
        :is="mode === 'menu' ? 'button' : 'div'"
        :type="mode === 'menu' ? 'button' : undefined"
        class="reward-slot group relative w-full overflow-hidden rounded-2xl border border-slate-200 bg-white/95 text-left shadow-[0_1px_0_rgba(15,23,42,0.03)]"
        :class="
          mode === 'menu'
            ? 'cursor-pointer py-2.5 pr-3 pl-3 transition hover:border-slate-300 hover:bg-white'
            : 'py-3 pr-4 pl-3'
        "
        @click="selectSlot(slot)">
        <div
          class="absolute inset-y-2 left-0 w-1 rounded-r-full"
          :class="{
            'bg-amber-400': slot.type === 'sent',
            'bg-argon-500': slot.type === 'ready',
            'bg-slate-300': slot.type === 'progress',
          }" />

        <div
          :class="[
            'flex',
            mode === 'menu' ? 'gap-3' : 'gap-4',
            slot.type === 'progress' ? 'items-stretch' : 'items-center',
          ]">
          <div
            class="flex w-[4.3rem] shrink-0 items-center justify-center border-r border-dashed border-slate-300/80 pr-3">
            <div
              class="flex items-center justify-center rounded-full border border-slate-300 bg-white font-mono font-bold text-slate-600"
              :class="mode === 'menu' ? 'h-9 w-9 text-base' : 'h-10 w-10 text-lg'">
              {{ slot.number }}
            </div>
          </div>

          <div class="min-w-0 grow" :class="slot.type === 'progress' ? 'py-0.5' : ''">
            <template v-if="slot.type === 'sent'">
              <div class="flex items-center justify-between gap-3">
                <div
                  class="truncate font-bold text-slate-800"
                  :class="mode === 'menu' ? 'text-sm leading-5' : 'text-base leading-5'">
                  {{ sentInviteName(slot) }}
                </div>
                <div
                  class="shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold"
                  :class="statusClass(slot.status.label)">
                  {{ slot.status.label }}
                </div>
              </div>
            </template>

            <template v-else-if="slot.type === 'ready'">
              <div
                class="truncate font-bold text-slate-800"
                :class="mode === 'menu' ? 'text-sm leading-5' : 'text-base leading-5'">
                {{ readySlotName(slot) }}
              </div>
            </template>

            <template v-else>
              <div class="flex items-center justify-between gap-3">
                <div
                  class="truncate font-bold text-slate-800"
                  :class="mode === 'menu' ? 'text-sm leading-5' : 'text-base leading-5'">
                  Progress to Earning Referral Code
                </div>
                <div class="shrink-0 font-mono text-xs font-bold text-slate-500">
                  {{ slot.progressLabel }}
                </div>
              </div>

              <div class="mt-2 h-1.5 rounded-full bg-slate-200/90">
                <div
                  class="h-full rounded-full bg-slate-500/70 transition-all"
                  :style="{ width: `${slot.progressPct}%` }" />
              </div>
            </template>
          </div>

          <template v-if="mode === 'overlay' && slot.type === 'ready'">
            <div class="w-[16rem] shrink-0" @click.stop>
              <div class="flex items-center gap-2">
                <input
                  :value="draftNamesBySlot[slot.number] ?? ''"
                  data-invite-name-input
                  type="text"
                  placeholder="Invite name"
                  class="focus:border-argon-600 min-w-0 grow rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm focus:ring-0"
                  @input="updateDraftName(slot.number, $event)"
                  @keyup.enter="createInvite(slot.number)" />
                <button
                  type="button"
                  :disabled="isCreating || !hasInviteName(slot.number)"
                  class="bg-argon-button hover:bg-argon-button-hover flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-white disabled:cursor-default disabled:opacity-40"
                  aria-label="Create invite"
                  @click="createInvite(slot.number)">
                  <PlusIcon class="h-4 w-4 stroke-[2.5]" />
                </button>
              </div>
            </div>
          </template>

          <template v-else-if="mode === 'overlay' && slot.type === 'sent'">
            <CopyToClipboard v-if="slot.inviteLink" :content="slot.inviteLink" class="shrink-0" @click.stop>
              <button type="button" class="text-argon-700 text-sm font-semibold">Copy link</button>
              <template #copied>
                <button type="button" class="text-argon-700 text-sm font-semibold">Copied</button>
              </template>
            </CopyToClipboard>
            <button v-else type="button" disabled class="shrink-0 text-sm font-semibold text-slate-400">
              Link unavailable
            </button>
          </template>

          <ChevronRightIcon
            v-if="mode === 'menu'"
            class="h-4 w-4 shrink-0 text-slate-300 transition group-hover:text-slate-500" />
        </div>
      </component>
    </Tooltip>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import type { IOperationalUserInvite } from '@argonprotocol/apps-router';
import { ChevronRightIcon, PlusIcon } from '@heroicons/vue/24/outline';
import CopyToClipboard from '../../components/CopyToClipboard.vue';
import Tooltip from '../../components/Tooltip.vue';
import type { IOperationalChainProgress, IOperationalRewardConfig } from '../../lib/OperationalAccount.ts';
import { getCappedPercent } from '../../lib/Utils.ts';

type IInviteSlotSection = 'create' | 'unlock' | 'outbound';

type IInviteRecordStatus = {
  label: string;
};

type IInviteRecord = Pick<IOperationalUserInvite, 'inviteCode' | 'name' | 'lastClickedAt'>;

type IInviteSlot =
  | {
      type: 'sent';
      number: number;
      invite?: IInviteRecord;
      status: IInviteRecordStatus;
      inviteLink?: string;
    }
  | {
      type: 'ready';
      number: number;
    }
  | {
      type: 'progress';
      number: number;
      progressLabel: string;
      progressPct: number;
    };

const props = withDefaults(
  defineProps<{
    mode: 'menu' | 'overlay';
    progress: IOperationalChainProgress;
    rewardConfig: IOperationalRewardConfig;
    invites: IInviteRecord[];
    inviteStatusesByCode?: Record<string, IInviteRecordStatus>;
    inviteLinksByCode?: Record<string, string>;
    draftNamesBySlot?: Record<number, string>;
    isCreating?: boolean;
  }>(),
  {
    inviteStatusesByCode: () => ({}),
    inviteLinksByCode: () => ({}),
    draftNamesBySlot: () => ({}),
    isCreating: false,
  },
);

const emit = defineEmits<{
  create: [{ slotNumber: number; name: string }];
  select: [IInviteSlotSection];
  'update:draftNamesBySlot': [Record<number, string>];
}>();

const slots = Vue.computed(() => {
  return buildSlots();
});

function selectSlot(slot: IInviteSlot) {
  if (props.mode !== 'menu') return;
  emit('select', slotSection(slot));
}

function updateDraftName(slotNumber: number, event: Event) {
  const input = event.target as HTMLInputElement;
  emit('update:draftNamesBySlot', {
    ...props.draftNamesBySlot,
    [slotNumber]: input.value,
  });
}

function createInvite(slotNumber: number) {
  if (!hasInviteName(slotNumber)) return;

  emit('create', {
    slotNumber,
    name: props.draftNamesBySlot[slotNumber]?.trim() ?? '',
  });
}

function sentInviteName(slot: Extract<IInviteSlot, { type: 'sent' }>) {
  return slot.invite?.name.trim() || 'Sent';
}

function readySlotName(slot: Extract<IInviteSlot, { type: 'ready' }>) {
  return props.draftNamesBySlot[slot.number]?.trim() || 'Ready to Send';
}

function hasInviteName(slotNumber: number) {
  return !!props.draftNamesBySlot[slotNumber]?.trim();
}

function slotKey(slot: IInviteSlot) {
  if (slot.type === 'sent') return slot.invite?.inviteCode ?? 'sent';
  if (slot.type === 'progress') return slot.progressLabel;
  return 'ready';
}

function slotSection(slot: IInviteSlot): IInviteSlotSection {
  if (slot.type === 'sent') return 'outbound';
  if (slot.type === 'ready') return 'create';
  return 'unlock';
}

function slotTooltip(slot: IInviteSlot) {
  if (slot.type === 'ready') {
    return "You've earned a referral code! Click to create an invite and share it with your friends.";
  }
  if (slot.type === 'progress') {
    return 'You can earn another referral code by adding more BTC lock, winning more mining seats, or successful referrals.';
  }
  if (slot.invite?.lastClickedAt) {
    return `${slot.invite.name} has opened this referral code. It no longer counts as waiting to be activated.`;
  }

  return `This referral code is waiting for ${sentInviteName(slot) === 'Sent' ? 'the recruit' : sentInviteName(slot)} to open the link.`;
}

function statusClass(label: string) {
  if (label === 'Activated') return 'border border-amber-200 bg-amber-50 text-amber-700';
  if (label === 'Became operational') return 'border border-emerald-200 bg-emerald-50 text-emerald-700';
  if (label === 'Expired') return 'border border-slate-200 bg-slate-100 text-slate-500';
  return 'border border-slate-200 bg-slate-100 text-slate-600';
}

function buildSlots(): IInviteSlot[] {
  const slotCount = Math.min(props.rewardConfig.maxAvailableReferrals, 3);
  const slots: IInviteSlot[] = [];
  const sentInvites = props.invites.filter(isActiveInvite).slice(0, slotCount);
  const sentSlotCount = Math.min(Math.max(props.progress.unactivatedReferrals, sentInvites.length), slotCount);

  for (let i = 0; i < sentSlotCount; i += 1) {
    const invite = sentInvites[i];
    const inviteStatus = getInviteStatus(invite);

    slots.push({
      type: 'sent',
      number: slots.length + 1,
      invite,
      status: inviteStatus,
      inviteLink: invite ? props.inviteLinksByCode[invite.inviteCode] : undefined,
    });
  }

  const readySlotCount = Math.min(props.progress.availableReferrals, slotCount - slots.length);
  for (let i = 0; i < readySlotCount; i += 1) {
    slots.push({
      type: 'ready',
      number: slots.length + 1,
    });
  }

  const progressSources = [
    getProgressSource(props.progress.bitcoinAccrual, props.rewardConfig.bitcoinLockSizeForReferral),
    getProgressSource(props.progress.miningSeatAccrual, props.rewardConfig.miningSeatsPerReferral),
    getProgressSource(props.progress.referralPending ? 1 : 0, 1),
  ].sort((a, b) => b.progressPct - a.progressPct);

  while (slots.length < slotCount) {
    const source = progressSources.shift();
    if (!source) break;

    slots.push({
      type: 'progress',
      number: slots.length + 1,
      progressLabel: source.progressLabel,
      progressPct: source.progressPct,
    });
  }

  return slots;
}

function getProgressSource(current: bigint | number, target: bigint | number) {
  const progressPct = getCappedPercent(current, target);

  return {
    progressLabel: progressPct >= 100 ? 'ready' : `${progressPct}%`,
    progressPct,
  };
}

function getInviteStatus(invite?: Pick<IOperationalUserInvite, 'inviteCode' | 'lastClickedAt'>): IInviteRecordStatus {
  if (!invite) {
    return {
      label: 'Not activated',
    };
  }

  const status = props.inviteStatusesByCode[invite.inviteCode];
  if (status) return status;

  if (invite.lastClickedAt) {
    return {
      label: 'Activated',
    };
  }

  return {
    label: 'Not activated',
  };
}

function isActiveInvite(invite: Pick<IOperationalUserInvite, 'inviteCode' | 'lastClickedAt'>) {
  const status = props.inviteStatusesByCode[invite.inviteCode]?.label;
  if (status) return status === 'Not activated';
  return !invite.lastClickedAt;
}
</script>

<style scoped>
@reference "../../main.css";

.reward-slot::before,
.reward-slot::after {
  content: '';
  position: absolute;
  left: 5.05rem;
  z-index: 1;
  height: 12px;
  width: 12px;
  transform: translateX(-50%);
  border: 1px solid rgb(226 232 240);
  border-radius: 9999px;
  background: var(--color-argon-menu-bg, white);
}

.reward-slot::before {
  top: -7px;
}

.reward-slot::after {
  bottom: -7px;
}
</style>
