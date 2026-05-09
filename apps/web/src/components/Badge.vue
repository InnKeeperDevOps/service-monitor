<script setup lang="ts">
import "./components.css";
defineProps<{ variant: "success" | "warning" | "danger" | "info" | "muted" }>();
</script>

<template>
  <span :class="`sm-badge sm-badge--${variant}`">
    <slot />
  </span>
</template>
