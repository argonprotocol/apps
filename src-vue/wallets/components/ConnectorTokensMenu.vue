<template>
  <DropdownMenuRoot v-model:open="isOpen">
    <DropdownMenuTrigger asChild :disabled="props.disabled">
      <slot :isOpen="isOpen" />
    </DropdownMenuTrigger>
    <DropdownMenuPortal>
      <DropdownMenuContent
        :data-wallet-connector-id="props.connectorId"
        side="bottom"
        align="end"
        :alignOffset="-5"
        :sideOffset="-3"
        :collisionPadding="30"
        :style="floatingZIndex"
        class="data-[side=bottom]:animate-slideUpAndFade data-[side=right]:animate-slideLeftAndFade data-[side=left]:animate-slideRightAndFade data-[side=top]:animate-slideDownAndFade data-[state=open]:transition-all"
        @closeAutoFocus="$event.preventDefault()"
      >
        <div
          class="bg-argon-menu-bg flex w-72 flex-col rounded p-1 text-sm/6 text-gray-900 shadow-lg ring-1 ring-gray-900/20"
        >
          <DropdownMenuItem
            class="hover:bg-argon-menu-hover focus:bg-argon-menu-hover flex cursor-pointer items-center gap-x-2 rounded px-3 py-2 focus:outline-none"
            @select="selectToken(MoveToken.ARGN)"
          >
            <ArgonIcon class="h-6 w-6" />
            <div class="grow">{{ microgonToArgonNm(props.microgons).format('0,0.[00]') }} ARGN</div>
            <div>{{ currency.symbol }}{{ microgonToMoneyNm(props.microgons).format('0,0.00') }}</div>
          </DropdownMenuItem>
          <DropdownMenuItem
            class="hover:bg-argon-menu-hover focus:bg-argon-menu-hover flex cursor-pointer items-center gap-x-2 rounded px-3 py-2 focus:outline-none"
            @select="selectToken(MoveToken.ARGNOT)"
          >
            <ArgonotIcon class="h-6 w-6" />
            <div class="grow">{{ micronotToArgonotNm(props.micronots).format('0,0.[00]') }} ARGNOT</div>
            <div>{{ currency.symbol }}{{ micronotToMoneyNm(props.micronots).format('0,0.00') }}</div>
          </DropdownMenuItem>
        </div>
        <DropdownMenuArrow :width="22" :height="12" class="fill-white stroke-gray-300" />
      </DropdownMenuContent>
    </DropdownMenuPortal>
  </DropdownMenuRoot>
</template>

<script setup lang="ts">
import { MoveToken } from '@argonprotocol/apps-core';
import * as Vue from 'vue';
import {
  DropdownMenuArrow,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuRoot,
  DropdownMenuTrigger,
} from 'reka-ui';
import ArgonIcon from '../../assets/resources/argon.svg';
import ArgonotIcon from '../../assets/resources/argonot.svg';
import { createNumeralHelpers } from '../../lib/numeral.ts';
import { useFloatingZIndex } from '../../overlays/helpers/OverlayZIndex.ts';
import { getCurrency } from '../../stores/currency.ts';

const props = withDefaults(
  defineProps<{
    connectorId?: string;
    microgons?: bigint;
    micronots?: bigint;
    disabled?: boolean;
  }>(),
  {
    microgons: () => 0n,
    micronots: () => 0n,
  },
);

const emit = defineEmits<{
  (event: 'selectToken', token: MoveToken.ARGN | MoveToken.ARGNOT): void;
}>();

const currency = getCurrency();
const floatingZIndex = useFloatingZIndex(2);
const isOpen = Vue.ref(false);
let pendingToken: MoveToken.ARGN | MoveToken.ARGNOT | undefined;

const { microgonToArgonNm, microgonToMoneyNm, micronotToArgonotNm, micronotToMoneyNm } = createNumeralHelpers(currency);

function selectToken(moveToken: MoveToken.ARGN | MoveToken.ARGNOT) {
  pendingToken = moveToken;
}

Vue.watch(isOpen, async open => {
  if (open || !pendingToken) return;

  const moveToken = pendingToken;
  pendingToken = undefined;
  await Vue.nextTick();
  emit('selectToken', moveToken);
});
</script>
