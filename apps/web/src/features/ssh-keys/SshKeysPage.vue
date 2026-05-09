<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { Key } from "lucide-vue-next";
import { api, type SshKey } from "../../lib/api.js";
import { useAuth } from "../../lib/useAuth.js";
import Button from "../../components/Button.vue";

const keys = ref<SshKey[]>([]);
const error = ref<string | null>(null);
const showForm = ref(false);
const form = reactive({ name: "", keyType: "uploaded" as "uploaded" | "local_path", privateKey: "", localPath: "" });
const auth = useAuth();
const canManage = computed(() => auth.value.isAdmin);

async function fetchKeys() {
  try {
    const r = await api.listSshKeys();
    keys.value = r.keys;
  } catch (e: unknown) {
    error.value = (e as Error).message;
  }
}

onMounted(fetchKeys);

async function handleCreate(ev: Event) {
  ev.preventDefault();
  try {
    await api.createSshKey({
      name: form.name,
      type: form.keyType,
      privateKey: form.keyType === "uploaded" ? form.privateKey : undefined,
      localPath: form.keyType === "local_path" ? form.localPath : undefined
    });
    await fetchKeys();
    showForm.value = false;
    form.name = "";
    form.keyType = "uploaded";
    form.privateKey = "";
    form.localPath = "";
  } catch (e: unknown) {
    error.value = (e as Error).message;
  }
}

async function handleDelete(id: string) {
  if (!confirm("Are you sure you want to delete this SSH key?")) return;
  try {
    await api.deleteSshKey(id);
    await fetchKeys();
  } catch (e: unknown) {
    error.value = (e as Error).message;
  }
}

const inputStyle = {
  display: "block",
  width: "100%",
  padding: "0.35rem 0.5rem",
  border: "1px solid var(--color-border)",
  borderRadius: "6px",
  marginTop: "0.2rem",
  boxSizing: "border-box"
} as const;
</script>

<template>
  <section>
    <div :style="{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }">
      <h2 :style="{ margin: 0 }">SSH Keys</h2>
      <Button v-if="canManage" @click="showForm = !showForm">{{ showForm ? "Cancel" : "Add Key" }}</Button>
    </div>
    <div v-if="error" :style="{ color: 'var(--color-danger)', marginBottom: '0.5rem' }">{{ error }}</div>

    <form
      v-if="canManage && showForm"
      :style="{
        background: 'var(--color-surface)',
        border: '1px solid var(--color-border)',
        borderRadius: '10px',
        padding: '1rem',
        marginBottom: '1rem',
        display: 'grid',
        gap: '1rem'
      }"
      @submit="handleCreate"
    >
      <label :style="{ display: 'block' }">
        Name
        <input v-model="form.name" required :style="inputStyle" />
      </label>
      <div :style="{ display: 'flex', gap: '1rem' }">
        <label :style="{ display: 'flex', alignItems: 'center', gap: '0.5rem' }">
          <input v-model="form.keyType" type="radio" name="keyType" value="uploaded" />
          Upload Private Key
        </label>
        <label :style="{ display: 'flex', alignItems: 'center', gap: '0.5rem' }">
          <input v-model="form.keyType" type="radio" name="keyType" value="local_path" />
          Local Path on Agent
        </label>
      </div>
      <label v-if="form.keyType === 'uploaded'" :style="{ display: 'block' }">
        Private Key (PEM format)
        <textarea
          v-model="form.privateKey"
          required
          :style="{ ...inputStyle, minHeight: '150px', fontFamily: 'monospace' }"
        />
      </label>
      <label v-if="form.keyType === 'local_path'" :style="{ display: 'block' }">
        Local Path (e.g. ~/.ssh/id_rsa)
        <input v-model="form.localPath" required :style="inputStyle" />
      </label>
      <div>
        <Button type="submit">Create Key</Button>
      </div>
    </form>

    <p v-if="keys.length === 0 && !showForm" :style="{ color: 'var(--color-text-secondary)' }">
      No SSH keys configured yet.
    </p>
    <table v-else :style="{ width: '100%', borderCollapse: 'collapse' }">
      <thead>
        <tr>
          <th
            v-for="h in ['Name', 'Type', 'Created At', '']"
            :key="h"
            :style="{
              textAlign: h === '' ? 'right' : 'left',
              padding: '0.5rem',
              borderBottom: '2px solid var(--color-border)',
              color: 'var(--color-text-secondary)',
              fontSize: '0.8rem'
            }"
          >
            {{ h }}
          </th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="k in keys" :key="k.id">
          <td :style="{ padding: '0.5rem' }">
            <span :style="{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }">
              <Key :size="14" /> {{ k.name }}
            </span>
          </td>
          <td :style="{ padding: '0.5rem', fontSize: '0.85rem' }">
            {{ k.type === "uploaded" ? "Uploaded" : "Local Path" }}
          </td>
          <td :style="{ padding: '0.5rem', fontSize: '0.85rem', color: 'var(--color-text-secondary)' }">
            {{ new Date(k.createdAt).toLocaleString() }}
          </td>
          <td :style="{ padding: '0.5rem', textAlign: 'right' }">
            <Button v-if="canManage" size="sm" variant="ghost" @click="handleDelete(k.id)">Delete</Button>
          </td>
        </tr>
      </tbody>
    </table>
  </section>
</template>
