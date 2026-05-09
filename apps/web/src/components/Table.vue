<script setup lang="ts" generic="T">
import "./components.css";

defineProps<{
  columns: { key: string; label: string }[];
  rows: T[];
  emptyMessage?: string;
  rowKey?: (row: T) => string;
}>();
</script>

<template>
  <table class="sm-table">
    <thead>
      <tr>
        <th v-for="col in columns" :key="col.key">{{ col.label }}</th>
      </tr>
    </thead>
    <tbody>
      <tr v-if="rows.length === 0">
        <td :colspan="columns.length" class="sm-table__empty">
          {{ emptyMessage ?? "No data." }}
        </td>
      </tr>
      <template v-else>
        <tr v-for="(row, i) in rows" :key="rowKey ? rowKey(row) : i">
          <td v-for="col in columns" :key="col.key">
            <slot :name="`cell-${col.key}`" :row="row">
              {{ String((row as Record<string, unknown>)[col.key] ?? "") }}
            </slot>
          </td>
        </tr>
      </template>
    </tbody>
  </table>
