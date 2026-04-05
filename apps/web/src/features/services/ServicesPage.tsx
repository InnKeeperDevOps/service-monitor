import { useEffect, useState } from "react";
import { Box } from "lucide-react";
import { api, type MonitoredService } from "../../lib/api.js";
import { useAuth } from "../../lib/useAuth.js";

export function ServicesPage() {
  const [services, setServices] = useState<MonitoredService[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: "", repo: "", branch: "main", dockerImage: "", composePath: "" });
  const { isAdmin } = useAuth();
  const canManage = isAdmin;

  useEffect(() => {
    api.listServices().then((r) => setServices(r.services)).catch((e) => setError(e.message));
  }, []);

  async function handleCreate(ev: React.FormEvent) {
    ev.preventDefault();
    try {
      const svc = await api.createService({
        name: form.name,
        repo: form.repo,
        branch: form.branch,
        dockerImage: form.dockerImage.trim() || undefined,
        composePath: form.composePath.trim() || undefined
      });
      setServices((prev) => [...prev, svc]);
      setShowForm(false);
      setForm({ name: "", repo: "", branch: "main", dockerImage: "", composePath: "" });
    } catch (e: unknown) {
      setError((e as Error).message);
    }
  }

  return (
    <section>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
        <h2 style={{ margin: 0 }}>Monitored Services</h2>
        {canManage && (
          <button onClick={() => setShowForm(!showForm)} style={primaryBtn}>{showForm ? "Cancel" : "Add Service"}</button>
        )}
      </div>
      {error && <div style={{ color: "var(--color-danger)", marginBottom: "0.5rem" }}>{error}</div>}

      {canManage && showForm && (
        <form onSubmit={handleCreate} style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 10, padding: "1rem", marginBottom: "1rem", display: "grid", gap: "0.5rem" }}>
          <label>
            Name
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required style={inputStyle} />
          </label>
          <label>
            Repository (owner/repo)
            <input value={form.repo} onChange={(e) => setForm({ ...form, repo: e.target.value })} required style={inputStyle} />
          </label>
          <label>
            Branch
            <input value={form.branch} onChange={(e) => setForm({ ...form, branch: e.target.value })} required style={inputStyle} />
          </label>
          <label>
            Docker Image <span style={{ color: "var(--color-text-secondary)", fontSize: "0.8rem" }}>(optional)</span>
            <input value={form.dockerImage} onChange={(e) => setForm({ ...form, dockerImage: e.target.value })} placeholder="e.g. myorg/myapp:latest" style={inputStyle} />
          </label>
          <label>
            Compose Path <span style={{ color: "var(--color-text-secondary)", fontSize: "0.8rem" }}>(optional)</span>
            <input value={form.composePath} onChange={(e) => setForm({ ...form, composePath: e.target.value })} placeholder="e.g. docker-compose.yml" style={inputStyle} />
          </label>
          <button type="submit" style={primaryBtn}>Create</button>
        </form>
      )}

      {services.length === 0 && !showForm ? (
        <p style={{ color: "var(--color-text-secondary)" }}>No services configured yet.</p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              {["Name", "Repository", "Branch", "Agent", "Workflow", "Detectors"].map((h) => (
                <th key={h} style={{ textAlign: "left", padding: "0.5rem", borderBottom: "2px solid var(--color-border)", color: "var(--color-text-secondary)", fontSize: "0.8rem" }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {services.map((svc) => (
              <tr key={svc.id}>
                <td style={{ padding: "0.5rem" }}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem" }}><Box size={14} /> {svc.name}</span>
                </td>
                <td style={{ padding: "0.5rem", fontSize: "0.85rem" }}>{svc.repo}</td>
                <td style={{ padding: "0.5rem", fontSize: "0.85rem" }}>{svc.branch}</td>
                <td style={{ padding: "0.5rem", fontSize: "0.85rem", color: "var(--color-text-secondary)" }}>
                  {svc.agentId ?? "\u2014"}
                </td>
                <td style={{ padding: "0.5rem", fontSize: "0.85rem", color: "var(--color-text-secondary)" }}>
                  {svc.workflowGraphId ?? "\u2014"}
                </td>
                <td style={{ padding: "0.5rem", fontSize: "0.85rem", color: "var(--color-text-secondary)" }}>
                  Default
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

const primaryBtn: React.CSSProperties = {
  background: "var(--color-primary)",
  color: "var(--color-primary-foreground)",
  border: "none",
  borderRadius: 8,
  padding: "0.4rem 0.75rem",
  cursor: "pointer",
  fontSize: "0.85rem"
};

const inputStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  padding: "0.35rem 0.5rem",
  border: "1px solid var(--color-border)",
  borderRadius: 6,
  marginTop: "0.2rem",
  boxSizing: "border-box"
};
