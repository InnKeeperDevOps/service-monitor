import { useEffect, useState } from "react";
import { Box } from "lucide-react";
import { api, type MonitoredService, type SshKey } from "../../lib/api.js";
import { useAuth } from "../../lib/useAuth.js";

export function ServicesPage() {
  const [services, setServices] = useState<MonitoredService[]>([]);
  const [sshKeys, setSshKeys] = useState<SshKey[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", gitRepoUrl: "", sshKeyId: "", branch: "main", dockerImage: "", composePath: "" });
  const { isAdmin } = useAuth();
  const canManage = isAdmin;

  useEffect(() => {
    api.listServices().then((r) => setServices(r.services)).catch((e) => setError(e.message));
    api.listSshKeys().then((r) => setSshKeys(r.keys)).catch(() => {});
  }, []);

  async function handleCreate(ev: React.FormEvent) {
    ev.preventDefault();
    try {
      if (editingId) {
        const svc = await api.updateService(editingId, {
          name: form.name,
          gitRepoUrl: form.gitRepoUrl,
          sshKeyId: form.sshKeyId || null,
          branch: form.branch,
          dockerImage: form.dockerImage.trim() || undefined,
          composePath: form.composePath.trim() || undefined
        });
        setServices((prev) => prev.map((s) => s.id === editingId ? svc : s));
      } else {
        const svc = await api.createService({
          name: form.name,
          gitRepoUrl: form.gitRepoUrl,
          sshKeyId: form.sshKeyId || undefined,
          branch: form.branch,
          dockerImage: form.dockerImage.trim() || undefined,
          composePath: form.composePath.trim() || undefined
        });
        setServices((prev) => [...prev, svc]);
      }
      setShowForm(false);
      setEditingId(null);
      setForm({ name: "", gitRepoUrl: "", sshKeyId: "", branch: "main", dockerImage: "", composePath: "" });
    } catch (e: unknown) {
      setError((e as Error).message);
    }
  }

  function handleEdit(svc: MonitoredService) {
    setForm({
      name: svc.name,
      gitRepoUrl: svc.gitRepoUrl,
      sshKeyId: svc.sshKeyId || "",
      branch: svc.branch,
      dockerImage: svc.dockerImage || "",
      composePath: svc.composePath || ""
    });
    setEditingId(svc.id);
    setShowForm(true);
  }

  return (
    <section>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
        <h2 style={{ margin: 0 }}>Monitored Services</h2>
        {canManage && (
          <button onClick={() => { setShowForm(!showForm); setEditingId(null); setForm({ name: "", gitRepoUrl: "", sshKeyId: "", branch: "main", dockerImage: "", composePath: "" }); }} style={primaryBtn}>{showForm ? "Cancel" : "Add Service"}</button>
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
            Git Repository URL
            <input value={form.gitRepoUrl} onChange={(e) => setForm({ ...form, gitRepoUrl: e.target.value })} required style={inputStyle} placeholder="e.g. git@github.com:acme/app.git" />
          </label>
          <label>
            SSH Key <span style={{ color: "var(--color-text-secondary)", fontSize: "0.8rem" }}>(required if SSH URL)</span>
            <select value={form.sshKeyId} onChange={(e) => setForm({ ...form, sshKeyId: e.target.value })} style={{ ...inputStyle, background: "var(--color-surface)" }}>
              <option value="">— None (HTTPS public) —</option>
              {sshKeys.map((k) => (
                <option key={k.id} value={k.id}>{k.name}</option>
              ))}
            </select>
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
          <button type="submit" style={primaryBtn}>{editingId ? "Save Changes" : "Create"}</button>
        </form>
      )}

      {services.length === 0 && !showForm ? (
        <p style={{ color: "var(--color-text-secondary)" }}>No services configured yet.</p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              {["Name", "Repository", "Branch", "Agent", "Workflow", "Detectors", "Actions"].map((h) => (
                <th key={h} style={{ textAlign: "left", padding: "0.5rem", borderBottom: "2px solid var(--color-border)", color: "var(--color-text-secondary)", fontSize: "0.8rem" }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {services.map((svc, idx) => (
              <tr key={svc.id || idx}>
                <td style={{ padding: "0.5rem" }}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem" }}><Box size={14} /> {svc.name}</span>
                </td>
                <td style={{ padding: "0.5rem", fontSize: "0.85rem" }}>{svc.gitRepoUrl}</td>
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
                <td style={{ padding: "0.5rem", fontSize: "0.85rem" }}>
                  {canManage && (
                    <button
                      onClick={() => handleEdit(svc)}
                      style={{
                        background: "var(--color-surface)",
                        border: "1px solid var(--color-border)",
                        padding: "0.2rem 0.5rem",
                        borderRadius: 4,
                        cursor: "pointer",
                        fontSize: "0.8rem",
                        color: "var(--color-text-primary)"
                      }}
                    >
                      Edit
                    </button>
                  )}
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
