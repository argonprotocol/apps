<template>
  <div class="flex h-full flex-col">
    <div class="flex items-start justify-between gap-4">
      <div>
        <div class="text-xl font-bold text-slate-800">Member Invites</div>
        <p class="mt-1 text-sm leading-5 text-slate-500">
          Invite people into your vault, track their certification progress, and approve operations access when they are
          ready.
        </p>
      </div>
    </div>

    <div class="flex min-h-0 grow flex-col">
      <div class="mt-4 min-h-0 grow overflow-auto">
        <table class="w-full min-w-[760px] text-left">
          <thead
            class="sticky top-0 z-10 border-b border-slate-200 bg-white text-xs font-semibold tracking-wide text-slate-400 uppercase"
          >
            <tr>
              <th class="px-5 py-3">Invitee</th>
              <th class="px-5 py-3">Status</th>
              <th class="px-5 py-3">Certification</th>
              <th class="px-5 py-3">Details</th>
              <th class="w-10 px-3 py-3"><span class="sr-only">Open</span></th>
            </tr>
          </thead>

          <tbody>
            <tr
              v-for="invite in controller.operationalInvites"
              :key="invite.id"
              class="cursor-pointer border-b border-slate-100 bg-white align-middle last:border-0 hover:bg-slate-50"
              @click="basicEmitter.emit('openMemberDetailsOverlay', { invite })"
            >
              <td class="px-5 py-4">
                <div class="max-w-72 truncate text-sm font-semibold text-slate-800">{{ invite.name }}</div>
                <div class="mt-0.5 text-xs text-slate-400">
                  Created {{ dayjs.utc(invite.createdAt).local().fromNow() }}
                </div>
              </td>

              <td class="px-5 py-4">
                <span
                  v-if="
                    inviteStatus(invite).label === 'Upgrade requested' ||
                    inviteStatus(invite).label === 'Operations access granted' ||
                    inviteStatus(invite).label === 'Operationally certified'
                  "
                  class="bg-argon-50 text-argon-600 inline-flex rounded-full px-2.5 py-1 text-xs font-semibold whitespace-nowrap"
                >
                  {{ inviteStatus(invite).label }}
                </span>
                <span
                  v-else
                  class="inline-flex rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold whitespace-nowrap text-slate-500"
                >
                  {{ inviteStatus(invite).label }}
                </span>
              </td>

              <td class="px-5 py-4 font-mono text-sm font-semibold whitespace-nowrap text-slate-700">
                <template v-if="invite.certificationProgress">
                  {{ completedCertificationRequirementCount(invite) }} of
                  {{ certificationRequirementCount(invite) }} complete
                </template>
                <template v-else>-</template>
              </td>

              <td class="px-5 py-4 whitespace-nowrap">
                <div v-if="invite.vaultContribution" class="text-sm whitespace-nowrap text-slate-600">
                  <span class="font-mono">
                    <template v-if="(invite.vaultContribution.bitcoinAmount ?? 0n) > 0n">
                      {{ currency.symbol
                      }}{{ microgonToMoneyNm(invite.vaultContribution.bitcoinAmount).format('0,0.00') }}
                    </template>
                    <template v-else>
                      {{ currency.symbol
                      }}{{ microgonToMoneyNm(invite.vaultContribution.pendingBitcoinAmount ?? 0n).format('0,0.00') }}
                    </template>
                  </span>
                  <span class="ml-1 text-xs text-slate-400">Bitcoin</span>
                  <span
                    v-if="
                      (invite.vaultContribution.bitcoinAmount ?? 0n) > 0n &&
                      (invite.vaultContribution.pendingBitcoinAmount ?? 0n) > 0n
                    "
                    class="ml-1 text-xs text-slate-400"
                  >
                    ({{ currency.symbol
                    }}{{ microgonToMoneyNm(invite.vaultContribution.pendingBitcoinAmount ?? 0n).format('0,0.00') }}
                    awaiting funding)
                  </span>
                  <span
                    v-else-if="(invite.vaultContribution.pendingBitcoinAmount ?? 0n) > 0n"
                    class="ml-1 text-xs text-slate-400"
                  >
                    (awaiting funding)
                  </span>
                  <span class="mx-2 text-slate-300">·</span>
                  <span class="font-mono">
                    {{ currency.symbol
                    }}{{ microgonToMoneyNm(invite.vaultContribution?.bondAmount ?? 0n).format('0,0.00') }}
                  </span>
                  <span class="ml-1 text-xs text-slate-400">Bonds</span>
                </div>
              </td>

              <td class="px-3 py-4 text-right">
                <button
                  type="button"
                  :aria-label="`Open details for ${invite.name}`"
                  @click.stop="basicEmitter.emit('openMemberDetailsOverlay', { invite })"
                >
                  <ChevronRightIcon class="inline size-5 text-slate-300" />
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { IMemberInvite } from '@argonprotocol/apps-router';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import utc from 'dayjs/plugin/utc';
import { ChevronRightIcon } from '@heroicons/vue/24/outline';
import {
  countCompletedOperationalCertificationRequirements,
  countCompletedTreasuryCertificationRequirements,
  operationalCertificationRequirementCount,
  treasuryCertificationRequirementCount,
} from '@argonprotocol/apps-core';
import basicEmitter from '../../../emitters/basicEmitter.ts';
import { createNumeralHelpers } from '../../../lib/numeral.ts';
import { getCurrency } from '../../../stores/currency.ts';
import { useCertificationController } from '../../../stores/certificationController.ts';

dayjs.extend(relativeTime);
dayjs.extend(utc);

const controller = useCertificationController();
const currency = getCurrency();

const { microgonToMoneyNm } = createNumeralHelpers(currency);
function inviteStatus(invite: IMemberInvite) {
  return (
    controller.operationalInviteStatusesByCode[invite.inviteCode] ?? {
      label: 'Not opened',
      showRewardNote: false,
    }
  );
}

function showOperationsCertification(invite: IMemberInvite) {
  return !!(
    invite.operationsUpgradeRequestedAt ||
    invite.accessProof ||
    invite.operationsUpgradedAt ||
    invite.certificationProgress?.hasOperationalAccount
  );
}

function completedCertificationRequirementCount(invite: IMemberInvite) {
  const progress = invite.certificationProgress!;

  return (
    countCompletedTreasuryCertificationRequirements(progress) +
    (showOperationsCertification(invite) ? countCompletedOperationalCertificationRequirements(progress) : 0)
  );
}

function certificationRequirementCount(invite: IMemberInvite) {
  return (
    treasuryCertificationRequirementCount +
    (showOperationsCertification(invite) ? operationalCertificationRequirementCount : 0)
  );
}
</script>
