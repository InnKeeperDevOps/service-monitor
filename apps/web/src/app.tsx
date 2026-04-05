import { useState, useEffect, useMemo, type ReactNode } from "react";
import {
  Activity,
  AlertTriangle,
  Box,
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
import { api, type Incident } from "./lib/api.js";
import { AuthContext, buildAuthState, type AuthUser } from "./lib/useAuth.js";
import { Card } from "./components/Card.js";
import { Badge } from "./components/Badge.js";
import { Button } from "./components/Button.js";

type Route = "dashboard" | "incidents" | "agents" | "services" | "workflows" | "settings" | "login";

const NAV_ITEMS: { route: Route; label: string; icon: typeof LayoutDashboard; adminOnly?: boolean }[] = [
  { route: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { route: "incidents", label: "Incidents", icon: AlertTriangle },
  { route: "services", label: "Services", icon: Box },
  { route: "agents", label: "Agents", icon: Cpu },
  { route: "workflows", label: "Workflows", icon: GitBranch },
  { route: "settings", label: "Settings", icon: Settings, adminOnly: true }
];

const VALID_ROUTES: Route[] = ["dashboard", "incidents", "agents", "services", "workflows", "settings", "login"];

function getHashRoute(): Route {
  const hash = window.location.hash.replace("#", "");
  return VALID_ROUTES.includes(hash as Route) ? (hash as Route) : "dashboard";
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
  const [route, setRoute] = useState<Route>(() => {
    if (!hasToken() && getHashRoute() !== "login") return "login";
    return getHashRoute();
  });
  const [user, setUser] = useState<AuthUser | null>(null);

  const authState = useMemo(() => buildAuthState(user), [user]);

  useEffect(() => {
    if (hasToken()) {
      api.me().then(setUser).catch(() => {});
    }
  }, []);

  useEffect(() => {
    if (!hasToken() && route !== "login") {
      window.location.hash = "login";
      setRoute("login");
    }
  }, [route]);

  useEffect(() => {
    const handler = () => {
      const next = getHashRoute();
      if (!hasToken() && next !== "login") {
        window.location.hash = "login";
        setRoute("login");
      } else {
        setRoute(next);
      }
    };
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);

  if (route === "login") {
    return <LoginPage />;
  }

  const visibleNav = NAV_ITEMS.filter((item) => {
    if (item.adminOnly && authState.isViewer) return false;
    return true;
  });

  return (
    <AuthContext value={authState}>
      <div style={{ display: "grid", gridTemplateColumns: "220px 1fr", minHeight: "100vh" }}>
        <nav style={{ background: "var(--color-nav-bg)", padding: "1rem 0", display: "flex", flexDirection: "column", gap: "0.15rem" }}>
          <div style={{ padding: "0 1rem 1rem", color: "var(--color-nav-text)", fontWeight: 700, fontSize: "1.1rem" }}>
            Kaiad
          </div>
          {visibleNav.map((item) => {
            const active = route === item.route;
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
          {route === "settings" && <SettingsPage />}
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
