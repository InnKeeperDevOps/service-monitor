# kaiad-operator Helm chart

Installs the Kaiad agent operator (CRD + manager Deployment + cluster RBAC).
The operator reconciles `KaiadAgent` custom resources into running agent
Deployments in the cluster.

## Install

```bash
# 1. Mint an admin API credential against your Kaiad control plane:
#      POST /api/v1/admin/api-credentials
#      body: {"name":"k8s-operator","scopes":["enrollment-tokens.create"]}
#    Save the returned token — you'll only see it once.

# 2. Install the chart:
helm install kaiad-operator . \
  --namespace kaiad-system --create-namespace \
  --set kaiad.apiBaseURL=https://panel.example.com \
  --set kaiad.apiCredentialSecret.create=true \
  --set kaiad.apiCredentialSecret.value=$KAIAD_OPERATOR_TOKEN
```

For a pre-provisioned credential Secret (recommended in production —
template-rendered Secrets leak into the Helm release object):

```bash
kubectl create secret generic kaiad-operator-credentials \
  --namespace kaiad-system \
  --from-literal=token=$KAIAD_OPERATOR_TOKEN

helm install kaiad-operator . \
  --namespace kaiad-system \
  --set kaiad.apiBaseURL=https://panel.example.com
```

## Values

See `values.yaml`. Notable knobs:

| Key | Required | Default | Notes |
|-----|----------|---------|-------|
| `kaiad.apiBaseURL` | yes | (none) | Control plane base URL, no trailing slash. |
| `kaiad.apiCredentialSecret.name` | — | `kaiad-operator-credentials` | Secret holding `token` key. |
| `kaiad.apiCredentialSecret.create` | — | `false` | When true, chart renders the Secret from `value`. |
| `image.repository` | — | `ghcr.io/innkeeperdevops/kaiad-operator` | |
| `image.tag` | — | `Chart.AppVersion` | |
| `leaderElection.enabled` | — | `true` | |

## What gets installed

- The `kaiadagents.kaiad.dev` CRD (in `crds/`, applied first by Helm).
- A namespaced ServiceAccount for the operator.
- A `ClusterRole` + `ClusterRoleBinding` for the operator's own cluster scope
  (manage `KaiadAgent`, create Deployments/Secrets/RBAC objects, etc.).
- A 1-replica Deployment of the operator manager.

The operator's own RBAC is *separate* from the per-CR RBAC it generates from
each `KaiadAgent.spec.manages` — that's the *agent's* role, narrower and
scoped to the namespaces the CR author requested.
