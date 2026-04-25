<template>
  <div class="treemap flex h-full min-h-48 w-full flex-col gap-1.5" :data-theme="theme">
    <!-- Remainder row: always at top -->
    <div
      v-if="hasRemainder"
      class="treemap__tile treemap__tile--remainder flex cursor-pointer items-center justify-center border border-slate-500/20 px-3 py-1.5"
      @click="handleTileClick({ key: '__remainder__', kind: 'remainder' } as IRectNode)">
      <span class="text-[0.88rem] opacity-60">
        <template v-if="remainderNode?.displayValue">{{ remainderNode.displayValue }}</template>
        {{ remainderNode?.label }}
      </span>
    </div>

    <!-- Treemap tiles -->
    <div ref="containerRef" class="relative grow overflow-hidden">
      <div
        v-for="rect in rectangles"
        :key="rect.key"
        class="treemap__tile absolute cursor-pointer overflow-hidden border border-slate-500/20"
        :class="[
          rect.kind === 'remainder'
            ? 'treemap__tile--remainder'
            : rect.emphasis === 'strong'
              ? 'treemap__tile--strong'
              : 'treemap__tile--item',
          rect.status === 'pending'
            ? 'treemap__tile--pending'
            : rect.status === 'unclaimed'
              ? 'treemap__tile--unclaimed'
              : '',
          rect.isCompact ? 'treemap__tile--compact' : '',
          rect.isTiny ? 'treemap__tile--tiny' : '',
        ]"
        :style="getRectStyle(rect)"
        @click="handleTileClick(rect)">
        <div
          class="treemap__content relative z-10 flex h-full w-full flex-col items-center justify-center text-center text-[rgba(71,85,105,0.78)] hover:bg-slate-500/10">
          <template v-if="!rect.isTiny">
            <div v-if="rect.label" class="treemap__value text-[1.05rem] leading-[1.2] font-bold">
              {{ rect.label }}
            </div>
            <div
              v-if="rect.displayValue && !rect.isCompact"
              class="treemap__label mt-1 text-[0.82rem] leading-[1.25] opacity-60">
              {{ rect.displayValue }}
            </div>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { hierarchy, treemap, treemapSquarify } from 'd3-hierarchy';
import type { HierarchyRectangularNode } from 'd3-hierarchy';

type AmountLike = bigint | number;

export type TileStatus = 'active' | 'pending' | 'unclaimed';

interface ITreemapItem {
  id?: string;
  label: string;
  amount: AmountLike;
  displayValue?: string;
  emphasis?: 'default' | 'strong';
  status?: TileStatus;
}

interface IRectNode {
  key: string;
  label: string;
  displayValue?: string;
  value: number;
  kind: 'item' | 'remainder';
  emphasis: 'default' | 'strong';
  status: TileStatus;
  x: number;
  y: number;
  width: number;
  height: number;
  isCompact: boolean;
  isTiny: boolean;
}

interface ITreemapNodeDatum {
  key: string;
  label: string;
  displayValue?: string;
  value: number;
  kind: 'item' | 'remainder';
  emphasis: 'default' | 'strong';
  status: TileStatus;
  children?: ITreemapNodeDatum[];
}

const props = withDefaults(
  defineProps<{
    total: AmountLike;
    items: ITreemapItem[];
    remainderLabel?: string;
    remainderDisplayValue?: string;
    theme?: 'btc' | 'argon';
    remainderThreshold?: number;
    remainderMinimum?: AmountLike;
  }>(),
  {
    remainderLabel: 'Unused',
    remainderDisplayValue: '',
    theme: 'btc',
    remainderThreshold: 0.15,
    remainderMinimum: 0,
  },
);

const emit = defineEmits<{
  (e: 'tileClick', key: string): void;
}>();

function handleTileClick(rect: IRectNode) {
  if (rect.kind === 'remainder') {
    emit('tileClick', '__remainder__');
  } else {
    emit('tileClick', rect.key);
  }
}

const containerRef = Vue.ref<HTMLElement | null>(null);
const containerWidth = Vue.ref(100);
const containerHeight = Vue.ref(100);

let resizeObserver: ResizeObserver | undefined;

Vue.onMounted(() => {
  if (!containerRef.value) return;
  const rect = containerRef.value.getBoundingClientRect();
  containerWidth.value = rect.width || 100;
  containerHeight.value = rect.height || 100;

  resizeObserver = new ResizeObserver(entries => {
    const entry = entries[0];
    if (!entry) return;
    containerWidth.value = entry.contentRect.width || 100;
    containerHeight.value = entry.contentRect.height || 100;
  });
  resizeObserver.observe(containerRef.value);
});

Vue.onUnmounted(() => {
  resizeObserver?.disconnect();
});

function toNumber(value: AmountLike): number {
  return typeof value === 'bigint' ? Number(value) : value;
}

const rectangles = Vue.computed(() => {
  const normalizedItems: ITreemapNodeDatum[] = props.items
    .map((item, index) => ({
      key: item.id ?? `${item.label}-${index}`,
      label: item.label,
      displayValue: item.displayValue,
      value: Math.max(toNumber(item.amount), 0),
      kind: 'item' as const,
      emphasis: item.emphasis ?? 'default',
      status: item.status ?? ('active' as TileStatus),
    }))
    .filter(item => item.value > 0);

  const total = Math.max(toNumber(props.total), 0);
  const sortedItems = normalizedItems.sort((a, b) => b.value - a.value);

  const used = sortedItems.reduce((sum, item) => sum + item.value, 0);
  const remainder = Math.max(total - used, 0);

  const nodes: ITreemapNodeDatum[] = [...sortedItems];
  const remainderMin = toNumber(props.remainderMinimum);
  const remainderIsLarge = remainder > total * props.remainderThreshold;
  if (remainderIsLarge && remainder > remainderMin) {
    nodes.push({
      key: '__remainder__',
      label: props.remainderLabel,
      displayValue: props.remainderDisplayValue || undefined,
      value: remainder,
      kind: 'remainder' as const,
      emphasis: 'default' as const,
      status: 'active' as TileStatus,
    });
  }

  if (nodes.length === 0) {
    return [];
  }

  const w = containerWidth.value;
  const h = containerHeight.value;

  const root = treemap<ITreemapNodeDatum>().tile(treemapSquarify).size([w, h]).paddingInner(2).paddingOuter(0)(
    hierarchy<ITreemapNodeDatum>({
      key: '__root__',
      label: '',
      value: 0,
      kind: 'item',
      emphasis: 'default',
      status: 'active' as TileStatus,
      children: nodes,
    })
      .sum(node => node.value)
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0)),
  );

  return root.leaves().map((node: HierarchyRectangularNode<ITreemapNodeDatum>) => {
    const data = node.data;
    const width = Math.max(node.x1 - node.x0, 0);
    const height = Math.max(node.y1 - node.y0, 0);

    return {
      key: data.key,
      label: data.label,
      displayValue: data.displayValue,
      value: data.value,
      kind: data.kind,
      emphasis: data.emphasis,
      status: data.status,
      x: node.x0,
      y: node.y0,
      width,
      height,
      isCompact: width < 80 || height < 60,
      isTiny: width < 40 || height < 30,
    };
  });
});

const hasRemainder = Vue.computed(() => {
  const total = Math.max(toNumber(props.total), 0);
  const used = props.items.reduce((sum, item) => sum + Math.max(toNumber(item.amount), 0), 0);
  const remainder = Math.max(total - used, 0);
  const remainderMin = toNumber(props.remainderMinimum);
  if (remainder <= remainderMin) return false;
  const remainderIsLarge = remainder > total * props.remainderThreshold;
  return !remainderIsLarge;
});

const remainderNode = Vue.computed(() => {
  return {
    label: props.remainderLabel,
    displayValue: props.remainderDisplayValue || undefined,
  };
});

function getRectStyle(rect: IRectNode) {
  let left = rect.x;
  let top = rect.y;
  let width = rect.width;
  let height = rect.height;

  if (rect.kind === 'item') {
    if (width < 6) {
      width = 6;
      left = Math.min(left, Math.max(containerWidth.value - width, 0));
    }

    if (height < 6) {
      height = 6;
      top = Math.min(top, Math.max(containerHeight.value - height, 0));
    }
  }

  return {
    left: `${left}px`,
    top: `${top}px`,
    width: `${width}px`,
    height: `${height}px`,
    zIndex: rect.width < 6 || rect.height < 6 ? 2 : 1,
  };
}
</script>

<style scoped>
.treemap__tile {
  box-sizing: border-box;
}

.treemap__tile--item {
  background: rgba(255, 255, 255, 0.34);
}

.treemap[data-theme='btc'] .treemap__tile--item {
  background: rgba(232, 185, 35, 0.52);
  //background: rgba(247, 147, 26, 0.32);
}

.treemap[data-theme='btc'] .treemap__tile--strong {
  background: rgba(232, 185, 35, 0.36);

  //background: rgba(247, 147, 26, 0.96);
}

.treemap[data-theme='argon'] .treemap__tile--item {
  background: rgba(222, 126, 244, 0.52);
}

.treemap[data-theme='argon'] .treemap__tile--strong {
  background: rgba(222, 126, 244, 0.66);
}

.treemap .treemap__tile--pending {
  border-style: dashed;
  position: relative;
}

.treemap .treemap__tile--pending::before {
  content: '';
  position: absolute;
  inset: 0;
  background: repeating-linear-gradient(
    -45deg,
    rgba(210, 200, 155, 0.7),
    rgba(210, 200, 155, 0.1) 4px,
    transparent 4px,
    transparent 10px
  );
  pointer-events: none;
}

.treemap .treemap__tile--unclaimed {
  border-style: dashed;
  background: rgba(255, 255, 255, 0.15);
}

.treemap__tile--remainder {
  border-style: dashed;
  background: rgba(255, 255, 255, 0.22);
}

.treemap__tile--remainder.treemap__tile {
  border-width: 2px;
  border-color: rgba(148, 163, 184, 0.85);
}

.treemap__tile--compact .treemap__value {
  font-size: 0.92rem;
}

.treemap__tile--compact .treemap__label {
  font-size: 0.77rem;
}

.treemap__tile--tiny .treemap__label {
  margin-top: 0;
}
</style>
