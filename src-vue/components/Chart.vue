<template>
  <div
    ref="wrapperRef"
    tabindex="0"
    role="group"
    aria-label="Chart history. Hover to preview, click to hold. Use left and right arrow keys to inspect frames."
    data-chart-history
    class="focus-visible:outline-argon-600 relative flex h-full w-full grow flex-col focus-visible:outline-2"
    @pointermove="showTooltip"
    @pointerleave="onPointerLeave"
    @click="pinTooltip"
  >
    <div class="relative w-full grow">
      <div class="absolute top-0 -left-1.5 h-[calc(100%-27px)] w-[calc(100%+12px)]">
        <canvas ref="chartRef" aria-label="Earnings history"></canvas>
        <span
          v-if="latestPosition"
          aria-label="Latest return"
          class="bg-argon-600 pointer-events-none absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white"
          :style="{ left: `${latestPosition.x}px`, top: `${latestPosition.y}px` }"
        />
      </div>
    </div>
    <XAxis class="absolute bottom-0 left-0 z-10 w-full" />
    <span
      v-if="hoveredItem"
      class="pointer-events-none absolute top-0 bottom-7 z-10 w-px bg-slate-400/60"
      :style="{ left: `${guidePosition.x}px` }"
    />
    <PopoverRoot :open="!!hoveredItem" @update:open="if (!$event) clearTooltip();">
      <PopoverAnchor as-child>
        <span
          class="pointer-events-none absolute size-px"
          :style="{ left: `${guidePosition.x}px`, top: `${guidePosition.y}px` }"
        />
      </PopoverAnchor>
      <PopoverPortal>
        <PopoverContent
          v-if="hoveredItem"
          side="top"
          :sideOffset="12"
          :collisionPadding="12"
          :style="floatingZIndex"
          aria-label="Chart frame details"
          class="w-max min-w-96 rounded-md border border-gray-800/20 bg-white px-4 py-3 text-sm text-slate-600 shadow-xl"
          @openAutoFocus.prevent
          @closeAutoFocus.prevent
          @pointerenter="cancelTooltipClose"
          @pointerleave="onPointerLeave"
          @click.stop="holdTooltip"
        >
          <!-- prettier-ignore -->
          <div class="mb-3 flex items-start justify-between gap-4 border-b border-slate-200 pb-3 font-semibold whitespace-nowrap text-slate-700">
            <div class="flex items-start gap-3">
              <div v-if="tooltipPinned" class="flex shrink-0 gap-1">
                <button
                  type="button"
                  aria-label="Previous frame"
                  :disabled="!hoveredItem.previous"
                  class="text-argon-600/70 focus-visible:outline-argon-600 inline-flex size-5 cursor-pointer items-center justify-center rounded-sm opacity-50 hover:opacity-100 focus-visible:outline-2 disabled:cursor-default disabled:opacity-20"
                  @click.stop="inspectAdjacentFrame(-1)"
                >
                  <ChevronLeftIcon class="size-5" />
                </button>
                <button
                  type="button"
                  aria-label="Next frame"
                  :disabled="!hoveredItem.next"
                  class="text-argon-600/70 focus-visible:outline-argon-600 inline-flex size-5 cursor-pointer items-center justify-center rounded-sm opacity-50 hover:opacity-100 focus-visible:outline-2 disabled:cursor-default disabled:opacity-20"
                  @click.stop="inspectAdjacentFrame(1)"
                >
                  <ChevronRightIcon class="size-5" />
                </button>
              </div>
              <div>
                <slot name="tooltipHeader" :item="hoveredItem">
                  {{ dayjs.utc(hoveredItem.date).format('MMM D, YYYY') }}
                  <div v-if="isLocalChain" class="font-normal">
                    {{ dayjs.utc(hoveredItem.date).format('HH:mm:ss') }} UTC
                  </div>
                </slot>
              </div>
            </div>
            <button
              v-if="tooltipPinned"
              type="button"
              aria-label="Close chart details"
              class="hover:text-argon-600 focus-visible:outline-argon-600 inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm text-slate-400 focus-visible:outline-2"
              @click.stop="clearTooltip"
            >
              <XMarkIcon class="size-5" />
            </button>
          </div>
          <slot name="tooltip" :item="hoveredItem" />
          <p
            v-if="!tooltipPinned"
            class="mt-3 border-t border-slate-200 pt-2 text-center text-xs font-light text-slate-400 italic"
          >
            Click to pin in place
          </p>
          <PopoverPanelArrow class="-translate-y-px" />
        </PopoverContent>
      </PopoverPortal>
    </PopoverRoot>
  </div>
</template>

<script setup lang="ts">
import * as Vue from 'vue';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import { CategoryScale, Chart, LinearScale, LineController, LineElement, PointElement, TimeScale } from 'chart.js';
import 'chartjs-adapter-dayjs-4/dist/chartjs-adapter-dayjs-4.esm';
import { PopoverAnchor, PopoverContent, PopoverPortal, PopoverRoot } from 'reka-ui';
import { NetworkConfig } from '@argonprotocol/apps-core';
import { ChevronLeftIcon, ChevronRightIcon, XMarkIcon } from '@heroicons/vue/24/outline';
import type { IChartItem } from '../interfaces/IChartItem';
import { createChartOptions } from '../lib/ChartOptions';
import { useFloatingZIndex } from '../overlays/helpers/OverlayZIndex.ts';
import PopoverPanelArrow from './PopoverPanelArrow.vue';
import XAxis, { startDate, endDate } from './XAxis.vue';

Chart.register(LineController, LineElement, PointElement, LinearScale, CategoryScale, TimeScale);
dayjs.extend(utc);

const wrapperRef = Vue.ref<HTMLElement>();
const chartRef = Vue.ref<HTMLCanvasElement>();
let chart: Chart<'line', { x: number; y: number | null }[]> | undefined;
const fillerPoints: { x: number; y: number }[] = [];
const chartPoints: { x: number; y: number | null }[] = [];
let items: IChartItem[] = [];

const latestPosition = Vue.ref<{ x: number; y: number }>();
const hoveredItem = Vue.shallowRef<IChartItem>();
const guidePosition = Vue.ref({ x: 0, y: 0 });
const floatingZIndex = useFloatingZIndex();
const isLocalChain = NetworkConfig.networkName === 'dev-docker';
const emit = defineEmits<{ inspectFrame: [frameId: number | undefined] }>();
let lastPointer: PointerEvent | undefined;
const tooltipPinned = Vue.ref(false);
let tooltipCloseTimer: ReturnType<typeof setTimeout> | undefined;

function reloadData(newItems: IChartItem[]) {
  items = newItems;
  chartPoints.length = 0;
  fillerPoints.length = 0;
  const latest = items.at(-1);
  if (items[0]?.isFiller) fillerPoints.push({ x: startDate.valueOf(), y: 0 });
  for (const [index, item] of items.entries()) {
    let date = dayjs.utc(item.date);
    // Accelerated dev-chain frames occupy one chart day; tooltips retain their actual timestamps.
    if (isLocalChain && latest) date = dayjs.utc(latest.date).subtract(latest.id - item.id, 'day');
    const x = date.valueOf();
    chartPoints.push({ x, y: item.score });
    if (item.isFiller) fillerPoints.push({ x, y: 0 });
    // Join the inactive baseline to the first known return without bridging missing history.
    if (item.score !== null && items[index - 1]?.isFiller) chartPoints[index - 1].y = 0;
  }
  if (chart) {
    chart.update();
    if (lastPointer) showTooltip(lastPointer);
    else if (hoveredItem.value) inspectItem(items.findIndex(item => item.id === hoveredItem.value?.id));
  }
}

function getPointPosition(index: number) {
  const point = chartPoints[index];
  if (!chart || !point) return { x: undefined, y: undefined };
  return {
    x: chart.scales.x.getPixelForValue(point.x),
    y: chart.scales.y.getPixelForValue(point.y ?? 0),
  };
}

function getItemIndexFromEvent(event: MouseEvent, override: { x?: number } = {}) {
  if (!chartRef.value || !chart || !chartPoints.length) return;
  const x = override.x ?? event.clientX - chartRef.value.getBoundingClientRect().left;
  let nearestIndex = 0;
  let nearestDistance = Infinity;
  for (const [index, point] of chartPoints.entries()) {
    const distance = Math.abs(chart.scales.x.getPixelForValue(point.x) - x);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = index;
    }
  }
  return nearestIndex;
}

function showTooltip(event: PointerEvent | MouseEvent) {
  cancelTooltipClose();
  if (tooltipPinned.value) return;
  if (event instanceof PointerEvent) lastPointer = event;
  if (!chartRef.value || !chart || !wrapperRef.value) return;
  const index = getItemIndexFromEvent(event);
  const item = index === undefined ? undefined : items[index];
  const canvas = chartRef.value.getBoundingClientRect();
  const x = event.clientX - canvas.left;
  const firstPoint = chartPoints[0];
  const lastPoint = chartPoints.at(-1);
  if (!chart || !firstPoint || !lastPoint) return;
  const date = chart.scales.x.getValueForPixel(x);
  if (date === undefined) return;
  const halfFrame = (chartPoints[1]?.x - firstPoint.x) / 2 || 43_200_000;
  if (date < firstPoint.x - halfFrame || date > lastPoint.x + halfFrame) {
    clearTooltip();
    return;
  }
  if (item) inspectItem(index!);
}

function inspectItem(index: number) {
  if (!chartRef.value || !wrapperRef.value) return;
  hoveredItem.value = items[index];
  if (!hoveredItem.value) return;
  const canvas = chartRef.value.getBoundingClientRect();
  const wrapper = wrapperRef.value.getBoundingClientRect();
  const point = getPointPosition(index);
  guidePosition.value = {
    x: (point.x ?? 0) + canvas.left - wrapper.left,
    y: (point.y ?? 0) + canvas.top - wrapper.top,
  };
}

function inspectWithKeyboard(event: KeyboardEvent) {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  if (!items.length) return;
  if (!hoveredItem.value && document.activeElement !== wrapperRef.value) return;
  if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable]')) return;

  event.preventDefault();
  inspectAdjacentFrame(event.key === 'ArrowLeft' ? -1 : 1);
}

function inspectAdjacentFrame(direction: -1 | 1) {
  if (!items.length) return;
  let index = items.findIndex(item => item.id === hoveredItem.value?.id);
  if (index < 0) index = items.length;
  index = Math.max(0, Math.min(items.length - 1, index + direction));
  inspectItem(index);
  holdTooltip();
}

function pinTooltip(event: MouseEvent) {
  tooltipPinned.value = false;
  showTooltip(event);
  holdTooltip();
}

function holdTooltip() {
  cancelTooltipClose();
  lastPointer = undefined;
  tooltipPinned.value = !!hoveredItem.value;
}

function cancelTooltipClose() {
  clearTimeout(tooltipCloseTimer);
}

function onPointerLeave() {
  lastPointer = undefined;
  if (tooltipPinned.value) return;
  cancelTooltipClose();
  tooltipCloseTimer = setTimeout(clearTooltip, 300);
}

function clearTooltip() {
  cancelTooltipClose();
  lastPointer = undefined;
  hoveredItem.value = undefined;
  tooltipPinned.value = false;
}

Vue.watch(hoveredItem, item => emit('inspectFrame', item?.id));

function doResize() {
  chart?.resize();
  if (hoveredItem.value) inspectItem(items.findIndex(item => item.id === hoveredItem.value?.id));
}

Vue.onMounted(() => {
  window.addEventListener('keydown', inspectWithKeyboard);
  chart = new Chart(chartRef.value!, {
    ...createChartOptions(startDate, endDate, fillerPoints, chartPoints),
    plugins: [
      {
        id: 'latest-return-marker',
        afterDraw(instance) {
          const point = chartPoints.findLast(point => point.y !== null);
          if (!point) {
            latestPosition.value = undefined;
            return;
          }
          const x = instance.scales.x.getPixelForValue(point.x);
          if (x < instance.chartArea.left || x > instance.chartArea.right) {
            latestPosition.value = undefined;
            return;
          }
          latestPosition.value = { x, y: instance.scales.y.getPixelForValue(point.y!) };
        },
      },
    ],
  });
});

Vue.onBeforeUnmount(() => {
  cancelTooltipClose();
  window.removeEventListener('keydown', inspectWithKeyboard);
  chart?.destroy();
});

defineExpose({ reloadData, getPointPosition, getItemIndexFromEvent, doResize });
</script>
