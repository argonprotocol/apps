<template>
  <div ref="host" class="d3-pie-host" />
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch } from 'vue';
import * as d3 from 'd3';

type Slice = {
  label: string;
  value: number;
  color?: string;
};

const props = withDefaults(
  defineProps<{
    data: [Slice, Slice];

    // sizing
    size?: number;

    // style
    strokeColor?: string;
    strokeWidth?: number;

    // rotation (in degrees, 0 = top, clockwise)
    rotation?: number;

    // exploded slice
    explodedIndex?: 0 | 1 | null;
    explodeOffset?: number; // pixels

    animate?: boolean;
    durationMs?: number;
  }>(),
  {
    size: 520,

    strokeColor: '#ffffff',
    strokeWidth: 10,

    rotation: 0,

    explodedIndex: 0,
    explodeOffset: 18,

    animate: true,
    durationMs: 650,
  },
);

const host = ref<HTMLElement | null>(null);
let ro: ResizeObserver | null = null;

function clampNonNeg(n: number) {
  return Number.isFinite(n) ? Math.max(0, n) : 0;
}

function midAngle(d: any) {
  return (d.startAngle + d.endAngle) / 2;
}

function render() {
  if (!host.value) return;

  host.value.innerHTML = '';

  const w = host.value.clientWidth || props.size;
  const h = host.value.clientHeight || w;
  const size = Math.min(w, h);

  const borderWidth = 15;
  const radius = size / 2 - borderWidth;

  const sanitized: [Slice, Slice] = [
    { ...props.data[0], value: clampNonNeg(props.data[0].value) },
    { ...props.data[1], value: clampNonNeg(props.data[1].value) },
  ];

  const total = sanitized[0].value + sanitized[1].value;

  // If both are 0, show a single grey circle.
  const dataForPie: any[] =
    total === 0
      ? [
          { label: 'Empty', value: 1, color: 'rgba(255,255,255,0.18)' },
          { label: '', value: 0, color: 'rgba(0,0,0,0)' },
        ]
      : sanitized;

  const fallback = ['#8a1d85', '#d7c3d7']; // close to your mock
  const fill = (d: any, i: number) => d.data.color || props.data[i]?.color || fallback[i] || '#999';

  const svg = d3
    .select(host.value)
    .append('svg')
    .attr('width', size)
    .attr('height', size)
    .attr('viewBox', `0 0 ${size} ${size}`)
    .attr('role', 'img');

  const g = svg.append('g').attr('transform', `translate(${size / 2},${size / 2})`);

  // Add white background circle for border effect
  g.append('circle')
    .attr('r', size / 2)
    .attr('fill', '#fdfcfd');

  const rotationRadians = (props.rotation * Math.PI) / 180;
  const pie = d3
    .pie<any>()
    .sort(null)
    .value(d => d.value)
    .startAngle(rotationRadians)
    .endAngle(rotationRadians - 2 * Math.PI);

  const arcs = pie(dataForPie);

  // PIE chart => innerRadius(0)
  const arcGen = d3.arc<any>().innerRadius(0).outerRadius(radius);

  // Put the exploded slice last so it draws on top (like your image)
  const exploded = null; //props.explodedIndex ?? null;
  const drawOrder = arcs.map((d, i) => ({ d, i }));

  // Render each slice in its own group so we can translate (explode)
  const sliceG = g.selectAll('g.slice').data(drawOrder).enter().append('g').attr('class', 'slice');

  const paths = sliceG
    .append('path')
    .attr('fill', ({ d, i }) => fill(d, i))
    .attr('stroke', props.strokeColor)
    .attr('stroke-width', props.strokeWidth)
    .attr('stroke-linejoin', 'miter')
    .attr('stroke-miterlimit', 10);

  if (props.animate) {
    paths
      .attr('d', ({ d }) => arcGen({ ...d, endAngle: d.startAngle }) as any)
      .transition()
      .duration(props.durationMs)
      .attrTween('d', function ({ d }) {
        const interp = d3.interpolate(d.startAngle, d.endAngle);
        return t => arcGen({ ...d, endAngle: interp(t) }) as any;
      });
  } else {
    paths.attr('d', ({ d }) => arcGen(d) as any);
  }
}

onMounted(() => {
  render();

  if (host.value && 'ResizeObserver' in window) {
    ro = new ResizeObserver(() => render());
    ro.observe(host.value);
  }
});

onBeforeUnmount(() => {
  ro?.disconnect();
  ro = null;
});

watch(
  () => [
    props.data[0].value,
    props.data[1].value,
    props.data[0].color,
    props.data[1].color,
    props.size,
    props.strokeColor,
    props.strokeWidth,
    props.rotation,
    props.explodedIndex,
    props.explodeOffset,
    props.animate,
    props.durationMs,
  ],
  () => render(),
);
</script>

<style scoped>
.d3-pie-host {
  width: 100%;

  svg {
    width: 100%;
    height: 100%;
  }
}
</style>
