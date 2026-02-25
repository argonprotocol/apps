<template>
  <div>
    <label class="mb-2 block font-medium text-gray-700">
      Desired Bitcoin Network Speed
      <span class="font-light">(how much you're willing to pay)</span>
    </label>
    <InputMenu
      v-model="selectedFeeRateKey"
      :options="feeRates"
      :dataTestid="dataTestid"
      :disabled="disabled"
      class="h-auto py-3 pl-3" />
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import InputMenu from '../../../components/InputMenu.vue';
import BitcoinLocks from '../../../lib/BitcoinLocks.ts';

interface IBitcoinFeeRateOption {
  key: string;
  label: string;
  time: string;
  value: bigint;
}

const FALLBACK_FEE_RATE = 5n;

const props = withDefaults(
  defineProps<{
    modelValue?: bigint;
    dataTestid?: string;
    disabled?: boolean;
  }>(),
  {
    dataTestid: 'BitcoinFeeRateInput',
    disabled: false,
  },
);

const emit = defineEmits<{
  (e: 'update:modelValue', value: bigint): void;
}>();

const feeRatesByKey = Vue.ref<Record<string, IBitcoinFeeRateOption>>(createDefaultFeeRates());
const selectedFeeRateKey = Vue.ref(resolveSelectedKey(props.modelValue ?? FALLBACK_FEE_RATE, feeRatesByKey.value));

const feeRates = Vue.computed(() => {
  return Object.values(feeRatesByKey.value).map(rate => ({
    name: `${rate.label} = ${rate.time}`,
    value: rate.key,
    sats: rate.value,
  }));
});

const selectedFeeRatePerSatVb = Vue.computed(() => {
  return feeRatesByKey.value[selectedFeeRateKey.value]?.value ?? FALLBACK_FEE_RATE;
});

Vue.watch(
  () => props.modelValue,
  modelValue => {
    if (typeof modelValue !== 'bigint') return;
    const nextKey = resolveSelectedKey(modelValue ?? FALLBACK_FEE_RATE, feeRatesByKey.value);
    if (nextKey !== selectedFeeRateKey.value) {
      selectedFeeRateKey.value = nextKey;
    }
  },
);

Vue.watch(
  () => feeRatesByKey.value,
  rates => {
    if (!(selectedFeeRateKey.value in rates)) {
      selectedFeeRateKey.value = resolveSelectedKey(props.modelValue ?? FALLBACK_FEE_RATE, rates);
    }
  },
  { deep: true },
);

Vue.watch(
  () => selectedFeeRatePerSatVb.value,
  value => {
    emit('update:modelValue', value);
  },
  { immediate: true },
);

Vue.onMounted(() => {
  void updateFeeRates();
});

async function updateFeeRates(): Promise<void> {
  try {
    const latestFeeRates = await BitcoinLocks.getFeeRates();
    feeRatesByKey.value = Object.entries(latestFeeRates).reduce(
      (acc, [key, rate]) => {
        acc[key] = {
          key,
          label: key.charAt(0).toUpperCase() + key.slice(1),
          time: `~${rate.estimatedMinutes} min`,
          value: rate.feeRate,
        };
        return acc;
      },
      {} as Record<string, IBitcoinFeeRateOption>,
    );
  } catch (error) {
    console.warn('Failed to update Bitcoin fee rates, using defaults', error);
  }
}

function resolveSelectedKey(value: bigint, ratesByKey: Record<string, IBitcoinFeeRateOption>): string {
  const fallbackKey = 'medium';
  const match = Object.values(ratesByKey).find(rate => rate.value === value);
  if (match) return match.key;
  if (fallbackKey in ratesByKey) return fallbackKey;
  const firstKey = Object.keys(ratesByKey)[0];
  return firstKey || fallbackKey;
}

function createDefaultFeeRates(): Record<string, IBitcoinFeeRateOption> {
  return {
    fast: { key: 'fast', label: 'Fast', time: '~10 min', value: 10n },
    medium: { key: 'medium', label: 'Medium', time: '~30 min', value: 5n },
    slow: { key: 'slow', label: 'Slow', time: '~60 min', value: 3n },
  };
}
</script>
