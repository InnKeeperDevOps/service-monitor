# Operator e2e

`install_test.sh` runs the operator end-to-end on a `kind` cluster:

1. Spin up a fresh `kind` cluster.
2. Build + load the operator image.
3. Install the Helm chart.
4. Apply a sample `KaiadAgent` CR.
5. Wait for `Ready=True` and verify owned objects exist.
6. Delete the CR; verify owned objects are garbage-collected.

## Prerequisites

| Tool | Why |
|---|---|
| `kind` | Local k8s |
| `kubectl` | Talks to kind |
| `helm` | Installs the chart |
| `docker` | Builds the operator image |
| `curl`, `jq` | Verifies via Kaiad API |

A running Kaiad control plane the cluster can reach. For local dev with the
dev compose stack, use `host.docker.internal` (or `172.17.0.1` on Linux):

```bash
export KAIAD_API_BASE_URL=http://host.docker.internal:3000
```

An operator API credential with `enrollment-tokens.create` scope:

```bash
KAIAD_API_CREDENTIAL=$(curl -fsS -X POST $KAIAD_API_BASE_URL/api/v1/admin/api-credentials \
  -H "Authorization: Bearer $YOUR_OWNER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"e2e","scopes":["enrollment-tokens.create"]}' | jq -r .token)
```

## Run

```bash
./install_test.sh
```

Set `KEEP_KIND=1` to leave the cluster running for inspection on failure.
