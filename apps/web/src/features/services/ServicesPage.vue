<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { Box } from "lucide-vue-next";
import { api, type Agent, type MonitoredService, type SshKey } from "../../lib/api.js";
import { useAuth } from "../../lib/useAuth.js";
import BuildsForServiceSection from "./BuildsForServiceSection.vue";

type ServiceForm = {
  name: string;
  gitRepoUrl: string;
  sshKeyId: string;
  branch: string;
  dockerImage: string;
  composePath: string;
  agentIds: string[];
};

const emptyForm = (): ServiceForm => ({
  name: "",
  gitRepoUrl: "",
  sshKeyId: "",
  branch: "main",
  dockerImage: "",
  composePath: "",
  agentIds: []
});

const services = ref<MonitoredService[]>([]);
const sshKeys = ref<SshKey[]>([]);
const agents = ref<Agent[]>([]);
const error = ref<string | null>(null);
const showForm = ref(false);
const editingId = ref<string | null>(null);
const form = reactive<ServiceForm>(emptyForm());

const auth = useAuth();
const canManage = computed(() => auth.value.isAdmin);

onMounted(async () => {
  try {
    const r = await api.listServices();
    services.value = r.services;
  } catch (e: unknown) {
    error.value = (e as Error).message;
  }
  try {
    const r = await api.listSshKeys();
    sshKeys.value = r.keys;
  } catch {
    /* ignore */
  }
  try {
    const r = await api.listAgents();
    agents.value = r.agents;
  } catch {
    /* ignore */
  }
});

function resetForm() {
  Object.assign(form, emptyForm());
}

function toggleAgent(agentId: string) {
  if (form.agentIds.includes(agentId)) {
    form.agentIds = form.agentIds.filter((a) => a !== agentId);
  } else {
    form.agentIds = [...form.agentIds, agentId];
  }
}

async function handleSubmit(ev: Event) {
  ev.preventDefault();
  try {
    if (editingId.value) {
      const svc = await api.updateService(editingId.value, {
        name: form.name,
        gitRepoUrl: form.gitRepoUrl,
        sshKeyId: form.sshKeyId || null,
        branch: form.branch,
        dockerImage: form.dockerImage.trim() || undefined,
        composePath: form.composePath.trim() || undefined,
        agentIds: form.agentIds
      });
      services.value = services.value.map((s) => (s.id === editingId.value ? svc : s));
    } else {
      const svc = await api.createService({
        name: form.name,
        gitRepoUrl: form.gitRepoUrl,
        sshKeyId: form.sshKeyId || undefined,
        branch: form.branch,
        dockerImage: form.dockerImage.trim() || undefined,
        composePath: form.composePath.trim() || undefined,
        agentIds: form.agentIds
      });
      services.value = [...services.value, svc];
    }
    showForm.value = false;
    editingId.value = null;
    resetForm();
  } catch (e: unknown) {
    error.value = (e as Error).message;
  }
}

function handleEdit(svc: MonitoredService) {
  form.name = svc.name;
  form.gitRepoUrl = svc.gitRepoUrl;
  form.sshKeyId = svc.sshKeyId || "";
  form.branch = svc.branch;
  form.dockerImage = svc.dockerImage || "";
  form.composePath = svc.composePath || "";
  form.agentIds = (svc.agents ?? []).map((b) => b.agentId);
  editingId.value = svc.id;
  showForm.value = true;
}

async function handleDelete(svc: MonitoredService) {
  if (!window.confirm(`Delete service "${svc.name}"? This will also remove its runs and incidents.`)) return;
  try {
    await api.deleteService(svc.id);
    services.value = services.value.filter((s) => s.id !== svc.id);
    if (editingId.value === svc.id) {
      editingId.value = null;
      showForm.value = false;
      resetForm();
    }
  } catch (e: unknown) {
    error.value = (e as Error).message;
  }
}

function renderAgents(svc: MonitoredService): string {
  const ids = (svc.agents ?? []).map((b) => b.agentId);
  if (ids.length === 0) return "—";
  return ids.join(", ");
}

const primaryBtn = {
  background: "var(--color-primary)",
  color: "var(--color-primary-foreground)",
  border: "none",
  borderRadius: "8px",
  padding: "0.4rem 0.75rem",
  cursor: "pointer",
  fontSize: "0.85rem"
};

const inputStyle = {
  display: "block",
  width: "100%",
  padding: "0.35rem 0.5rem",
  border: "1px solid var(--color-border)",
  borderRadius: "6px",
  marginTop: "0.2rem",
  boxSizing: "border-box"
} as const;

const noKey = computed(() => services.value.some((s) => !s.sshKeyId));

// Set of service IDs whose Builds row is expanded.
const buildsOpen = ref<Set<string>>(new Set());

function toggleBuilds(id: string) {
  const next = new Set(buildsOpen.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  buildsOpen.value = next;
}
</script>

<template>
  <section>
    <div :style="{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }">
      <h2 :style="{ margin: 0 }">Monitored Services</h2>
      <button
        v-if="canManage"
        :style="primaryBtn"
        @click="
          showForm = !showForm;
          editingId = null;
          resetForm();
        "
      >
        {{ showForm ? "Cancel" : "Add Service" }}
      </button>
    </div>

    <div v-if="error" :style="{ color: 'var(--color-danger)', marginBottom: '0.5rem' }">{{ error }}</div>

    <div
      v-if="noKey"
      role="status"
      :style="{
        background: 'color-mix(in srgb, var(--color-warning) 12%, var(--color-surface))',
        border: '1px solid var(--color-warning)',
        borderRadius: '8px',
        padding: '0.6rem 0.75rem',
        marginBottom: '1rem',
        fontSize: '0.85rem',
        color: 'var(--color-text-primary)'
      }"
    >
      <strong>Auto-fix is disabled for some services.</strong> Services without an SSH key can still be monitored,
      but Kaiad cannot push fix commits to their repos. Edit the service and assign an SSH key to enable the
      automated error → fix loop.
    </div>

    <form
      v-if="canManage && showForm"
      :style="{
        background: 'var(--color-surface)',
        border: '1px solid var(--color-border)',
        borderRadius: '10px',
        padding: '1rem',
        marginBottom: '1rem',
        display: 'grid',
        gap: '0.5rem'
      }"
      @submit="handleSubmit"
    >
      <label>
        Name
        <input v-model="form.name" required :style="inputStyle" />
      </label>
      <label>
        Git Repository URL
        <input
          v-model="form.gitRepoUrl"
          required
          placeholder="e.g. git@github.com:acme/app.git"
          :style="inputStyle"
        />
      </label>
      <label>
        SSH Key
        <span :style="{ color: 'var(--color-text-secondary)', fontSize: '0.8rem' }">(required if SSH URL)</span>
        <select v-model="form.sshKeyId" :style="{ ...inputStyle, background: 'var(--color-surface)' }">
          <option value="">— None (HTTPS public) —</option>
          <option v-for="k in sshKeys" :key="k.id" :value="k.id">{{ k.name }}</option>
        </select>
      </label>
      <label>
        Branch
        <input v-model="form.branch" required :style="inputStyle" />
      </label>
      <label>
        Docker Image
        <span :style="{ color: 'var(--color-text-secondary)', fontSize: '0.8rem' }">(optional)</span>
        <input v-model="form.dockerImage" placeholder="e.g. myorg/myapp:latest" :style="inputStyle" />
      </label>
      <label>
        Compose Path
        <span :style="{ color: 'var(--color-text-secondary)', fontSize: '0.8rem' }">(optional)</span>
        <input v-model="form.composePath" placeholder="e.g. docker-compose.yml" :style="inputStyle" />
      </label>
      <fieldset
        :style="{
          border: '1px solid var(--color-border)',
          borderRadius: '6px',
          padding: '0.5rem 0.75rem'
        }"
      >
        <legend :style="{ padding: '0 0.4rem', fontSize: '0.8rem', color: 'var(--color-text-secondary)' }">
          Bound agents <span>(many-to-many; pick zero or more)</span>
        </legend>
        <p
          v-if="agents.length === 0"
          :style="{ margin: 0, color: 'var(--color-text-secondary)', fontSize: '0.82rem' }"
        >
          No agents enrolled yet. Bind agents from the Agents page after they appear.
        </p>
        <div v-else :style="{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem 1rem' }">
          <label
            v-for="a in agents"
            :key="a.id"
            :style="{ display: 'inline-flex', gap: '0.3rem', alignItems: 'center', fontSize: '0.85rem' }"
          >
            <input
              type="checkbox"
              :checked="form.agentIds.includes(a.id)"
              @change="toggleAgent(a.id)"
            />
            {{ a.name?.trim() || a.id }}
          </label>
        </div>
      </fieldset>
      <button type="submit" :style="primaryBtn">{{ editingId ? "Save Changes" : "Create" }}</button>
    </form>

    <p v-if="services.length === 0 && !showForm" :style="{ color: 'var(--color-text-secondary)' }">
      No services configured yet.
    </p>

    <table v-else :style="{ width: '100%', borderCollapse: 'collapse' }">
      <thead>
        <tr>
          <th
            v-for="h in ['Name', 'Repository', 'Branch', 'Agents', 'Detectors', 'Actions']"
            :key="h"
            :style="{
              textAlign: 'left',
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
        <template v-for="(svc, idx) in services" :key="svc.id || idx">
        <tr>
          <td :style="{ padding: '0.5rem' }">
            <span :style="{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }">
              <Box :size="14" /> {{ svc.name }}
            </span>
          </td>
          <td :style="{ padding: '0.5rem', fontSize: '0.85rem' }">{{ svc.gitRepoUrl }}</td>
          <td :style="{ padding: '0.5rem', fontSize: '0.85rem' }">{{ svc.branch }}</td>
          <td :style="{ padding: '0.5rem', fontSize: '0.85rem', color: 'var(--color-text-secondary)' }">
            {{ renderAgents(svc) }}
          </td>
          <td :style="{ padding: '0.5rem', fontSize: '0.85rem', color: 'var(--color-text-secondary)' }">Default</td>
          <td :style="{ padding: '0.5rem', fontSize: '0.85rem' }">
            <div :style="{ display: 'inline-flex', gap: '0.3rem' }">
              <button
                :style="{
                  background: buildsOpen.has(svc.id)
                    ? 'var(--color-bg)'
                    : 'var(--color-surface)',
                  border: '1px solid var(--color-border)',
                  padding: '0.2rem 0.5rem',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  fontSize: '0.8rem',
                  color: 'var(--color-text-primary)'
                }"
                @click="toggleBuilds(svc.id)"
              >{{ buildsOpen.has(svc.id) ? 'Hide builds' : 'Builds' }}</button>
              <template v-if="canManage">
                <button
                  :style="{
                    background: 'var(--color-surface)',
                    border: '1px solid var(--color-border)',
                    padding: '0.2rem 0.5rem',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    fontSize: '0.8rem',
                    color: 'var(--color-text-primary)'
                  }"
                  @click="handleEdit(svc)"
                >Edit</button>
                <button
                  :style="{
                    background: 'var(--color-surface)',
                    border: '1px solid var(--color-border)',
                    padding: '0.2rem 0.5rem',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    fontSize: '0.8rem',
                    color: 'var(--color-danger)'
                  }"
                  @click="handleDelete(svc)"
                >Delete</button>
              </template>
            </div>
          </td>
        </tr>
        <tr v-if="buildsOpen.has(svc.id)">
          <td colspan="6" :style="{ padding: '0 0.5rem 0.5rem' }">
            <BuildsForServiceSection :service-id="svc.id" :service-name="svc.name" />
          </td>
        </tr>
        </template>
      </tbody>
    </table>
  </section>
</template>
