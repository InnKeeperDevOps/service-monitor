import { useEffect, useState } from "react";
import { Cpu } from "lucide-react";
import { api, type Agent } from "../../lib/api.js";

const statusBadge: Record<string, { bg: string; fg: string }> = {
  online: { bg: "var(--color-success-bg)", fg: "var(--color-success)" },
  offline: { bg: "var(--color-danger-bg)", fg: "var(--color-danger)" },
  degraded: { bg: "var(--color-warning-bg)", fg: "var(--color-warning)" },
  unknown: { bg: "var(--color-surface-muted)", fg: "var(--color-text-secondary)" }
};

export function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.listAgents().then((r) => setAgents(r.agents)).catch((e) => setError(e.message));
  }, []);

  return (
    <section>
      <h2 style={{ margin: "0 0 1rem" }}>Connected Agents</h2>
      {error && <div style={{ color: "var(--color-danger)", marginBottom: "0.5rem" }}>{error}</div>}
      {agents.length === 0 ? (
        <p style={{ color: "var(--color-text-secondary)" }}>
          No agents connected. Create an enrollment token in Settings to register an agent.
        </p>
      ) : (
        <div style={{ display: "grid", gap: "0.75rem", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}>
          {agents.map((a) => {
            const badge = statusBadge[a.status] ?? statusBadge.unknown;
            return (
              <article key={a.id} style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 10, padding: "1rem" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.5rem" }}>
                  <Cpu size={16} />
                  <span style={{ fontWeight: 600 }}>{a.id}</span>
                </div>
                <span style={{ display: "inline-block", padding: "0.15rem 0.5rem", borderRadius: 12, fontSize: "0.75rem", fontWeight: 600, background: badge.bg, color: badge.fg }}>
                  {a.status}
                </span>
                {a.lastSeenAt && (
                  <div style={{ marginTop: "0.5rem", fontSize: "0.8rem", color: "var(--color-text-secondary)" }}>
                    Last seen: {new Date(a.lastSeenAt).toLocaleString()}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
