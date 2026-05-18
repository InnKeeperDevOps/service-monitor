// Builds a single, ready-to-`kubectl apply` YAML bundle that installs the
// Kaiad operator: CRD, namespace, ServiceAccount, ClusterRole,
// ClusterRoleBinding, Deployment. The Helm chart at
// deploy/operator/charts/kaiad-operator/ is the source of truth — the
// constants below MUST stay in sync with the chart templates.

const APP_VERSION = "0.1.1";
const NAME = "kaiad-operator";

// Mirrors deploy/operator/charts/kaiad-operator/crds/kaiadagents.yaml.
// Keep in sync; the chart is the source of truth.
const CRD_YAML = `apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: kaiadagents.kaiad.dev
  annotations:
    kaiad.dev/source: hand-rolled-task-3
    kaiad.dev/regenerate-with: controller-gen crd paths=./api/...
spec:
  group: kaiad.dev
  scope: Namespaced
  names:
    kind: KaiadAgent
    listKind: KaiadAgentList
    plural: kaiadagents
    singular: kaiadagent
    shortNames:
      - kagent
  versions:
    - name: v1alpha1
      served: true
      storage: true
      subresources:
        status: {}
      additionalPrinterColumns:
        - name: Image
          type: string
          jsonPath: .spec.image
        - name: AgentId
          type: string
          jsonPath: .status.enrolledAgentId
        - name: Ready
          type: string
          jsonPath: .status.conditions[?(@.type=='Ready')].status
        - name: Age
          type: date
          jsonPath: .metadata.creationTimestamp
      schema:
        openAPIV3Schema:
          type: object
          properties:
            apiVersion:
              type: string
            kind:
              type: string
            metadata:
              type: object
            spec:
              type: object
              required: [controlPlane, enrollment, image]
              properties:
                controlPlane:
                  type: object
                  required: [realtimeUrl]
                  properties:
                    realtimeUrl:
                      type: string
                      pattern: "^wss?://.+"
                enrollment:
                  type: object
                  required: [secretRef]
                  properties:
                    secretRef:
                      type: object
                      required: [name]
                      properties:
                        name:
                          type: string
                        key:
                          type: string
                          default: token
                serviceId:
                  type: string
                image:
                  type: string
                  minLength: 1
                resources:
                  type: object
                  x-kubernetes-preserve-unknown-fields: true
                nodeSelector:
                  type: object
                  additionalProperties:
                    type: string
                tolerations:
                  type: array
                  items:
                    type: object
                    x-kubernetes-preserve-unknown-fields: true
                imagePullSecrets:
                  type: array
                  items:
                    type: object
                    required: [name]
                    properties:
                      name:
                        type: string
                manages:
                  type: array
                  maxItems: 32
                  items:
                    type: object
                    required: [apiGroups, resources, verbs]
                    properties:
                      apiGroups:
                        type: array
                        items:
                          type: string
                      resources:
                        type: array
                        minItems: 1
                        items:
                          type: string
                      verbs:
                        type: array
                        minItems: 1
                        items:
                          type: string
                      namespaceSelector:
                        type: object
                        x-kubernetes-preserve-unknown-fields: true
            status:
              type: object
              properties:
                conditions:
                  type: array
                  items:
                    type: object
                    required: [type, status, lastTransitionTime, reason]
                    properties:
                      type:
                        type: string
                      status:
                        type: string
                        enum: ["True", "False", "Unknown"]
                      observedGeneration:
                        type: integer
                        format: int64
                      lastTransitionTime:
                        type: string
                        format: date-time
                      reason:
                        type: string
                      message:
                        type: string
                enrolledAgentId:
                  type: string
                observedGeneration:
                  type: integer
                  format: int64
                deploymentName:
                  type: string
`;

// Mirrors the cluster role at
// deploy/operator/charts/kaiad-operator/templates/clusterrole.yaml.
// Keep in sync with the Helm chart AND internal/controller/allowlist.go.
const CLUSTER_ROLE_RULES = `  - apiGroups: ["kaiad.dev"]
    resources: ["kaiadagents"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
  - apiGroups: ["kaiad.dev"]
    resources: ["kaiadagents/status", "kaiadagents/finalizers"]
    verbs: ["get", "update", "patch"]
  - apiGroups: ["apps"]
    resources: ["deployments"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
  - apiGroups: [""]
    resources: ["serviceaccounts", "secrets"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
  - apiGroups: [""]
    resources: ["namespaces"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["rbac.authorization.k8s.io"]
    resources: ["roles", "rolebindings", "clusterroles", "clusterrolebindings"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
  - apiGroups: ["coordination.k8s.io"]
    resources: ["leases"]
    verbs: ["get", "list", "watch", "create", "update", "patch"]
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["list", "delete"]
  - apiGroups: ["apps"]
    resources: ["statefulsets"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
  - apiGroups: ["apps"]
    resources: ["daemonsets"]
    verbs: ["get", "list", "watch"]
  - apiGroups: [""]
    resources: ["pods", "pods/log"]
    verbs: ["get", "list", "watch"]
  - apiGroups: [""]
    resources: ["services"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
  - apiGroups: ["networking.k8s.io"]
    resources: ["ingresses"]
    verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
  - apiGroups: [""]
    resources: ["events"]
    verbs: ["get", "list", "watch", "create", "patch"]
  - apiGroups: [""]
    resources: ["configmaps"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["batch"]
    resources: ["jobs"]
    verbs: ["get", "list", "watch", "create", "delete"]
  - apiGroups: ["batch"]
    resources: ["cronjobs"]
    verbs: ["get", "list", "watch"]
`;

const DEFAULT_OPERATOR_NAMESPACE = "kaiad-system";

// Default operator image. When this Kaiad hosts images in its own
// registry (KAIAD_REGISTRY_HOST set — e.g. panel.kaiad.dev), default to
// that registry's kaiad-operator, matching the panel UI and the on-boot
// publisher so the generated manifest reflects what's actually deployed.
// Falls back to the portable, version-pinned GHCR ref for setups with
// no built-in registry (and for tests, where the host is unset).
function defaultOperatorImage(): string {
  const host = process.env.KAIAD_REGISTRY_HOST?.trim();
  return host
    ? `${host}/kaiad-operator:latest`
    : `ghcr.io/innkeeperdevops/kaiad-operator:${APP_VERSION}`;
}

const NAMESPACE_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
// Loose image reference check; rejects whitespace and shell metacharacters so
// the rendered YAML stays unambiguous. Anchored to the full string.
const IMAGE_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,254}$/;

export function defaultOperatorInstallOptions(): OperatorInstallOptions {
  return {
    namespace: DEFAULT_OPERATOR_NAMESPACE,
    image: defaultOperatorImage()
  };
}

export type OperatorInstallOptions = {
  namespace: string;
  image: string;
};

export type OperatorInstallParseResult =
  | { ok: true; value: OperatorInstallOptions }
  | { ok: false; reason: string };

export function parseOperatorInstallOptions(
  query: Record<string, string | string[] | undefined>
): OperatorInstallParseResult {
  const defaults = defaultOperatorInstallOptions();
  const namespaceRaw = pickString(query.namespace);
  const imageRaw = pickString(query.image);

  const namespace = namespaceRaw?.trim() || defaults.namespace;
  const image = imageRaw?.trim() || defaults.image;

  if (namespace.length > 63 || !NAMESPACE_RE.test(namespace)) {
    return { ok: false, reason: "Invalid namespace: must match DNS-1123 label" };
  }
  if (!IMAGE_RE.test(image)) {
    return { ok: false, reason: "Invalid image reference" };
  }
  return { ok: true, value: { namespace, image } };
}

function pickString(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

function labelsBlock(indent: string): string {
  return [
    `${indent}app.kubernetes.io/name: ${NAME}`,
    `${indent}app.kubernetes.io/instance: ${NAME}`,
    `${indent}app.kubernetes.io/version: "${APP_VERSION}"`,
    `${indent}app.kubernetes.io/managed-by: kubectl`
  ].join("\n");
}

export function buildOperatorInstallYaml(opts: OperatorInstallOptions): string {
  const { namespace, image } = opts;
  const labels4 = labelsBlock("    ");
  const labels8 = labelsBlock("        ");

  const namespaceManifest = `apiVersion: v1
kind: Namespace
metadata:
  name: ${namespace}
  labels:
${labels4}
`;

  const serviceAccountManifest = `apiVersion: v1
kind: ServiceAccount
metadata:
  name: ${NAME}
  namespace: ${namespace}
  labels:
${labels4}
`;

  const clusterRoleManifest = `apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: ${NAME}
  labels:
${labels4}
rules:
${CLUSTER_ROLE_RULES}`;

  const clusterRoleBindingManifest = `apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: ${NAME}
  labels:
${labels4}
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: ${NAME}
subjects:
  - kind: ServiceAccount
    name: ${NAME}
    namespace: ${namespace}
`;

  const deploymentManifest = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${NAME}
  namespace: ${namespace}
  labels:
${labels4}
spec:
  replicas: 1
  selector:
    matchLabels:
      app.kubernetes.io/name: ${NAME}
      app.kubernetes.io/instance: ${NAME}
  template:
    metadata:
      labels:
${labels8}
    spec:
      serviceAccountName: ${NAME}
      securityContext:
        runAsNonRoot: true
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: manager
          image: ${image}
          imagePullPolicy: IfNotPresent
          # No command override: both the GHCR build and the Kaiad
          # registry-baked bundle ship ENTRYPOINT ["/manager"].
          args:
            - --leader-elect
            - --metrics-bind-address=:8080
            - --health-probe-bind-address=:8081
          env:
            - name: KAIAD_OPERATOR_NAMESPACE
              valueFrom:
                fieldRef:
                  fieldPath: metadata.namespace
          ports:
            - name: metrics
              containerPort: 8080
            - name: health
              containerPort: 8081
          livenessProbe:
            httpGet:
              path: /healthz
              port: health
          readinessProbe:
            httpGet:
              path: /readyz
              port: health
          securityContext:
            allowPrivilegeEscalation: false
            capabilities:
              drop: ["ALL"]
            readOnlyRootFilesystem: true
          resources:
            requests:
              cpu: 50m
              memory: 64Mi
            limits:
              cpu: 500m
              memory: 256Mi
`;

  const header = `# Kaiad operator install bundle (CRD + RBAC + Deployment).
#
# Apply with:
#   kubectl apply -f kaiad-operator-install.yaml
#
# Operator image: ${image}
# Operator namespace: ${namespace}
#
# After this is Ready, generate an enrollment token from the panel UI
# (Settings -> Enrollment tokens), create the per-agent Secret, and apply
# a KaiadAgent custom resource. See the panel UI's Kubernetes tab for the
# step-by-step quickstart.
`;

  return [
    header,
    CRD_YAML,
    namespaceManifest,
    serviceAccountManifest,
    clusterRoleManifest,
    clusterRoleBindingManifest,
    deploymentManifest
  ].join("---\n");
}
