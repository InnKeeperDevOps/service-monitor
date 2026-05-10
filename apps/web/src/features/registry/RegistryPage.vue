<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { Database, ChevronDown, ChevronRight, RefreshCw, Trash2, Copy, Check } from "lucide-vue-next";
import { api, type RegistryRepository, type RegistryTag } from "../../lib/api.js";
import { useAuth } from "../../lib/useAuth.js";
import Button from "../../components/Button.vue";
import Card from "../../components/Card.vue";
import Badge from "../../components/Badge.vue";

type RepoState = {
  name: string;
  expanded: boolean;
  loading: boolean;
  error: string | null;
  tags: RegistryTag[] | null;
  /** tag → "deleting" | "error" — UI feedback only */
  pendingTagOp: Record<string, "deleting" | "error">;
};

const auth = useAuth();
const canManage = computed(() => auth.value.isAdmin);

const repos = ref<RepoState[]>([]);
const loading = ref(true);
const refreshing = ref(false);
const error = ref<string | null>(null);
const copyState = reactive<Record<string, true>>({});
const registryHost = computed(() => window.location.host);

async function fetchRepos(opts: { silent?: boolean } = {}) {
  if (opts.silent) {
    refreshing.value = true;
  } else {
    loading.value = true;
  }
  error.value = null;
  try {
    const r = await api.listRegistryRepositories();
    // Preserve expansion state across refreshes.
    const prevByName = new Map(repos.value.map((r) => [r.name, r] as const));
    repos.value = r.repositories.map((repo: RegistryRepository): RepoState => {
      const prev = prevByName.get(repo.name);
      return {
        name: repo.name,
        expanded: prev?.expanded ?? false,
        loading: false,
        error: null,
        tags: prev?.tags ?? null,
        pendingTagOp: prev?.pendingTagOp ?? {}
      };
    });
    // If anything that was expanded got refreshed, refetch its tags.
    for (const repo of repos.value) {
      if (repo.expanded) {
        void fetchTags(repo);
      }
    }
  } catch (e: unknown) {
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
    refreshing.value = false;
  }
}

async function fetchTags(repo: RepoState) {
  repo.loading = true;
  repo.error = null;
  try {
    const r = await api.listRegistryTags(repo.name);
    repo.tags = r.tags;
  } catch (e: unknown) {
    repo.error = (e as Error).message;
  } finally {
    repo.loading = false;
  }
}

function toggle(repo: RepoState) {
  repo.expanded = !repo.expanded;
  if (repo.expanded && repo.tags === null && !repo.loading) {
    void fetchTags(repo);
  }
}

async function handleDelete(repo: RepoState, tag: RegistryTag) {
  if (!canManage.value) return;
  const ok = window.confirm(
    `Delete ${repo.name}:${tag.tag}?\n\n` +
      `This removes the manifest. Layer storage is reclaimed on the next ` +
      `\`registry garbage-collect\` run (kaiad does not run that automatically).`
  );
  if (!ok) return;
  repo.pendingTagOp[tag.tag] = "deleting";
  try {
    await api.deleteRegistryTag(repo.name, tag.tag);
    repo.tags = (repo.tags ?? []).filter((t) => t.tag !== tag.tag);
    delete repo.pendingTagOp[tag.tag];
  } catch (e: unknown) {
    repo.pendingTagOp[tag.tag] = "error";
    repo.error = (e as Error).message;
  }
}

function pullCommand(repo: RepoState, tag: RegistryTag): string {
  return `docker pull ${registryHost.value}/${repo.name}:${tag.tag}`;
}

async function copyToClipboard(key: string, text: string) {
  try {
    await navigator.clipboard.writeText(text);
    copyState[key] = true;
    setTimeout(() => {
      delete copyState[key];
    }, 1200);
  } catch {
    /* clipboard blocked — silent */
  }
}

function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

function shortDigest(digest: string | undefined): string {
  if (!digest) return "—";
  // sha256:abcdef…12 chars
  const idx = digest.indexOf(":");
  return idx >= 0 ? digest.slice(idx + 1, idx + 13) : digest.slice(0, 12);
}

function formatRelative(iso: string | undefined): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const deltaSec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (deltaSec < 60) return `${deltaSec}s ago`;
  if (deltaSec < 3600) return `${Math.floor(deltaSec / 60)}m ago`;
  if (deltaSec < 86_400) return `${Math.floor(deltaSec / 3600)}h ago`;
  return `${Math.floor(deltaSec / 86_400)}d ago`;
}

onMounted(() => {
  void fetchRepos();
});
</script>

<template>
  <div :style="{ maxWidth: '1100px' }">
    <header
      :style="{
        display: 'flex',
        alignItems: 'center',
        gap: '0.75rem',
        marginBottom: '0.75rem'
      }"
    >
      <Database :size="22" />
      <h2 :style="{ margin: 0 }">Registry</h2>
      <Badge variant="muted">{{ registryHost }}</Badge>
      <div :style="{ flex: 1 }" />
      <Button
        variant="ghost"
        :disabled="refreshing"
        @click="fetchRepos({ silent: true })"
      >
        <RefreshCw :size="14" :class="refreshing ? 'spin' : ''" /> Refresh
      </Button>
    </header>

    <p :style="{ color: 'var(--color-text-secondary)', marginTop: 0, fontSize: '0.85rem' }">
      OCI images hosted by this Kaiad. Admins can pull/push any repository here;
      enrollment tokens can pull (used by KaiadAgent <code>imagePullSecrets</code>).
    </p>

    <Card v-if="error" :style="{ borderColor: 'var(--color-danger)', marginBottom: '1rem' }">
      <p :style="{ color: 'var(--color-danger)', margin: 0 }">{{ error }}</p>
    </Card>

    <p v-if="loading" :style="{ color: 'var(--color-text-secondary)' }">Loading repositories…</p>

    <Card v-else-if="repos.length === 0">
      <p :style="{ margin: 0, color: 'var(--color-text-secondary)' }">
        No images pushed yet. The bundled <code>kaiad-agent</code> image is pushed automatically
        on first boot — if it's not here, check the kaiad container's <code>/tmp/push-agent.log</code>.
      </p>
    </Card>

    <Card v-else :style="{ padding: 0 }">
      <ul :style="{ listStyle: 'none', margin: 0, padding: 0 }">
        <li
          v-for="repo in repos"
          :key="repo.name"
          :style="{ borderBottom: '1px solid var(--color-border)' }"
        >
          <button
            type="button"
            :style="{
              width: '100%',
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              padding: '0.65rem 0.9rem',
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              textAlign: 'left',
              color: 'var(--color-text)',
              fontSize: '0.95rem'
            }"
            @click="toggle(repo)"
          >
            <component :is="repo.expanded ? ChevronDown : ChevronRight" :size="14" />
            <strong>{{ repo.name }}</strong>
            <Badge v-if="repo.tags" variant="muted" :style="{ marginLeft: '0.4rem' }">
              {{ repo.tags.length }} {{ repo.tags.length === 1 ? "tag" : "tags" }}
            </Badge>
          </button>

          <div v-if="repo.expanded" :style="{ padding: '0 0.9rem 0.75rem 1.6rem' }">
            <p
              v-if="repo.loading"
              :style="{ color: 'var(--color-text-secondary)', margin: '0.25rem 0' }"
            >
              Loading tags…
            </p>
            <p
              v-else-if="repo.error"
              :style="{ color: 'var(--color-danger)', margin: '0.25rem 0' }"
            >
              {{ repo.error }}
            </p>
            <p
              v-else-if="!repo.tags || repo.tags.length === 0"
              :style="{ color: 'var(--color-text-secondary)', margin: '0.25rem 0' }"
            >
              No tags.
            </p>
            <table
              v-else
              :style="{
                width: '100%',
                borderCollapse: 'collapse',
                fontSize: '0.85rem'
              }"
            >
              <thead>
                <tr :style="{ color: 'var(--color-text-secondary)', textAlign: 'left' }">
                  <th :style="{ padding: '0.4rem 0.5rem', fontWeight: 500 }">Tag</th>
                  <th :style="{ padding: '0.4rem 0.5rem', fontWeight: 500 }">Digest</th>
                  <th :style="{ padding: '0.4rem 0.5rem', fontWeight: 500 }">Size</th>
                  <th :style="{ padding: '0.4rem 0.5rem', fontWeight: 500 }">Created</th>
                  <th :style="{ padding: '0.4rem 0.5rem', fontWeight: 500 }">Pull</th>
                  <th
                    v-if="canManage"
                    :style="{ padding: '0.4rem 0.5rem', fontWeight: 500, width: '4rem' }"
                  ></th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="tag in repo.tags"
                  :key="tag.tag"
                  :style="{ borderTop: '1px solid var(--color-border)' }"
                >
                  <td :style="{ padding: '0.45rem 0.5rem', fontFamily: 'var(--font-mono)' }">
                    {{ tag.tag }}
                  </td>
                  <td
                    :style="{
                      padding: '0.45rem 0.5rem',
                      fontFamily: 'var(--font-mono)',
                      color: 'var(--color-text-secondary)'
                    }"
                    :title="tag.digest"
                  >
                    {{ shortDigest(tag.digest) }}
                  </td>
                  <td :style="{ padding: '0.45rem 0.5rem' }">{{ formatBytes(tag.sizeBytes) }}</td>
                  <td
                    :style="{ padding: '0.45rem 0.5rem' }"
                    :title="tag.createdAt"
                  >
                    {{ formatRelative(tag.createdAt) }}
                  </td>
                  <td :style="{ padding: '0.45rem 0.5rem' }">
                    <button
                      type="button"
                      :style="{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '0.3rem',
                        padding: '0.15rem 0.4rem',
                        background: 'transparent',
                        border: '1px solid var(--color-border)',
                        borderRadius: '3px',
                        fontSize: '0.75rem',
                        cursor: 'pointer',
                        color: 'var(--color-text-secondary)'
                      }"
                      :title="pullCommand(repo, tag)"
                      @click="copyToClipboard(`${repo.name}:${tag.tag}`, pullCommand(repo, tag))"
                    >
                      <component
                        :is="copyState[`${repo.name}:${tag.tag}`] ? Check : Copy"
                        :size="11"
                      />
                      {{ copyState[`${repo.name}:${tag.tag}`] ? "copied" : "copy" }}
                    </button>
                  </td>
                  <td v-if="canManage" :style="{ padding: '0.45rem 0.5rem', textAlign: 'right' }">
                    <button
                      type="button"
                      :disabled="repo.pendingTagOp[tag.tag] === 'deleting'"
                      :style="{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '0.3rem',
                        padding: '0.2rem 0.45rem',
                        background: 'transparent',
                        border: '1px solid var(--color-border)',
                        borderRadius: '3px',
                        fontSize: '0.75rem',
                        cursor: repo.pendingTagOp[tag.tag] === 'deleting' ? 'wait' : 'pointer',
                        color:
                          repo.pendingTagOp[tag.tag] === 'error'
                            ? 'var(--color-danger)'
                            : 'var(--color-text-secondary)'
                      }"
                      @click="handleDelete(repo, tag)"
                    >
                      <Trash2 :size="11" />
                      {{
                        repo.pendingTagOp[tag.tag] === "deleting"
                          ? "deleting…"
                          : repo.pendingTagOp[tag.tag] === "error"
                            ? "retry"
                            : "delete"
                      }}
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </li>
      </ul>
    </Card>
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
