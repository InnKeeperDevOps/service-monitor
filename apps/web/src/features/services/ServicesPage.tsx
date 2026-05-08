import { useEffect, useState } from "react";
import { Box } from "lucide-react";
import { api, type Agent, type MonitoredService, type SshKey } from "../../lib/api.js";
import { useAuth } from "../../lib/useAuth.js";

type ServiceForm = {
  name: string;
  gitRepoUrl: string;
  sshKeyId: string;
  branch: string;
  dockerImage: string;
  composePath: string;
  agentIds: string[];
};

const emptyForm: ServiceForm = {
  name: "",
  gitRepoUrl: "",
  sshKeyId: "",
  branch: "main",
  dockerImage: "",
  composePath: "",
  agentIds: []
};

export function ServicesPage() {
  const [services, setServices] = useState<MonitoredService[]>([]);
  const [sshKeys, setSshKeys] = useState<SshKey[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<ServiceForm>(emptyForm);
  const { isAdmin } = useAuth();
  const canManage = isAdmin;

  useEffect(() => {
    api.listServices().then((r) => setServices(r.services)).catch((e) => setError(e.message));
    api.listSshKeys().then((r) => setSshKeys(r.keys)).catch(() => {});
    api.listAgents().then((r) => setAgents(r.agents)).catch(() => {});
  }, []);

  function toggleAgent(agentId: string) {
    setForm((prev) =>
      prev.agentIds.includes(agentId)
        ? { ...prev, agentIds: prev.agentIds.filter((a) => a !== agentId) }
        : { ...prev, agentIds: [...prev.agentIds, agentId] }
    );
  }

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
          composePath: form.composePath.trim() || undefined,
          agentIds: form.agentIds
        });
        setServices((prev) => prev.map((s) => s.id === editingId ? svc : s));
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
        setServices((prev) => [...prev, svc]);
      }
      setShowForm(false);
      setEditingId(null);
      setForm(emptyForm);
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
      composePath: svc.composePath || "",
      agentIds: (svc.agents ?? []).map((b) => b.agentId)
    });
    setEditingId(svc.id);
    setShowForm(true);
  }

  async function handleDelete(svc: MonitoredService) {
    if (!window.confirm(`Delete service "${svc.name}"? This will also remove its runs and incidents.`)) {
      return;
    }
    try {
      await api.deleteService(svc.id);
      setServices((prev) => prev.filter((s) => s.id !== svc.id));
      if (editingId === svc.id) {
        setEditingId(null);
        setShowForm(false);
        setForm(emptyForm);
      }
    } catch (e: unknown) {
      setError((e as Error).message);
    }
  }

  function renderAgents(svc: MonitoredService): string {
    const ids = (svc.agents ?? []).map((b) => b.agentId);
    if (ids.length === 0) return "—";
    return ids.join(", ");
  }

  return (
    <section>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
        <h2 style={{ margin: 0 }}>Monitored Services</h2>
        {canManage && (
          <button onClick={() => { setShowForm(!showForm); setEditingId(null); setForm(emptyForm); }} style={primaryBtn}>{showForm ? "Cancel" : "Add Service"}</button>
        )}
      </div>
      {error && <div style={{ color: "var(--color-danger)", marginBottom: "0.5rem" }}>{error}</div>}

      {services.some((s) => !s.sshKeyId) && (
        <div
          role="status"
          style={{
            background: "color-mix(in srgb, var(--color-warning) 12%, var(--color-surface))",
            border: "1px solid var(--color-warning)",
            borderRadius: 8,
            padding: "0.6rem 0.75rem",
            marginBottom: "1rem",
            fontSize: "0.85rem",
            color: "var(--color-text-primary)"
          }}
        >
          <strong>Auto-fix is disabled for some services.</strong> Services without an SSH key can still be
          monitored, but Kaiad cannot push fix commits to their repos. Edit the service and assign an SSH key
          to enable the automated error → fix loop.
        </div>
      )}

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
          <fieldset style={{ border: "1px solid var(--color-border)", borderRadius: 6, padding: "0.5rem 0.75rem" }}>
            <legend style={{ padding: "0 0.4rem", fontSize: "0.8rem", color: "var(--color-text-secondary)" }}>
              Bound agents <span>(many-to-many; pick zero or more)</span>
            </legend>
            {agents.length === 0 ? (
              <p style={{ margin: 0, color: "var(--color-text-secondary)", fontSize: "0.82rem" }}>
                No agents enrolled yet. Bind agents from the Agents page after they appear.
              </p>
            ) : (
              <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem 1rem" }}>
                {agents.map((a) => (
                  <label key={a.id} style={{ display: "inline-flex", gap: "0.3rem", alignItems: "center", fontSize: "0.85rem" }}>
                    <input
                      type="checkbox"
                      checked={form.agentIds.includes(a.id)}
                      onChange={() => toggleAgent(a.id)}
                    />
                    {a.name?.trim() || a.id}
                  </label>
                ))}
              </div>
            )}
          </fieldset>
          <button type="submit" style={primaryBtn}>{editingId ? "Save Changes" : "Create"}</button>
        </form>
      )}

      {services.length === 0 && !showForm ? (
        <p style={{ color: "var(--color-text-secondary)" }}>No services configured yet.</p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              {["Name", "Repository", "Branch", "Agents", "Detectors", "Actions"].map((h) => (
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
                  {renderAgents(svc)}
                </td>
                <td style={{ padding: "0.5rem", fontSize: "0.85rem", color: "var(--color-text-secondary)" }}>
                  Default
                </td>
                <td style={{ padding: "0.5rem", fontSize: "0.85rem" }}>
                  {canManage && (
                    <div style={{ display: "inline-flex", gap: "0.3rem" }}>
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
                      <button
                        onClick={() => handleDelete(svc)}
                        style={{
                          background: "var(--color-surface)",
                          border: "1px solid var(--color-border)",
                          padding: "0.2rem 0.5rem",
                          borderRadius: 4,
                          cursor: "pointer",
                          fontSize: "0.8rem",
                          color: "var(--color-danger)"
                        }}
                      >
                        Delete
                      </button>
                    </div>
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
