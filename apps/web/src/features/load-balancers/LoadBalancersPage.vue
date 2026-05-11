<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { Network, RefreshCw, Globe } from "lucide-vue-next";
import { api, type LoadBalancerEntry } from "../../lib/api.js";
import Card from "../../components/Card.vue";
import Badge from "../../components/Badge.vue";

const entries = ref<LoadBalancerEntry[]>([]);
const loading = ref(true);
const refreshing = ref(false);
const error = ref<string | null>(null);

async function load(opts: { silent?: boolean } = {}) {
  if (opts.silent) refreshing.value = true;
  else loading.value = true;
  error.value = null;
  try {
    const r = await api.listLoadBalancers();
    entries.value = r.entries;
  } catch (e: unknown) {
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
    refreshing.value = false;
  }
}

onMounted(() => {
  void load();
});

// Group entries by external endpoint (IP or hostname) so the page
// shows one row per (LB, domain) — that's how an operator wants to
// reason about it: "what reaches what?".
type FlatRow = {
  externalEndpoint: string;
  externalKind: "ip" | "hostname" | "pending" | "internal";
  serviceName: string;
  serviceId: string;
  /** Reporting agent's runtime backend ("docker"|"kubernetes"|"shell"|null). */
  agentRuntime: LoadBalancerEntry["agentRuntime"];
  environment: string;
  namespace: string;
  lbType: LoadBalancerEntry["lbType"];
  domain: string;
  port: number;
  protocol: "http" | "https";
  detailLabel: string;
  observedAt: string;
};

function formatRuntime(rt: LoadBalancerEntry["agentRuntime"]): string {
  if (rt == null) return "unknown";
  if (rt === "kubernetes") return "k8s";
  return rt;
}

const rows = computed<FlatRow[]>(() => {
  const out: FlatRow[] = [];
  for (const e of entries.value) {
    const endpoint =
      e.externalIp ?? e.externalHostname ?? (e.lbType === "none" ? "(cluster-internal)" : "(pending)");
    const kind: FlatRow["externalKind"] = e.externalIp
      ? "ip"
      : e.externalHostname
        ? "hostname"
        : e.lbType === "none"
          ? "internal"
          : "pending";
    const detailLabel = lbDetailLabel(e);
    if (e.domains.length === 0) {
      out.push({
        externalEndpoint: endpoint,
        externalKind: kind,
        serviceName: e.serviceName,
        serviceId: e.serviceId,
        agentRuntime: e.agentRuntime,
        environment: e.environment,
        namespace: e.namespace,
        lbType: e.lbType,
        domain: "—",
        port: e.ports[0]?.port ?? 0,
        protocol: "http",
        detailLabel,
        observedAt: e.observedAt
      });
    } else {
      for (const d of e.domains) {
        out.push({
          externalEndpoint: endpoint,
          externalKind: kind,
          serviceName: e.serviceName,
          serviceId: e.serviceId,
          agentRuntime: e.agentRuntime,
          environment: e.environment,
          namespace: e.namespace,
          lbType: e.lbType,
          domain: d.host,
          port: d.port,
          protocol: d.protocol,
          detailLabel,
          observedAt: e.observedAt
        });
      }
    }
  }
  return out;
});

function lbDetailLabel(e: LoadBalancerEntry): string {
  switch (e.lbType) {
    case "metallb": {
      const pool = (e.detail.addressPool as string | undefined) ?? "";
      return pool ? `metallb (pool: ${pool})` : "metallb";
    }
    case "nginx": {
      const cls = (e.detail.ingressClass as string | undefined) ?? "nginx";
      const tls = e.detail.tlsSecret ? ` · tls: ${e.detail.tlsSecret}` : "";
      return `ingress-nginx (${cls})${tls}`;
    }
    case "k8s":
      return "k8s LoadBalancer";
    case "none":
      return "cluster-internal only";
  }
}

function formatRelative(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const sec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86_400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86_400)}d ago`;
}

function endpointColor(kind: FlatRow["externalKind"]): string {
  switch (kind) {
    case "ip":
    case "hostname":
      return "var(--color-success)";
    case "pending":
      return "var(--color-warning)";
    case "internal":
      return "var(--color-text-secondary)";
  }
}
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
      <Network :size="22" />
      <h2 :style="{ margin: 0 }">Load Balancers</h2>
      <Badge variant="muted">{{ entries.length }} reported</Badge>
      <div :style="{ flex: 1 }" />
      <button
        type="button"
        :disabled="refreshing"
        :style="{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '0.25rem',
          padding: '0.25rem 0.55rem',
          background: 'transparent',
          border: '1px solid var(--color-border)',
          borderRadius: '4px',
          fontSize: '0.78rem',
          cursor: refreshing ? 'wait' : 'pointer',
          color: 'var(--color-text-secondary)'
        }"
        @click="load({ silent: true })"
      >
        <RefreshCw :size="11" :class="refreshing ? 'spin' : ''" /> Refresh
      </button>
    </header>

    <p :style="{ color: 'var(--color-text-secondary)', marginTop: 0, fontSize: '0.85rem' }">
      Domains routed to each service's external endpoint. Reported by bound agents after every
      successful redeploy. <em>Pending</em> means the cluster has not yet assigned an IP (MetalLB
      address pool exhausted, cloud LB still provisioning, etc).
    </p>

    <Card v-if="error" :style="{ borderColor: 'var(--color-danger)', marginBottom: '1rem' }">
      <p :style="{ color: 'var(--color-danger)', margin: 0 }">{{ error }}</p>
    </Card>

    <p v-if="loading" :style="{ color: 'var(--color-text-secondary)' }">Loading…</p>

    <Card v-else-if="rows.length === 0">
      <p :style="{ margin: 0, color: 'var(--color-text-secondary)' }">
        No load-balancer reports yet. Trigger a manual build for a service whose
        <code>kaiad.yaml</code> declares a non-<code>none</code> <code>loadBalancer.type</code>;
        once the agent applies the manifests it will report the assigned IP back here.
      </p>
    </Card>

    <Card v-else :style="{ padding: 0 }">
      <table
        :style="{
          width: '100%',
          borderCollapse: 'collapse',
          fontSize: '0.85rem'
        }"
      >
        <thead>
          <tr :style="{ color: 'var(--color-text-secondary)', textAlign: 'left' }">
            <th :style="{ padding: '0.5rem 0.75rem', fontWeight: 500 }">Domain</th>
            <th :style="{ padding: '0.5rem 0.75rem', fontWeight: 500 }">External endpoint</th>
            <th :style="{ padding: '0.5rem 0.75rem', fontWeight: 500 }">Port</th>
            <th :style="{ padding: '0.5rem 0.75rem', fontWeight: 500 }">Service</th>
            <th :style="{ padding: '0.5rem 0.75rem', fontWeight: 500 }">Runtime</th>
            <th :style="{ padding: '0.5rem 0.75rem', fontWeight: 500 }">Env</th>
            <th :style="{ padding: '0.5rem 0.75rem', fontWeight: 500 }">Namespace</th>
            <th :style="{ padding: '0.5rem 0.75rem', fontWeight: 500 }">LB</th>
            <th :style="{ padding: '0.5rem 0.75rem', fontWeight: 500 }">Observed</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(r, i) in rows"
            :key="`${r.serviceId}-${r.environment}-${r.domain}-${i}`"
            :style="{ borderTop: '1px solid var(--color-border)' }"
          >
            <td :style="{ padding: '0.45rem 0.75rem' }">
              <span
                :style="{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.3rem',
                  fontFamily: 'var(--font-mono)'
                }"
              >
                <Globe v-if="r.domain !== '—'" :size="11" />
                <span>{{ r.protocol === "https" ? "https://" : "http://" }}{{ r.domain }}</span>
              </span>
            </td>
            <td
              :style="{
                padding: '0.45rem 0.75rem',
                fontFamily: 'var(--font-mono)',
                color: endpointColor(r.externalKind)
              }"
            >
              {{ r.externalEndpoint }}
            </td>
            <td :style="{ padding: '0.45rem 0.75rem', fontFamily: 'var(--font-mono)' }">
              {{ r.port || "—" }}
            </td>
            <td :style="{ padding: '0.45rem 0.75rem' }">{{ r.serviceName }}</td>
            <td :style="{ padding: '0.45rem 0.75rem' }">
              <Badge variant="muted">{{ formatRuntime(r.agentRuntime) }}</Badge>
            </td>
            <td :style="{ padding: '0.45rem 0.75rem' }">
              <Badge variant="muted">{{ r.environment }}</Badge>
            </td>
            <td
              :style="{
                padding: '0.45rem 0.75rem',
                fontFamily: 'var(--font-mono)',
                color: 'var(--color-text-secondary)'
              }"
            >
              {{ r.namespace || "—" }}
            </td>
            <td
              :style="{ padding: '0.45rem 0.75rem', color: 'var(--color-text-secondary)' }"
              :title="r.detailLabel"
            >
              {{ r.lbType }}
            </td>
            <td
              :style="{ padding: '0.45rem 0.75rem', color: 'var(--color-text-secondary)' }"
              :title="r.observedAt"
            >
              {{ formatRelative(r.observedAt) }}
            </td>
          </tr>
        </tbody>
      </table>
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
