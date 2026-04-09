import { useState, useEffect, useMemo, useCallback, type ReactNode } from "react";
import {
  Activity,
  AlertTriangle,
  Box,
  Building2,
  Cpu,
  GitBranch,
  LayoutDashboard,
  LogOut,
  RefreshCw,
  Settings
} from "lucide-react";
import "./tokens.css";
import { IncidentsPage } from "./features/incidents/IncidentsPage.js";
import { AgentsPage } from "./features/agents/AgentsPage.js";
import { ServicesPage } from "./features/services/ServicesPage.js";
import { SettingsPage } from "./features/settings/SettingsPage.js";
import { LoginPage } from "./features/auth/LoginPage.js";
import { SetupWizardPage } from "./features/setup/SetupWizardPage.js";
import { WorkflowEditorPage } from "./features/workflow-editor/WorkflowEditorPage.js";
import { TenantsPage } from "./features/tenants/TenantsPage.js";
import { TenantConfigurationPage } from "./features/tenants/TenantConfigurationPage.js";
import { api, meResponseToAuthUser, type Incident } from "./lib/api.js";
import { AuthContext, buildAuthState, type AuthUser } from "./lib/useAuth.js";
import { Card } from "./components/Card.js";
import { Badge } from "./components/Badge.js";
import { Button } from "./components/Button.js";
import { TenantSwitcher } from "./components/TenantSwitcher.js";

type Route =
  | "dashboard"
  | "incidents"
  | "agents"
  | "services"
  | "workflows"
  | "settings"
  | "tenants"
  | "tenantConfig"
  | "login";

const NAV_ITEMS: { route: Route; label: string; icon: typeof LayoutDashboard; adminOnly?: boolean }[] = [
  { route: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { route: "incidents", label: "Incidents", icon: AlertTriangle },
  { route: "services", label: "Services", icon: Box },
  { route: "agents", label: "Agents", icon: Cpu },
  { route: "workflows", label: "Workflows", icon: GitBranch },
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
    "workflows",
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

export function App() {
  const [setupStatus, setSetupStatus] = useState<boolean | null>(null);

  useEffect(() => {
    api.getSetupStatus()
      .then((res) => setSetupStatus(res.setupRequired))
      .catch(() => setSetupStatus(false));
  }, []);

  if (setupStatus === null) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh" }}>
        <p style={{ color: "var(--color-text-secondary)" }}>Loading…</p>
      </div>
    );
  }

  if (setupStatus) {
    return <SetupWizardPage />;
  }

  return <AppMain />;
}

function AppMain() {
  const [route, setRoute] = useState<Route>(() => (hasToken() ? readNavFromHash().route : "login"));
  const [tenantConfigTenantId, setTenantConfigTenantId] = useState<string | null>(() =>
    hasToken() ? readNavFromHash().tenantConfigTenantId : null
  );
  const [user, setUser] = useState<AuthUser | null>(null);
  const [meResolved, setMeResolved] = useState(false);

  const authState = useMemo(() => buildAuthState(user), [user]);

  useEffect(() => {
    if (!hasToken()) {
      setMeResolved(true);
      return;
    }
    api.me()
      .then((m) => setUser(meResponseToAuthUser(m)))
      .catch((err) => {
        console.error("[app] GET /api/v1/me failed", err);
      })
      .finally(() => setMeResolved(true));
  }, []);

  useEffect(() => {
    if (!hasToken() && route !== "login") {
      window.location.hash = "login";
      setRoute("login");
      setTenantConfigTenantId(null);
    }
  }, [route]);

  useEffect(() => {
    if (route === "tenantConfig" && !tenantConfigTenantId) {
      window.location.hash = "tenants";
    }
  }, [route, tenantConfigTenantId]);

  useEffect(() => {
    const handler = () => {
      if (!hasToken()) {
        window.location.hash = "login";
        setRoute("login");
        setTenantConfigTenantId(null);
        return;
      }
      const nav = readNavFromHash();
      setRoute(nav.route);
      setTenantConfigTenantId(nav.tenantConfigTenantId);
    };
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);

  /** GitHub App post-install redirect: send users to tenant configuration so install sync runs in tenant context. */
  useEffect(() => {
    if (!hasToken()) return;
    const params = new URLSearchParams(window.location.search);
    if (!params.get("installation_id")) return;
    const tid = user?.tenantId;
    if (!tid) return;
    const expected = `tenant-config/${encodeURIComponent(tid)}`;
    const raw = window.location.hash.replace(/^#/, "").split("?")[0];
    if (raw !== expected) {
      window.location.hash = expected;
    }
  }, [user?.tenantId]);

  if (route === "login") {
    return <LoginPage />;
  }

  const visibleNav = NAV_ITEMS.filter((item) => {
    if (item.adminOnly && authState.isViewer) return false;
    return true;
  });

  const handleTenantSwitch = useCallback(
    (u: AuthUser) => {
      setUser(u);
      if (route === "tenantConfig" && tenantConfigTenantId && tenantConfigTenantId !== u.tenantId) {
        window.location.hash = `tenant-config/${encodeURIComponent(u.tenantId)}`;
      }
    },
    [route, tenantConfigTenantId]
  );

  return (
    <AuthContext value={authState}>
      <div style={{ display: "grid", gridTemplateColumns: "220px 1fr", minHeight: "100vh" }}>
        <nav style={{ background: "var(--color-nav-bg)", padding: "1rem 0", display: "flex", flexDirection: "column", gap: "0.15rem" }}>
          <div style={{ padding: "0 1rem 1rem", color: "var(--color-nav-text)", fontWeight: 700, fontSize: "1.1rem" }}>
            Kaiad
          </div>
          {visibleNav.map((item) => {
            const active =
              route === item.route ||
              (item.route === "tenants" && route === "tenantConfig");
            const Icon = item.icon;
            return (
              <a
                key={item.route}
                href={`#${item.route}`}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.5rem",
                  padding: "0.55rem 1rem",
                  color: active ? "var(--color-nav-active)" : "var(--color-nav-text)",
                  textDecoration: "none",
                  fontSize: "0.9rem",
                  background: active ? "var(--color-nav-surface)" : "transparent",
                  borderLeft: active ? "3px solid var(--color-nav-active)" : "3px solid transparent",
                  transition: "background 0.15s"
                }}
              >
                <Icon size={16} /> {item.label}
              </a>
            );
          })}
          <div style={{ flex: 1 }} />
          <TenantSwitcher user={user} meResolved={meResolved} onUserUpdated={handleTenantSwitch} />
          <button
            onClick={() => api.logout()}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.5rem",
              padding: "0.55rem 1rem",
              color: "var(--color-nav-muted)",
              background: "transparent",
              border: "none",
              fontSize: "0.9rem",
              cursor: "pointer",
              textAlign: "left",
              borderLeft: "3px solid transparent",
            }}
          >
            <LogOut size={16} /> Logout
          </button>
          {import.meta.env.VITE_DOCS_URL && (
            <a
              href={import.meta.env.VITE_DOCS_URL}
              target="_blank"
              rel="noopener"
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.5rem",
                padding: "0.55rem 1rem",
                color: "var(--color-nav-muted)",
                textDecoration: "none",
                fontSize: "0.8rem",
                borderLeft: "3px solid transparent",
              }}
            >
              Documentation ↗
            </a>
          )}
        </nav>

        <main style={{ padding: "1.5rem", overflow: "auto" }}>
          {route === "dashboard" && <DashboardPage />}
          {route === "incidents" && <IncidentsPage />}
          {route === "agents" && <AgentsPage />}
          {route === "services" && <ServicesPage />}
          {route === "workflows" && <WorkflowEditorPage />}
          {route === "tenants" && <TenantsPage onAuthUserUpdated={setUser} />}
          {route === "settings" && <SettingsPage />}
          {route === "tenantConfig" && tenantConfigTenantId && (
            <TenantConfigurationPage tenantIdFromRoute={tenantConfigTenantId} onAuthUserUpdated={setUser} />
          )}
        </main>
      </div>
    </AuthContext>
  );
}

const STATUS_BADGE_VARIANT: Record<string, "danger" | "warning" | "success" | "muted"> = {
  open: "danger",
  acknowledged: "warning",
  resolved: "success",
  closed: "muted"
};

function incidentPreviewText(inc: Incident): string {
  const raw = inc.message ?? inc.fingerprint.slice(0, 24);
  return raw.length > 96 ? `${raw.slice(0, 96)}…` : raw;
}

const POLL_INTERVAL = 15_000;

function DashboardPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [agentCount, setAgentCount] = useState(0);
  const [openIncidentsCount, setOpenIncidentsCount] = useState(0);
  const [serviceCount, setServiceCount] = useState(0);
  const [recentIncidents, setRecentIncidents] = useState<Incident[]>([]);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [secondsAgo, setSecondsAgo] = useState(0);

  const fetchData = () => {
    setError(null);
    return Promise.all([api.listIncidents(), api.listAgents(), api.listServices()])
      .then(([incRes, agRes, svcRes]) => {
        const incidents = incRes.incidents;
        setAgentCount(agRes.agents.length);
        setOpenIncidentsCount(incidents.filter((i) => i.status === "open").length);
        setServiceCount(svcRes.services.length);
        setRecentIncidents(
          [...incidents]
            .sort((a, b) => new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime())
            .slice(0, 5)
        );
        setLastUpdated(new Date());
      })
      .catch((e: unknown) => {
        setError((e as Error).message);
      })
      .finally(() => {
        setLoading(false);
      });
  };

  useEffect(() => {
    fetchData();
    const id = setInterval(fetchData, POLL_INTERVAL);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!lastUpdated) return;
    const id = setInterval(() => {
      setSecondsAgo(Math.floor((Date.now() - lastUpdated.getTime()) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [lastUpdated]);

  const statValue = (n: number) => {
    if (loading) return "...";
    if (error) return "—";
    return String(n);
  };

  return (
    <section>
      <div style={{ display: "flex", alignItems: "center", gap: "1rem", marginBottom: "1rem" }}>
        <h2 style={{ margin: 0 }}>Dashboard</h2>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "0.75rem" }}>
          {lastUpdated && (
            <span style={{ fontSize: "0.8rem", color: "var(--color-text-secondary)" }}>
              Last updated: {secondsAgo}s ago
            </span>
          )}
          <Button size="sm" variant="ghost" onClick={fetchData}>
            <RefreshCw size={14} /> Refresh
          </Button>
        </div>
      </div>

      {error && (
        <div style={{ color: "var(--color-danger)", marginBottom: "0.75rem" }} role="alert">
          {error}
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "1rem", marginBottom: "1.5rem" }}>
        <Card>
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", color: "var(--color-text-secondary)" }}>
            <Activity size={16} /> Connected Agents
          </div>
          <div style={{ marginTop: "0.5rem", fontSize: "1.5rem", fontWeight: 700 }}>{statValue(agentCount)}</div>
        </Card>
        <Card>
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", color: "var(--color-text-secondary)" }}>
            <AlertTriangle size={16} /> Open Incidents
          </div>
          <div style={{ marginTop: "0.5rem", fontSize: "1.5rem", fontWeight: 700 }}>{statValue(openIncidentsCount)}</div>
        </Card>
        <Card>
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", color: "var(--color-text-secondary)" }}>
            <Box size={16} /> Monitored Services
          </div>
          <div style={{ marginTop: "0.5rem", fontSize: "1.5rem", fontWeight: 700 }}>{statValue(serviceCount)}</div>
        </Card>
      </div>

      <h3 style={{ margin: "0 0 0.65rem", fontSize: "1rem", fontWeight: 600 }}>Recent Incidents</h3>
      {loading && (
        <p style={{ color: "var(--color-text-secondary)", margin: 0 }}>Loading…</p>
      )}
      {!loading && !error && recentIncidents.length === 0 && (
        <p style={{ color: "var(--color-text-secondary)", margin: 0 }}>No incidents yet.</p>
      )}
      {!loading && !error && recentIncidents.length > 0 && (
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {recentIncidents.map((inc) => (
            <li
              key={inc.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.75rem",
                padding: "0.65rem 0",
                borderBottom: "1px solid var(--color-border)",
                fontSize: "0.9rem"
              }}
            >
              <Badge variant={STATUS_BADGE_VARIANT[inc.status] ?? "muted"}>
                {inc.status}
              </Badge>
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap"
                }}
                title={inc.message ?? inc.fingerprint}
              >
                {incidentPreviewText(inc)}
              </span>
              <time
                dateTime={inc.lastSeenAt}
                style={{ flexShrink: 0, color: "var(--color-text-secondary)", fontSize: "0.85rem" }}
              >
                {new Date(inc.lastSeenAt).toLocaleString()}
              </time>
            </li>
          ))}
        </ul>
      )}

      <Card title="Recent Remediation Plans" style={{ marginTop: "1.5rem" }}>
        <p style={{ color: "var(--color-text-secondary)", margin: 0, fontSize: "0.9rem" }}>
          Remediation plans are queued automatically when incidents are detected.
          View plan status in the Incidents detail view.
        </p>
      </Card>

      <p style={{ color: "var(--color-text-secondary)", marginTop: "1.25rem" }}>
        Navigate using the sidebar to manage incidents, services, agents, and workflows.
      </p>
    </section>
  );
}
