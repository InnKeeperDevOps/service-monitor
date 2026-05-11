<script setup lang="ts">
import { computed } from "vue";
import type { TelemetrySample } from "./cache.js";

// Tiny inline-SVG sparkline. No deps — we control all 50 lines and
// don't ship a chart library to render six 200×40 rectangles.
//
// Inputs:
//   samples  — full ring buffer (oldest first)
//   pick     — selector that pulls the metric we want from each sample
//   domain   — "percent" forces 0..100 axis; "auto" scales to data
//   color    — stroke color CSS value
//
// Renders a polyline. Falls back to a thin "no data" placeholder when
// fewer than 2 valid samples exist.

const props = defineProps<{
  samples: TelemetrySample[];
  pick: (s: TelemetrySample) => number | undefined;
  /** "percent" pins the y-axis to 0..100; "auto" scales to the data window. */
  domain?: "percent" | "auto";
  color?: string;
  width?: number;
  height?: number;
}>();

const W = computed(() => props.width ?? 160);
const H = computed(() => props.height ?? 36);

type Pt = { x: number; y: number; v: number };

const points = computed<Pt[]>(() => {
  // Filter to samples that actually have a value for this metric.
  const vals = props.samples
    .map((s) => ({ ts: s.ts, v: props.pick(s) }))
    .filter((p): p is { ts: number; v: number } => p.v !== undefined && Number.isFinite(p.v));
  if (vals.length < 2) return [];

  // Y-domain.
  let lo: number;
  let hi: number;
  if (props.domain === "percent") {
    lo = 0;
    hi = 100;
  } else {
    lo = vals[0].v;
    hi = vals[0].v;
    for (const p of vals) {
      if (p.v < lo) lo = p.v;
      if (p.v > hi) hi = p.v;
    }
    // Avoid zero-height range when the metric is flat.
    if (hi === lo) {
      hi = lo + 1;
    }
    // 5% headroom so the line isn't pinned to the top edge.
    const pad = (hi - lo) * 0.05;
    lo -= pad;
    hi += pad;
  }

  // X-domain: spread evenly. Using ts directly would respect real
  // sample spacing but burn pixels on idle gaps; even spacing makes
  // the line feel continuous in the ring.
  const n = vals.length;
  return vals.map((p, i) => ({
    x: (i / (n - 1)) * W.value,
    y: H.value - ((p.v - lo) / (hi - lo)) * H.value,
    v: p.v
  }));
});

const polyline = computed(() => points.value.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" "));

const fillPath = computed(() => {
  // Closed area under the line for a subtle fill. Only drawn when
  // at least 2 points exist (matches polyline visibility).
  const pts = points.value;
  if (pts.length === 0) return "";
  const first = pts[0];
  const last = pts[pts.length - 1];
  return [
    `M ${first.x.toFixed(1)},${H.value}`,
    ...pts.map((p) => `L ${p.x.toFixed(1)},${p.y.toFixed(1)}`),
    `L ${last.x.toFixed(1)},${H.value}`,
    `Z`
  ].join(" ");
});

const stroke = computed(() => props.color ?? "var(--color-primary, #4f8cff)");
</script>

<template>
  <svg
    :viewBox="`0 0 ${W} ${H}`"
    :width="W"
    :height="H"
    role="img"
    :aria-label="`telemetry sparkline (${points.length} samples)`"
    :style="{ display: 'block', overflow: 'visible' }"
  >
    <template v-if="points.length >= 2">
      <path :d="fillPath" :fill="stroke" :opacity="0.12" />
      <polyline :points="polyline" :stroke="stroke" fill="none" stroke-width="1.5" stroke-linejoin="round" />
    </template>
    <template v-else>
      <line
        :x1="0"
        :y1="H / 2"
        :x2="W"
        :y2="H / 2"
        stroke="var(--color-border)"
        stroke-dasharray="3 3"
        stroke-width="1"
      />
    </template>
  </svg>
</template>
