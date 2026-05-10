<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { ChevronDown, ChevronRight, RefreshCw, Download, FileCode, Play } from "lucide-vue-next";
import { api, type ServiceBuild, type ServiceBuildArtifact } from "../../lib/api.js";
import { useAuth } from "../../lib/useAuth.js";

const props = defineProps<{
  serviceId: string;
  serviceName: string;
}>();

const auth = useAuth();
const canTrigger = computed(() => auth.value.isAdmin);
const triggering = ref(false);

type RowState = {
  build: ServiceBuild;
  expanded: boolean;
  detail: { build: ServiceBuild; artifacts: ServiceBuildArtifact[] } | null;
  detailLoading: boolean;
};

const rows = ref<RowState[]>([]);
const loading = ref(true);
const refreshing = ref(false);
const error = ref<string | null>(null);
const autoRefresh = ref(true);

let refreshTimer: ReturnType<typeof setInterval> | null = null;

async function load(opts: { silent?: boolean } = {}) {
  if (opts.silent) refreshing.value = true;
  else loading.value = true;
  error.value = null;
  try {
    const r = await api.listServiceBuilds(props.serviceId);
    // Preserve expansion state across refreshes by id.
    const prev = new Map(rows.value.map((r) => [r.build.id, r] as const));
    rows.value = r.builds.map((b): RowState => {
      const p = prev.get(b.id);
      return {
        build: b,
        expanded: p?.expanded ?? false,
        detail: p?.detail ?? null,
        detailLoading: false
      };
    });
    // Re-fetch details for rows that are expanded and either have no
    // detail yet or the build is still in flight (logs grow over time).
    for (const row of rows.value) {
      if (row.expanded && (row.detail === null || isInFlight(row.build))) {
        void loadDetail(row);
      }
    }
  } catch (e: unknown) {
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
    refreshing.value = false;
  }
}

async function loadDetail(row: RowState) {
  row.detailLoading = true;
  try {
    const r = await api.getServiceBuild(props.serviceId, row.build.id);
    row.detail = r;
    row.build = r.build;
  } catch (e: unknown) {
    error.value = (e as Error).message;
  } finally {
    row.detailLoading = false;
  }
}

function isInFlight(b: ServiceBuild): boolean {
  return b.status === "queued" || b.status === "running";
}

async function handleTrigger() {
  if (triggering.value || !canTrigger.value) return;
  const ok = window.confirm(
    `Start a new build for ${props.serviceName}?\n\n` +
      `Builds the latest commit on the watched branch. On success, ` +
      `kaiad dispatches a redeploy_service command to every bound agent.`
  );
  if (!ok) return;
  triggering.value = true;
  error.value = null;
  try {
    const r = await api.triggerServiceBuild(props.serviceId);
    // Optimistically prepend the new build so the user sees it
    // before the next refresh tick.
    rows.value = [
      {
        build: r.build,
        expanded: true,
        detail: { build: r.build, artifacts: [] },
        detailLoading: false
      },
      ...rows.value
    ];
    // Trigger a normal refresh so the row stays in sync as the
    // worker resolves the SHA and starts running.
    void load({ silent: true });
  } catch (e: unknown) {
    error.value = (e as Error).message;
  } finally {
    triggering.value = false;
  }
}

function toggle(row: RowState) {
  row.expanded = !row.expanded;
  if (row.expanded && row.detail === null) void loadDetail(row);
}

function statusColor(s: ServiceBuild["status"]): string {
  switch (s) {
    case "success":
      return "var(--color-success)";
    case "failed":
      return "var(--color-danger)";
    case "running":
      return "var(--color-info)";
    case "queued":
      return "var(--color-text-secondary)";
    case "no_pipeline":
      return "var(--color-text-secondary)";
  }
}

function statusLabel(s: ServiceBuild["status"]): string {
  return s === "no_pipeline" ? "no pipeline" : s;
}

function formatDuration(b: ServiceBuild): string {
  if (!b.startedAt) return "—";
  const start = new Date(b.startedAt).getTime();
  const end = b.finishedAt ? new Date(b.finishedAt).getTime() : Date.now();
  const sec = Math.max(0, Math.floor((end - start) / 1000));
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m${(sec % 60).toString().padStart(2, "0")}s`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${u[i]}`;
}

function downloadArtifact(buildId: string, name: string) {
  // Pull the file via fetch so we can attach the Authorization header,
  // then trigger a download from the resulting blob URL.
  const url = api.serviceBuildArtifactUrl(props.serviceId, buildId, name);
  const token = localStorage.getItem("sm_token") ?? "";
  fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    .then((r) => {
      if (!r.ok) throw new Error(`download ${r.status}`);
      return r.blob();
    })
    .then((blob) => {
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(blobUrl);
    })
    .catch((e) => {
      error.value = `Download failed: ${(e as Error).message}`;
    });
}

const hasInFlight = computed(() => rows.value.some((r) => isInFlight(r.build)));

onMounted(() => {
  void load();
  // Cheap poll: every 5s while at least one build is in flight,
  // otherwise every 30s. Cleared on unmount.
  refreshTimer = setInterval(() => {
    if (!autoRefresh.value) return;
    if (hasInFlight.value || rows.value.length === 0) {
      void load({ silent: true });
    }
  }, 5000);
});

onUnmounted(() => {
  if (refreshTimer) clearInterval(refreshTimer);
});
</script>

<template>
  <div
    :style="{
      background: 'var(--color-surface)',
      border: '1px solid var(--color-border)',
      borderRadius: '8px',
      padding: '0.75rem 1rem',
      marginTop: '0.5rem'
    }"
  >
    <div :style="{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }">
      <FileCode :size="14" />
      <strong :style="{ fontSize: '0.85rem' }">Builds</strong>
      <span :style="{ color: 'var(--color-text-secondary)', fontSize: '0.8rem' }">
        kaiad.yaml at repo root drives this. {{ rows.length }} total.
      </span>
      <div :style="{ flex: 1 }" />
      <button
        v-if="canTrigger"
        type="button"
        :disabled="triggering"
        :title="`Build the current HEAD of ${serviceName}'s watched branch and dispatch redeploy to bound agents`"
        :style="{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '0.25rem',
          padding: '0.2rem 0.55rem',
          background: 'var(--color-primary)',
          color: 'var(--color-primary-foreground)',
          border: 'none',
          borderRadius: '4px',
          fontSize: '0.75rem',
          cursor: triggering ? 'wait' : 'pointer'
        }"
        @click="handleTrigger"
      >
        <Play :size="11" />
        {{ triggering ? "Starting…" : "Start build" }}
      </button>
      <button
        type="button"
        :disabled="refreshing"
        :style="{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '0.25rem',
          padding: '0.2rem 0.5rem',
          background: 'transparent',
          border: '1px solid var(--color-border)',
          borderRadius: '4px',
          fontSize: '0.75rem',
          cursor: 'pointer',
          color: 'var(--color-text-secondary)'
        }"
        @click="load({ silent: true })"
      >
        <RefreshCw :size="11" :class="refreshing ? 'spin' : ''" /> Refresh
      </button>
    </div>

    <p v-if="error" :style="{ color: 'var(--color-danger)', margin: '0 0 0.5rem', fontSize: '0.8rem' }">
      {{ error }}
    </p>
    <p v-if="loading" :style="{ color: 'var(--color-text-secondary)', fontSize: '0.85rem', margin: 0 }">
      Loading…
    </p>
    <p
      v-else-if="rows.length === 0"
      :style="{ color: 'var(--color-text-secondary)', fontSize: '0.85rem', margin: 0 }"
    >
      No builds yet. The poller checks for new commits on
      <code>{{ serviceName }}@&lt;branch&gt;</code> every 60s and queues a build when the SHA changes.
    </p>

    <table
      v-else
      :style="{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }"
    >
      <thead>
        <tr :style="{ color: 'var(--color-text-secondary)', textAlign: 'left' }">
          <th :style="{ padding: '0.3rem 0.5rem', fontWeight: 500 }"></th>
          <th :style="{ padding: '0.3rem 0.5rem', fontWeight: 500 }">Status</th>
          <th :style="{ padding: '0.3rem 0.5rem', fontWeight: 500 }">SHA</th>
          <th :style="{ padding: '0.3rem 0.5rem', fontWeight: 500 }">Branch</th>
          <th :style="{ padding: '0.3rem 0.5rem', fontWeight: 500 }">Duration</th>
          <th :style="{ padding: '0.3rem 0.5rem', fontWeight: 500 }">Image</th>
          <th :style="{ padding: '0.3rem 0.5rem', fontWeight: 500 }">Started</th>
        </tr>
      </thead>
      <tbody>
        <template v-for="row in rows" :key="row.build.id">
          <tr
            :style="{ borderTop: '1px solid var(--color-border)', cursor: 'pointer' }"
            @click="toggle(row)"
          >
            <td :style="{ padding: '0.35rem 0.5rem' }">
              <component :is="row.expanded ? ChevronDown : ChevronRight" :size="12" />
            </td>
            <td :style="{ padding: '0.35rem 0.5rem', color: statusColor(row.build.status) }">
              ● {{ statusLabel(row.build.status) }}
              <span
                v-if="row.build.triggeredBy === 'manual'"
                :title="'Triggered manually from the panel'"
                :style="{
                  marginLeft: '0.3rem',
                  fontSize: '0.65rem',
                  padding: '0.05rem 0.3rem',
                  background: 'var(--color-bg)',
                  border: '1px solid var(--color-border)',
                  borderRadius: '3px',
                  color: 'var(--color-text-secondary)'
                }"
              >manual</span>
            </td>
            <td
              :style="{ padding: '0.35rem 0.5rem', fontFamily: 'var(--font-mono)' }"
              :title="row.build.gitSha"
            >
              {{ row.build.gitSha.slice(0, 12) }}
            </td>
            <td :style="{ padding: '0.35rem 0.5rem' }">{{ row.build.branch }}</td>
            <td :style="{ padding: '0.35rem 0.5rem' }">{{ formatDuration(row.build) }}</td>
            <td
              :style="{
                padding: '0.35rem 0.5rem',
                fontFamily: 'var(--font-mono)',
                color: 'var(--color-text-secondary)'
              }"
              :title="row.build.imageRef ?? ''"
            >
              <template v-if="row.build.imageRef">
                {{ row.build.imageRef.split("/").slice(-1)[0] }}
              </template>
              <template v-else>—</template>
            </td>
            <td
              :style="{ padding: '0.35rem 0.5rem', color: 'var(--color-text-secondary)' }"
              :title="row.build.startedAt ?? row.build.createdAt"
            >
              {{ new Date(row.build.startedAt ?? row.build.createdAt).toLocaleString() }}
            </td>
          </tr>
          <tr v-if="row.expanded">
            <td colspan="7" :style="{ padding: '0.5rem 0.5rem 0.75rem 1.5rem' }">
              <p
                v-if="row.detailLoading && !row.detail"
                :style="{ color: 'var(--color-text-secondary)', margin: 0 }"
              >
                Loading…
              </p>

              <template v-else-if="row.detail">
                <p
                  v-if="row.detail.build.failureReason"
                  :style="{
                    margin: '0 0 0.4rem',
                    color: 'var(--color-danger)',
                    fontSize: '0.85rem'
                  }"
                >
                  {{ row.detail.build.failureReason }}
                </p>

                <div
                  v-if="row.detail.artifacts.length > 0"
                  :style="{ margin: '0.25rem 0 0.5rem', fontSize: '0.8rem' }"
                >
                  <strong :style="{ color: 'var(--color-text-secondary)' }">Artifacts:</strong>
                  <span
                    v-for="art in row.detail.artifacts"
                    :key="art.name"
                    :style="{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '0.25rem',
                      marginLeft: '0.6rem',
                      padding: '0.1rem 0.4rem',
                      background: 'var(--color-bg)',
                      border: '1px solid var(--color-border)',
                      borderRadius: '4px',
                      cursor: 'pointer',
                      fontFamily: 'var(--font-mono)'
                    }"
                    @click="downloadArtifact(row.build.id, art.name)"
                  >
                    <Download :size="11" /> {{ art.name }}
                    <span :style="{ color: 'var(--color-text-secondary)' }">({{ formatBytes(art.sizeBytes) }})</span>
                  </span>
                </div>

                <details
                  v-if="row.detail.build.pipelineYaml"
                  :style="{ marginTop: '0.4rem', fontSize: '0.8rem' }"
                >
                  <summary :style="{ cursor: 'pointer', color: 'var(--color-text-secondary)' }">
                    kaiad.yaml at this commit
                  </summary>
                  <pre
                    :style="{
                      margin: '0.3rem 0 0',
                      padding: '0.5rem 0.6rem',
                      background: 'var(--color-bg)',
                      border: '1px solid var(--color-border)',
                      borderRadius: '6px',
                      overflowX: 'auto',
                      fontSize: '0.78rem'
                    }"
                  >{{ row.detail.build.pipelineYaml }}</pre>
                </details>

                <details open :style="{ marginTop: '0.4rem', fontSize: '0.8rem' }">
                  <summary :style="{ cursor: 'pointer', color: 'var(--color-text-secondary)' }">
                    Build log
                  </summary>
                  <pre
                    :style="{
                      margin: '0.3rem 0 0',
                      padding: '0.5rem 0.6rem',
                      background: '#0c0c0c',
                      color: '#e6e6e6',
                      border: '1px solid var(--color-border)',
                      borderRadius: '6px',
                      maxHeight: '320px',
                      overflow: 'auto',
                      fontSize: '0.76rem',
                      fontFamily: 'var(--font-mono)'
                    }"
                  >{{ row.detail.build.log || "(no output yet)" }}</pre>
                </details>
              </template>
            </td>
          </tr>
        </template>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.spin {
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}
</style>
