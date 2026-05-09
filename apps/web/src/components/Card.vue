<script setup lang="ts">
import { computed, type CSSProperties } from "vue";
import "./components.css";

const props = defineProps<{
  title?: string;
  className?: string;
  style?: CSSProperties;
}>();

const cls = computed(() => `sm-card${props.className ? ` ${props.className}` : ""}`);
</script>

<template>
  <div :class="cls" :style="style">
    <div v-if="title || $slots.actions" class="sm-card__header">
      <h3 v-if="title" class="sm-card__title">{{ title }}</h3>
      <div v-if="$slots.actions"><slot name="actions" /></div>
    </div>
    <slot />
  </div>
</template>
