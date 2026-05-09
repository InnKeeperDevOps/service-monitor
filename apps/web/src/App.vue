<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, type Component, type CSSProperties } from "vue";
import {
  AlertTriangle,
  Box,
  Building2,
  Cpu,
  Key,
  LayoutDashboard,
  LogOut,
  Settings
} from "lucide-vue-next";
import "./tokens.css";
import { api, meResponseToAuthUser } from "./lib/api.js";
import { provideAuth, buildAuthState, type AuthUser } from "./lib/useAuth.js";
import TenantSwitcher from "./components/TenantSwitcher.vue";
import DashboardPage from "./features/dashboard/DashboardPage.vue";
import IncidentsPage from "./features/incidents/IncidentsPage.vue";
import AgentsPage from "./features/agents/AgentsPage.vue";
import ServicesPage from "./features/services/ServicesPage.vue";
import SshKeysPage from "./features/ssh-keys/SshKeysPage.vue";
import TenantsPage from "./features/tenants/TenantsPage.vue";
import SettingsPage from "./features/settings/SettingsPage.vue";
import TenantConfigurationPage from "./features/tenants/TenantConfigurationPage.vue";
import LoginPage from "./features/auth/LoginPage.vue";
import SetupWizardPage from "./features/setup/SetupWizardPage.vue";

type Route =
  | "dashboard"
  | "incidents"
  | "agents"
  | "services"
  | "sshKeys"
  | "settings"
  | "tenants"
  | "tenantConfig"
  | "login";

const NAV_ITEMS: { route: Route; label: string; icon: Component; adminOnly?: boolean }[] = [
  { route: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { route: "agents", label: "Agents", icon: Cpu },
  { route: "services", label: "Services", icon: Box },
  { route: "incidents", label: "Incidents", icon: AlertTriangle },
  { route: "sshKeys", label: "SSH Keys", icon: Key },
  { route: "tenants", label: "Tenants", icon: Building2, adminOnly: true },
  { route: "settings", label: "Settings", icon: Settings, adminOnly: true }
];

function readNavFromHash(): { route: Route; tenantConfigTenantId: string | null } {
  const raw = window.location.hash.replace(/^#/, "").split("?")[0];
  if (raw.startsWith("tenant-config/")) {
    const id = decodeURIComponent(raw.slice("tenant-config/".length).trim());
    return { route: "tenantConfig", tenantConfigTenantId: id || null };
  }
  const base = (raw.split("/")[0] || "dashboard") as Route;
  const allowed: Route[] = [
    "dashboard",
    "incidents",
    "agents",
    "services",
    "sshKeys",
    "settings",
    "tenants",
    "login"
  ];
  if (allowed.includes(base)) {
    return { route: base, tenantConfigTenantId: null };
  }
  return { route: "dashboard", tenantConfigTenantId: null };
}

function hasToken(): boolean {
  return Boolean(localStorage.getItem("sm_token"));
}

const setupStatus = ref<boolean | null>(null);
const route = ref<Route>(hasToken() ? readNavFromHash().route : "login");
const tenantConfigTenantId = ref<string | null>(hasToken() ? readNavFromHash().tenantConfigTenantId : null);
const user = ref<AuthUser | null>(null);
const meResolved = ref(false);

provideAuth(user);

const authState = computed(() => buildAuthState(user.value));

const visibleNav = computed(() => NAV_ITEMS.filter((item) => !(item.adminOnly && authState.value.isViewer)));

async function loadSetupStatus() {
  try {
    const res = await api.getSetupStatus();
    setupStatus.value = res.setupRequired;
  } catch {
    setupStatus.value = false;
  }
}

async function loadMe() {
  if (!hasToken()) {
    meResolved.value = true;
    return;
  }
  try {
    const m = await api.me();
    user.value = meResponseToAuthUser(m);
  } catch (err) {
    console.error("[app] GET /api/v1/me failed", err);
  } finally {
    meResolved.value = true;
  }
}

function onHashChange() {
  if (!hasToken()) {
    window.location.hash = "login";
    route.value = "login";
    tenantConfigTenantId.value = null;
    return;
  }
  const nav = readNavFromHash();
  route.value = nav.route;
  tenantConfigTenantId.value = nav.tenantConfigTenantId;
}

function handleTenantSwitch(u: AuthUser) {
  user.value = u;
  if (route.value === "tenantConfig" && tenantConfigTenantId.value && tenantConfigTenantId.value !== u.tenantId) {
    window.location.hash = `tenant-config/${encodeURIComponent(u.tenantId)}`;
  }
}

function logout() {
  api.logout();
}

function isActive(itemRoute: Route): boolean {
  return route.value === itemRoute || (itemRoute === "tenants" && route.value === "tenantConfig");
}

onMounted(() => {
  void loadSetupStatus();
  void loadMe();
  window.addEventListener("hashchange", onHashChange);
});
onUnmounted(() => {
  window.removeEventListener("hashchange", onHashChange);
});

const docsUrl = (import.meta.env.VITE_DOCS_URL as string | undefined) ?? "";

const navStyle: CSSProperties = {
  background: "var(--color-nav-bg)",
  padding: "1rem 0",
  display: "flex",
  flexDirection: "column",
  gap: "0.15rem"
};
</script>

<template>
  <div
    v-if="setupStatus === null"
    :style="{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh' }"
  >
    <p :style="{ color: 'var(--color-text-secondary)' }">Loading…</p>
  </div>

  <SetupWizardPage v-else-if="setupStatus" />

  <LoginPage v-else-if="route === 'login'" />

  <div v-else :style="{ display: 'grid', gridTemplateColumns: '220px 1fr', minHeight: '100vh' }">
    <nav :style="navStyle">
      <div
        :style="{
          padding: '0 1rem 1rem',
          color: 'var(--color-nav-text)',
          fontWeight: 700,
          fontSize: '1.1rem'
        }"
      >
        Kaiad
      </div>
      <a
        v-for="item in visibleNav"
        :key="item.route"
        :href="`#${item.route}`"
        :style="{
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
          padding: '0.55rem 1rem',
          color: isActive(item.route) ? 'var(--color-nav-active)' : 'var(--color-nav-text)',
          textDecoration: 'none',
          fontSize: '0.9rem',
          background: isActive(item.route) ? 'var(--color-nav-surface)' : 'transparent',
          borderLeft: isActive(item.route) ? '3px solid var(--color-nav-active)' : '3px solid transparent',
          transition: 'background 0.15s'
        }"
      >
        <component :is="item.icon" :size="16" />
        {{ item.label }}
      </a>
      <div :style="{ flex: 1 }" />
      <TenantSwitcher :user="user" :me-resolved="meResolved" @user-updated="handleTenantSwitch" />
      <button
        :style="{
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
          padding: '0.55rem 1rem',
          color: 'var(--color-nav-muted)',
          background: 'transparent',
          border: 'none',
          fontSize: '0.9rem',
          cursor: 'pointer',
          textAlign: 'left',
          borderLeft: '3px solid transparent'
        }"
        @click="logout"
      >
        <LogOut :size="16" /> Logout
      </button>
      <a
        v-if="docsUrl"
        :href="docsUrl"
        target="_blank"
        rel="noopener"
        :style="{
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
          padding: '0.55rem 1rem',
          color: 'var(--color-nav-muted)',
          textDecoration: 'none',
          fontSize: '0.8rem',
          borderLeft: '3px solid transparent'
        }"
      >
        Documentation ↗
      </a>
    </nav>

    <main :style="{ padding: '1.5rem', overflow: 'auto' }">
      <DashboardPage v-if="route === 'dashboard'" />
      <IncidentsPage v-else-if="route === 'incidents'" />
      <AgentsPage v-else-if="route === 'agents'" />
      <ServicesPage v-else-if="route === 'services'" />
      <SshKeysPage v-else-if="route === 'sshKeys'" />
      <TenantsPage v-else-if="route === 'tenants'" @auth-user-updated="(u: AuthUser) => (user = u)" />
      <SettingsPage v-else-if="route === 'settings'" />
      <TenantConfigurationPage
        v-else-if="route === 'tenantConfig' && tenantConfigTenantId"
        :tenant-id-from-route="tenantConfigTenantId"
        @auth-user-updated="(u: AuthUser) => (user = u)"
      />
    </main>
  </div>
</template>
