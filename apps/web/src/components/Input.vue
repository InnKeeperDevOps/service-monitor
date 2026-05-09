<script setup lang="ts">
import { computed } from "vue";
import "./components.css";

const props = defineProps<{
  modelValue?: string | number;
  label?: string;
  error?: string;
  id?: string;
  type?: string;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  autocomplete?: string;
  className?: string;
  inputMode?: "text" | "numeric" | "decimal" | "search" | "email" | "tel" | "url" | "none";
  ariaLabel?: string;
}>();

defineEmits<{ "update:modelValue": [value: string] }>();

const inputId = computed(() => {
  if (props.id) return props.id;
  if (props.label) return `sm-input-${props.label.toLowerCase().replace(/\s+/g, "-")}`;
  return undefined;
});

const cls = computed(
  () => `sm-input${props.error ? " sm-input--error" : ""}${props.className ? ` ${props.className}` : ""}`
);
</script>

<template>
  <div class="sm-input-wrapper">
    <label v-if="label" class="sm-input-label" :for="inputId">{{ label }}</label>
    <input
      :id="inputId"
      :class="cls"
      :type="type ?? 'text'"
      :value="modelValue"
      :placeholder="placeholder"
      :required="required"
      :disabled="disabled"
      :autocomplete="autocomplete"
      :inputmode="inputMode"
      :aria-label="ariaLabel"
      @input="$emit('update:modelValue', ($event.target as HTMLInputElement).value)"
    />
    <span v-if="error" class="sm-input-error">{{ error }}</span>
  </div>
</template>
