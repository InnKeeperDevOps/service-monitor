<script setup lang="ts">
import { computed } from "vue";
import "./components.css";

const props = withDefaults(
  defineProps<{
    variant?: "primary" | "secondary" | "danger" | "ghost";
    size?: "sm" | "md";
    loading?: boolean;
    disabled?: boolean;
    type?: "button" | "submit" | "reset";
    className?: string;
  }>(),
  { variant: "primary", size: "md", loading: false, disabled: false, type: "button" }
);

const cls = computed(
  () => `sm-btn sm-btn--${props.variant} sm-btn--${props.size}${props.className ? ` ${props.className}` : ""}`
);
</script>

<template>
  <button
    :type="type"
    :class="cls"
    :disabled="disabled || loading"
    :aria-busy="loading || undefined"
  >
    <template v-if="loading">Loading…</template>
    <slot v-else />
  </button>
</template>
