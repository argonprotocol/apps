<!-- prettier-ignore -->
<template>
  <p class="text-md mb-3">
    These goals are used to guide your bot's bidding strategy. In the world of Argon, frames are equivalent to a day, and epochs are equivalent to ten days.
  </p>

  <label class="mt-3 font-bold opacity-60 mb-0.5">
    Quantity to Win
  </label>
  <div class="flex flex-row items-center gap-2 w-full">
    <InputMenu v-model="config.biddingRules.seatGoalType" :options="[
        { name: `Min`, value: SeatGoalType.Min },
        { name: 'Min Percent', value: SeatGoalType.MinPercent },
        { name: `Max`, value: SeatGoalType.Max },
        { name: `Max Percent`, value: SeatGoalType.MaxPercent }
      ]" :selectFirst="true" />
    <template v-if="config.biddingRules.seatGoalType === SeatGoalType.MaxPercent || config.biddingRules.seatGoalType === SeatGoalType.MinPercent">
    <InputNumber  v-model="config.biddingRules.seatGoalPercent" :min="0" :max="100" suffix="% of Seats" :dragBy="1" class="w-1/2 whitespace-nowrap" />
    </template>
    <template v-else >
    <InputNumber v-model="config.biddingRules.seatGoalCount" :min="0" suffix=" Seats" :dragBy="1" class="w-1/3" />
    <InputMenu v-model="config.biddingRules.seatGoalInterval" :options="[
        { name: `Per ${SeatGoalInterval.Epoch}`, value: SeatGoalInterval.Epoch },
        { name: `Per ${SeatGoalInterval.Frame}`, value: SeatGoalInterval.Frame }
      ]" :selectFirst="true" class="w-1/3" />
    </template>
  </div>

  <label class="mt-3 font-bold opacity-60 mb-0.5">
    Profit Usage
  </label>
  <div class="flex flex-row items-center gap-2 w-full">
    <InputMenu :options="[
        { name: `Reinvest Profits from Operation`, value: ProfitUsage.Reinvest },
        { name: `Will Not Reinvest Profits`, value: ProfitUsage.Accumulate, disabled: true }
      ]" :selectFirst="true" class="w-full" />
  </div>
</template>

<script setup lang="ts">
import InputNumber from '../../components/InputNumber.vue';
import InputMenu from '../../components/InputMenu.vue';
import { getBiddingCalculator } from '../../stores/mainchain';
import { getConfig } from '../../stores/config';
import { SeatGoalType, SeatGoalInterval, ProfitUsage } from '@argonprotocol/apps-core';

const config = getConfig();
const calculator = getBiddingCalculator();
</script>
