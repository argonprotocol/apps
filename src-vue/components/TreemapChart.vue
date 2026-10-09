<template>
  <div data-testid="TreemapChart" class="treemap flex h-full min-h-48 w-full flex-col gap-1.5" :data-theme="theme">
    <!-- Remainder row: always at top -->
    <div
      v-if="hasRemainder"
      data-treemap-kind="remainder"
      class="treemap__tile treemap__tile--remainder flex items-center justify-center border border-slate-500/20 px-3 py-1.5"
    >
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
        :data-treemap-key="rect.key"
        :data-treemap-kind="rect.kind"
        class="treemap__tile absolute overflow-hidden border border-slate-500/20"
        :class="[
          rect.kind === 'remainder'
            ? 'treemap__tile--remainder'
            : rect.emphasis === 'strong'
              ? 'treemap__tile--strong'
              : 'treemap__tile--item',
          rect.kind === 'item' ? 'cursor-pointer' : '',
          rect.status === 'pending'
            ? 'treemap__tile--pending'
            : rect.status === 'unclaimed'
              ? 'treemap__tile--unclaimed'
              : '',
          rect.isCompact ? 'treemap__tile--compact' : '',
          rect.isTiny ? 'treemap__tile--tiny' : '',
        ]"
        :style="getRectStyle(rect)"
        @click="handleTileClick(rect)"
      >
        <div
          class="treemap__content relative z-10 flex h-full w-full flex-col items-center justify-center text-center text-[rgba(71,85,105,0.78)] hover:bg-slate-500/10"
        >
          <template v-if="!rect.isTiny">
            <div v-if="rect.label" class="treemap__value text-[1.05rem] leading-[1.2] font-bold">
              <slot name="label" :item="rect">{{ rect.label }}</slot>
            </div>
            <div v-if="rect.displayValue && !rect.isCompact" class="treemap__label mt-1 text-[0.82rem] leading-[1.25]">
              <slot name="displayValue" :item="rect">
                <span class="opacity-60">{{ rect.displayValue }}</span>
              </slot>
            </div>
          </template>
        </div>
      </div>
    </div>
    <slot name="footer" :rectangles="rectangles" />
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
  value: number;
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
  if (rect.kind === 'item') emit('tileClick', rect.key);
}

const containerRef = Vue.ref<HTMLElement | null>(null);
const containerWidth = Vue.ref(100);
const containerHeight = Vue.ref(100);

let resizeObserver: ResizeObserver | undefined;
let resizeAnimationFrame: number | undefined;

function updateContainerSize(width: number, height: number) {
  const nextWidth = width || 100;
  const nextHeight = height || 100;

  if (containerWidth.value === nextWidth && containerHeight.value === nextHeight) {
    return;
  }

  containerWidth.value = nextWidth;
  containerHeight.value = nextHeight;
}

Vue.onMounted(() => {
  if (!containerRef.value) return;
  const rect = containerRef.value.getBoundingClientRect();
  updateContainerSize(rect.width, rect.height);

  resizeObserver = new ResizeObserver(entries => {
    const entry = entries[0];
    if (!entry) return;

    if (resizeAnimationFrame) {
      cancelAnimationFrame(resizeAnimationFrame);
    }

    resizeAnimationFrame = requestAnimationFrame(() => {
      updateContainerSize(entry.contentRect.width, entry.contentRect.height);
    });
  });
  resizeObserver.observe(containerRef.value);
});

Vue.onUnmounted(() => {
  resizeObserver?.disconnect();
  if (resizeAnimationFrame) {
    cancelAnimationFrame(resizeAnimationFrame);
  }
});

function toNumber(value: AmountLike): number {
  return typeof value === 'bigint' ? Number(value) : value;
}

const itemsByKey = Vue.computed(() => {
  return new Map(props.items.map((item, index) => [item.id ?? `${item.label}-${index}`, item]));
});

// Only identities, amounts and container size affect geometry. Refreshes and label changes don't.
const layout = Vue.computed<{
  width: number;
  height: number;
  rectangles: Pick<IRectNode, 'key' | 'value' | 'x' | 'y' | 'width' | 'height'>[];
}>(previous => {
  const nodes: ITreemapNodeDatum[] = [...itemsByKey.value]
    .map(([key, item]) => ({
      key,
      value: Math.max(toNumber(item.amount), 0),
    }))
    .filter(item => item.value > 0);

  const total = Math.max(toNumber(props.total), 0);
  const used = nodes.reduce((sum, item) => sum + item.value, 0);
  const remainder = Math.max(total - used, 0);

  const remainderMin = toNumber(props.remainderMinimum);
  const remainderIsLarge = remainder > total * props.remainderThreshold;
  if (remainderIsLarge && remainder > remainderMin) {
    nodes.push({ key: '__remainder__', value: remainder });
  }

  // Give equal-sized tiles a stable order even if refreshed records arrive in a different order.
  nodes.sort((a, b) => b.value - a.value || a.key.localeCompare(b.key));
  const width = containerWidth.value;
  const height = containerHeight.value;
  if (
    previous?.width === width &&
    previous.height === height &&
    previous.rectangles.length === nodes.length &&
    nodes.every((node, index) => {
      const rectangle = previous.rectangles[index];
      return rectangle.key === node.key && rectangle.value === node.value;
    })
  ) {
    return previous;
  }

  if (nodes.length === 0) return { width, height, rectangles: [] };

  const root = treemap<ITreemapNodeDatum>().tile(treemapSquarify).size([width, height]).paddingInner(2).paddingOuter(0)(
    hierarchy<ITreemapNodeDatum>({
      key: '__root__',
      value: 0,
      children: nodes,
    }).sum(node => node.value),
  );

  const rectangles = root.leaves().map((node: HierarchyRectangularNode<ITreemapNodeDatum>) => ({
    key: node.data.key,
    value: node.data.value,
    x: node.x0,
    y: node.y0,
    width: Math.max(node.x1 - node.x0, 0),
    height: Math.max(node.y1 - node.y0, 0),
  }));
  return { width, height, rectangles };
});

const rectangles = Vue.computed((): IRectNode[] => {
  return layout.value.rectangles.map(rect => {
    const item = itemsByKey.value.get(rect.key);
    const isRemainder = rect.key === '__remainder__';
    return {
      ...rect,
      label: isRemainder ? props.remainderLabel : item!.label,
      displayValue: isRemainder ? props.remainderDisplayValue : item!.displayValue,
      kind: isRemainder ? 'remainder' : 'item',
      emphasis: item?.emphasis ?? 'default',
      status: item?.status ?? 'active',
      isCompact: rect.width < 80 || rect.height < 60,
      isTiny: rect.width < 40 || rect.height < 30,
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
}

.treemap[data-theme='btc'] .treemap__tile--strong {
  background: rgba(232, 185, 35, 0.36);
}

.treemap[data-theme='argon'] .treemap__tile--item {
  background: rgba(222, 126, 244, 0.52);
}

.treemap[data-theme='argon'] .treemap__tile--strong {
  background: rgba(222, 126, 244, 0.66);
}

.treemap .treemap__tile--pending {
  border-style: dashed;
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

.treemap[data-theme='btc'] .treemap__tile--pending {
  background: rgba(232, 185, 35, 0.1);
  border-color: rgba(148, 163, 184, 0.35);
}

.treemap[data-theme='btc'] .treemap__tile--pending::before {
  opacity: 0.25;
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
