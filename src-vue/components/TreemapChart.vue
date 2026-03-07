<template>
  <div class="treemap relative h-full min-h-48 w-full" :data-theme="theme">
    <div
      v-for="rect in rectangles"
      :key="rect.key"
      class="treemap__tile absolute overflow-hidden border border-slate-500/20"
      :class="[
        rect.kind === 'remainder' ? 'treemap__tile--remainder' : 'treemap__tile--item',
        rect.emphasis === 'strong' ? 'treemap__tile--strong' : '',
        rect.isCompact ? 'treemap__tile--compact' : '',
        rect.isTiny ? 'treemap__tile--tiny' : '',
      ]"
      :style="getRectStyle(rect)">
      <div
        class="treemap__content flex h-full w-full flex-col items-center justify-center text-center text-[rgba(71,85,105,0.78)] hover:bg-slate-500/10">
        <div v-if="rect.displayValue" class="treemap__value text-[1.05rem] leading-[1.2] font-bold">
          {{ rect.displayValue }} {{ rect.label }}
        </div>
        <div class="treemap__label mt-1 text-[0.88rem] leading-[1.25] font-semibold"></div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import { hierarchy, treemap, treemapSquarify } from 'd3-hierarchy';
import type { HierarchyRectangularNode } from 'd3-hierarchy';

type AmountLike = bigint | number;

interface ITreemapItem {
  id?: string;
  label: string;
  amount: AmountLike;
  displayValue?: string;
  emphasis?: 'default' | 'strong';
}

interface IRectNode {
  key: string;
  label: string;
  displayValue?: string;
  value: number;
  kind: 'item' | 'remainder';
  emphasis: 'default' | 'strong';
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
  children?: ITreemapNodeDatum[];
}

const props = withDefaults(
  defineProps<{
    total: AmountLike;
    items: ITreemapItem[];
    remainderLabel?: string;
    remainderDisplayValue?: string;
    theme?: 'sand' | 'plum';
  }>(),
  {
    remainderLabel: 'Unused',
    remainderDisplayValue: '',
    theme: 'sand',
  },
);

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
    }))
    .filter(item => item.value > 0)
    .sort((a, b) => b.value - a.value);

  const total = Math.max(toNumber(props.total), 0);
  const used = normalizedItems.reduce((sum, item) => sum + item.value, 0);
  const remainder = Math.max(total - used, 0);

  const nodes: ITreemapNodeDatum[] = [...normalizedItems];
  if (remainder > 0) {
    nodes.push({
      key: '__remainder__',
      label: props.remainderLabel,
      displayValue: props.remainderDisplayValue || undefined,
      value: remainder,
      kind: 'remainder' as const,
      emphasis: 'default' as const,
    });
  }

  if (nodes.length === 0) {
    return [];
  }

  const root = treemap<ITreemapNodeDatum>().tile(treemapSquarify).size([100, 100]).paddingInner(1.25).paddingOuter(0)(
    hierarchy<ITreemapNodeDatum>({
      key: '__root__',
      label: '',
      value: 0,
      kind: 'item',
      emphasis: 'default',
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
      x: node.x0,
      y: node.y0,
      width,
      height,
      isCompact: width < 28 || height < 24,
      isTiny: width < 16 || height < 14,
    };
  });
});

function getRectStyle(rect: IRectNode) {
  return {
    left: `${rect.x}%`,
    top: `${rect.y}%`,
    width: `${rect.width}%`,
    height: `${rect.height}%`,
  };
}
</script>

<style scoped>
.treemap__tile--item {
  background: rgba(255, 255, 255, 0.34);
}

.treemap[data-theme='sand'] .treemap__tile--item {
  background: rgba(238, 232, 201, 0.82);
}

.treemap[data-theme='sand'] .treemap__tile--strong {
  background: rgba(233, 225, 190, 0.96);
}

.treemap[data-theme='plum'] .treemap__tile--item {
  background: rgba(223, 204, 228, 0.82);
}

.treemap[data-theme='plum'] .treemap__tile--strong {
  background: rgba(214, 189, 222, 0.96);
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
