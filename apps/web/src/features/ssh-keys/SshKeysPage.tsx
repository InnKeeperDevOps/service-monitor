import { useEffect, useState } from "react";
import { Key } from "lucide-react";
import { api, type SshKey } from "../../lib/api.js";
import { useAuth } from "../../lib/useAuth.js";
import { Button } from "../../components/Button.js";

export function SshKeysPage() {
  const [keys, setKeys] = useState<SshKey[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<{ name: string; keyType: "uploaded" | "local_path"; privateKey: string; localPath: string }>({
    name: "",
    keyType: "uploaded",
    privateKey: "",
    localPath: ""
  });
  const { isAdmin } = useAuth();
  const canManage = isAdmin;

  const fetchKeys = () => {
    api.listSshKeys().then((r) => setKeys(r.keys)).catch((e) => setError(e.message));
  };

  useEffect(() => {
    fetchKeys();
  }, []);

  async function handleCreate(ev: React.FormEvent) {
    ev.preventDefault();
    try {
      await api.createSshKey({
        name: form.name,
        type: form.keyType,
        privateKey: form.keyType === "uploaded" ? form.privateKey : undefined,
        localPath: form.keyType === "local_path" ? form.localPath : undefined
      });
      fetchKeys();
      setShowForm(false);
      setForm({ name: "", keyType: "uploaded", privateKey: "", localPath: "" });
    } catch (e: unknown) {
      setError((e as Error).message);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Are you sure you want to delete this SSH key?")) return;
    try {
      await api.deleteSshKey(id);
      fetchKeys();
    } catch (e: unknown) {
      setError((e as Error).message);
    }
  }

  return (
    <section>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
        <h2 style={{ margin: 0 }}>SSH Keys</h2>
        {canManage && (
          <Button onClick={() => setShowForm(!showForm)}>{showForm ? "Cancel" : "Add Key"}</Button>
        )}
      </div>
      {error && <div style={{ color: "var(--color-danger)", marginBottom: "0.5rem" }}>{error}</div>}

      {canManage && showForm && (
        <form onSubmit={handleCreate} style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 10, padding: "1rem", marginBottom: "1rem", display: "grid", gap: "1rem" }}>
          <label style={{ display: "block" }}>
            Name
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required style={inputStyle} />
          </label>
          <div style={{ display: "flex", gap: "1rem" }}>
            <label style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <input
                type="radio"
                name="keyType"
                value="uploaded"
                checked={form.keyType === "uploaded"}
                onChange={(e) => setForm({ ...form, keyType: e.target.value as "uploaded" })}
              />
              Upload Private Key
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <input
                type="radio"
                name="keyType"
                value="local_path"
                checked={form.keyType === "local_path"}
                onChange={(e) => setForm({ ...form, keyType: e.target.value as "local_path" })}
              />
              Local Path on Agent
            </label>
          </div>
          
          {form.keyType === "uploaded" && (
            <label style={{ display: "block" }}>
              Private Key (PEM format)
              <textarea
                value={form.privateKey}
                onChange={(e) => setForm({ ...form, privateKey: e.target.value })}
                required
                style={{ ...inputStyle, minHeight: "150px", fontFamily: "monospace" }}
              />
            </label>
          )}

          {form.keyType === "local_path" && (
            <label style={{ display: "block" }}>
              Local Path (e.g. ~/.ssh/id_rsa)
              <input
                value={form.localPath}
                onChange={(e) => setForm({ ...form, localPath: e.target.value })}
                required
                style={inputStyle}
              />
            </label>
          )}
          <div>
            <Button type="submit">Create Key</Button>
          </div>
        </form>
      )}

      {keys.length === 0 && !showForm ? (
        <p style={{ color: "var(--color-text-secondary)" }}>No SSH keys configured yet.</p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              {["Name", "Type", "Created At", ""].map((h) => (
                <th key={h} style={{ textAlign: h === "" ? "right" : "left", padding: "0.5rem", borderBottom: "2px solid var(--color-border)", color: "var(--color-text-secondary)", fontSize: "0.8rem" }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {keys.map((key) => (
              <tr key={key.id}>
                <td style={{ padding: "0.5rem" }}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem" }}><Key size={14} /> {key.name}</span>
                </td>
                <td style={{ padding: "0.5rem", fontSize: "0.85rem" }}>
                  {key.type === "uploaded" ? "Uploaded" : "Local Path"}
                </td>
                <td style={{ padding: "0.5rem", fontSize: "0.85rem", color: "var(--color-text-secondary)" }}>
                  {new Date(key.createdAt).toLocaleString()}
                </td>
                <td style={{ padding: "0.5rem", textAlign: "right" }}>
                  {canManage && (
                    <Button size="sm" variant="ghost" onClick={() => handleDelete(key.id)} style={{ color: "var(--color-danger)" }}>
                      Delete
                    </Button>
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

const inputStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  padding: "0.35rem 0.5rem",
  border: "1px solid var(--color-border)",
  borderRadius: 6,
  marginTop: "0.2rem",
  boxSizing: "border-box"
};