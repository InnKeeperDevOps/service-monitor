<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { api } from "../../lib/api.js";
import Button from "../../components/Button.vue";
import Input from "../../components/Input.vue";

type WizardStep = "welcome" | "infra" | "admin" | "oauth" | "tenant" | "k8s" | "review";
const STEPS: WizardStep[] = ["welcome", "infra", "admin", "oauth", "tenant", "k8s", "review"];
const STEP_LABELS: Record<WizardStep, string> = {
  welcome: "Welcome",
  infra: "Infrastructure",
  admin: "Admin Account",
  oauth: "OAuth",
  tenant: "Webhook Tenant",
  k8s: "Kubernetes",
  review: "Review & Finish"
};

const step = ref(0);
const publicBaseUrl = ref(window.location.origin);
const databaseUrl = ref("");
const redisUrl = ref("");
const adminEmail = ref("");
const adminPassword = ref("");
const confirmPassword = ref("");
const enableOAuth = ref(false);
const googleClientId = ref("");
const googleClientSecret = ref("");
const tenants = ref<{ id: string; name: string }[]>([]);
const selectedTenantId = ref("");
const k8sNamespace = ref("");

const dbTestOk = ref<boolean | null>(null);
const dbTestError = ref("");
const dbTesting = ref(false);
const redisTestOk = ref<boolean | null>(null);
const redisTestError = ref("");
const redisTesting = ref(false);

const submitting = ref(false);
const submitError = ref("");

watch(databaseUrl, () => {
  dbTestOk.value = null;
  dbTestError.value = "";
});
watch(redisUrl, () => {
  redisTestOk.value = null;
  redisTestError.value = "";
});

async function testDb() {
  dbTesting.value = true;
  dbTestOk.value = null;
  dbTestError.value = "";
  try {
    await api.testDatabase(databaseUrl.value);
    dbTestOk.value = true;
    try {
      const res = await api.getSetupTenants(databaseUrl.value);
      tenants.value = res.tenants;
    } catch {
      /* ignore */
    }
  } catch (err) {
    dbTestOk.value = false;
    dbTestError.value = (err as Error).message;
  } finally {
    dbTesting.value = false;
  }
}

async function testRedis() {
  redisTesting.value = true;
  redisTestOk.value = null;
  redisTestError.value = "";
  try {
    await api.testRedis(redisUrl.value);
    redisTestOk.value = true;
  } catch (err) {
    redisTestOk.value = false;
    redisTestError.value = (err as Error).message;
  } finally {
    redisTesting.value = false;
  }
}

async function handleFinish() {
  submitting.value = true;
  submitError.value = "";
  try {
    await api.completeSetup({
      databaseUrl: databaseUrl.value,
      redisUrl: redisUrl.value,
      publicBaseUrl: publicBaseUrl.value,
      adminEmail: adminEmail.value,
      adminPassword: adminPassword.value,
      googleClientId: enableOAuth.value ? googleClientId.value : undefined,
      googleClientSecret: enableOAuth.value ? googleClientSecret.value : undefined,
      defaultWebhookTenantId: selectedTenantId.value || undefined,
      kubernetesNamespace: k8sNamespace.value || undefined
    });
    window.location.hash = "login";
    window.location.reload();
  } catch (err) {
    submitError.value = (err as Error).message;
  } finally {
    submitting.value = false;
  }
}

const currentStep = computed(() => STEPS[step.value]);
const infraValid = computed(() => dbTestOk.value === true && redisTestOk.value === true);
const adminValid = computed(
  () => adminEmail.value.length > 0 && adminPassword.value.length >= 8 && adminPassword.value === confirmPassword.value
);
const canAdvance = computed(() => {
  switch (currentStep.value) {
    case "welcome":
      return true;
    case "infra":
      return infraValid.value;
    case "admin":
      return adminValid.value;
    default:
      return true;
  }
});

const isFirst = computed(() => step.value === 0);
const isLast = computed(() => step.value === STEPS.length - 1);
const isSkippable = computed(
  () => currentStep.value === "oauth" || currentStep.value === "tenant" || currentStep.value === "k8s"
);

const adminPasswordError = computed(() =>
  adminPassword.value.length > 0 && adminPassword.value.length < 8 ? "Password must be at least 8 characters" : ""
);
const confirmPasswordError = computed(() =>
  confirmPassword.value.length > 0 && confirmPassword.value !== adminPassword.value ? "Passwords do not match" : ""
);
</script>

<template>
  <div
    :style="{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: '100vh',
      background: 'var(--color-canvas)',
      padding: '2rem 1rem'
    }"
  >
    <div
      :style="{
        width: '520px',
        maxWidth: '100%',
        background: 'var(--color-surface)',
        border: '1px solid var(--color-border)',
        borderRadius: '12px',
        padding: '2rem'
      }"
    >
      <div :style="{ display: 'flex', gap: '0.25rem', justifyContent: 'center', marginBottom: '1.5rem', flexWrap: 'wrap' }">
        <div
          v-for="(s, i) in STEPS"
          :key="s"
          :style="{
            display: 'flex',
            alignItems: 'center',
            gap: '0.25rem',
            color: i <= step ? 'var(--color-primary)' : 'var(--color-text-muted)',
            fontSize: '0.75rem',
            fontWeight: i === step ? 600 : 400
          }"
        >
          <span
            :style="{
              width: '22px',
              height: '22px',
              borderRadius: '50%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '0.7rem',
              fontWeight: 700,
              background: i < step ? 'var(--color-primary)' : i === step ? 'var(--color-primary-subtle)' : 'var(--color-surface-muted)',
              color: i < step ? '#fff' : i === step ? 'var(--color-primary)' : 'var(--color-text-muted)',
              border: i === step ? '2px solid var(--color-primary)' : '1px solid var(--color-border)'
            }"
          >{{ i < step ? "✓" : i + 1 }}</span>
          <span :style="{ display: i === step ? 'inline' : 'none' }">{{ STEP_LABELS[s] }}</span>
          <span v-if="i < STEPS.length - 1" :style="{ color: 'var(--color-border-strong)', margin: '0 0.15rem' }">—</span>
        </div>
      </div>

      <template v-if="currentStep === 'welcome'">
        <h2 :style="{ margin: '0 0 0.25rem', fontSize: '1.1rem', fontWeight: 700 }">Welcome to Kaiad</h2>
        <p :style="{ margin: '0 0 1.25rem', color: 'var(--color-text-secondary)', fontSize: '0.85rem' }">
          Let's configure your instance. This wizard will guide you through setting up infrastructure, an admin account,
          and optional integrations.
        </p>
        <Input
          label="Public Base URL"
          :model-value="publicBaseUrl"
          placeholder="https://kaiad.example.com"
          @update:model-value="(v: string) => (publicBaseUrl = v)"
        />
      </template>

      <template v-else-if="currentStep === 'infra'">
        <h2 :style="{ margin: '0 0 0.25rem', fontSize: '1.1rem', fontWeight: 700 }">Infrastructure</h2>
        <p :style="{ margin: '0 0 1.25rem', color: 'var(--color-text-secondary)', fontSize: '0.85rem' }">
          Configure your database and cache connections.
        </p>
        <div :style="{ display: 'flex', flexDirection: 'column', gap: '1rem' }">
          <div>
            <Input
              label="Database URL"
              :model-value="databaseUrl"
              placeholder="postgres://user:pass@host:5432/kaiad"
              @update:model-value="(v: string) => (databaseUrl = v)"
            />
            <div :style="{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.5rem' }">
              <Button size="sm" variant="secondary" :disabled="!databaseUrl || dbTesting" @click="testDb">
                Test Connection
              </Button>
              <span v-if="dbTesting" :style="{ fontSize: '0.8rem', color: 'var(--color-text-muted)' }">Testing…</span>
              <span v-else-if="dbTestOk === true" :style="{ fontSize: '0.8rem', color: 'var(--color-success)' }">✓ Connected</span>
              <span v-else-if="dbTestOk === false" :style="{ fontSize: '0.8rem', color: 'var(--color-danger)' }">
                ✗ {{ dbTestError || "Failed" }}
              </span>
            </div>
          </div>
          <div>
            <Input
              label="Redis URL"
              :model-value="redisUrl"
              placeholder="redis://host:6379"
              @update:model-value="(v: string) => (redisUrl = v)"
            />
            <div :style="{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.5rem' }">
              <Button size="sm" variant="secondary" :disabled="!redisUrl || redisTesting" @click="testRedis">
                Test Connection
              </Button>
              <span v-if="redisTesting" :style="{ fontSize: '0.8rem', color: 'var(--color-text-muted)' }">Testing…</span>
              <span v-else-if="redisTestOk === true" :style="{ fontSize: '0.8rem', color: 'var(--color-success)' }">✓ Connected</span>
              <span v-else-if="redisTestOk === false" :style="{ fontSize: '0.8rem', color: 'var(--color-danger)' }">
                ✗ {{ redisTestError || "Failed" }}
              </span>
            </div>
          </div>
        </div>
      </template>

      <template v-else-if="currentStep === 'admin'">
        <h2 :style="{ margin: '0 0 0.25rem', fontSize: '1.1rem', fontWeight: 700 }">Admin Account</h2>
        <p :style="{ margin: '0 0 1.25rem', color: 'var(--color-text-secondary)', fontSize: '0.85rem' }">
          Create the first administrator account.
        </p>
        <div :style="{ display: 'flex', flexDirection: 'column', gap: '1rem' }">
          <Input
            label="Email"
            type="email"
            :model-value="adminEmail"
            placeholder="admin@example.com"
            @update:model-value="(v: string) => (adminEmail = v)"
          />
          <Input
            label="Password"
            type="password"
            :model-value="adminPassword"
            placeholder="Min 8 characters"
            :error="adminPasswordError || undefined"
            @update:model-value="(v: string) => (adminPassword = v)"
          />
          <Input
            label="Confirm Password"
            type="password"
            :model-value="confirmPassword"
            placeholder="Re-enter password"
            :error="confirmPasswordError || undefined"
            @update:model-value="(v: string) => (confirmPassword = v)"
          />
        </div>
      </template>

      <template v-else-if="currentStep === 'oauth'">
        <h2 :style="{ margin: '0 0 0.25rem', fontSize: '1.1rem', fontWeight: 700 }">OAuth Provider</h2>
        <p :style="{ margin: '0 0 1.25rem', color: 'var(--color-text-secondary)', fontSize: '0.85rem' }">
          Optional. Enable Google OAuth for user sign-in.
        </p>
        <label
          :style="{
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            marginBottom: '1rem',
            fontSize: '0.9rem',
            cursor: 'pointer'
          }"
        >
          <input v-model="enableOAuth" type="checkbox" :style="{ accentColor: 'var(--color-primary)' }" />
          Enable Google OAuth
        </label>
        <div v-if="enableOAuth" :style="{ display: 'flex', flexDirection: 'column', gap: '1rem' }">
          <Input
            label="Client ID"
            :model-value="googleClientId"
            placeholder="xxxx.apps.googleusercontent.com"
            @update:model-value="(v: string) => (googleClientId = v)"
          />
          <Input
            label="Client Secret"
            type="password"
            :model-value="googleClientSecret"
            placeholder="GOCSPX-..."
            @update:model-value="(v: string) => (googleClientSecret = v)"
          />
        </div>
      </template>

      <template v-else-if="currentStep === 'tenant'">
        <h2 :style="{ margin: '0 0 0.25rem', fontSize: '1.1rem', fontWeight: 700 }">Webhook Tenant</h2>
        <p :style="{ margin: '0 0 1.25rem', color: 'var(--color-text-secondary)', fontSize: '0.85rem' }">
          Optional. Select a default tenant for incoming webhooks.
        </p>
        <p v-if="tenants.length === 0" :style="{ fontSize: '0.85rem', color: 'var(--color-text-muted)' }">
          No tenants found. Tenants will be created after setup is complete.
        </p>
        <div v-else class="sm-input-wrapper">
          <label class="sm-input-label" for="tenant-select">Default Tenant</label>
          <select id="tenant-select" v-model="selectedTenantId" class="sm-input">
            <option value="">— None —</option>
            <option v-for="t in tenants" :key="t.id" :value="t.id">{{ t.name }} ({{ t.id }})</option>
          </select>
        </div>
      </template>

      <template v-else-if="currentStep === 'k8s'">
        <h2 :style="{ margin: '0 0 0.25rem', fontSize: '1.1rem', fontWeight: 700 }">Kubernetes</h2>
        <p :style="{ margin: '0 0 1.25rem', color: 'var(--color-text-secondary)', fontSize: '0.85rem' }">
          Optional. Configure Kubernetes namespace for agent workloads.
        </p>
        <Input
          label="Namespace"
          :model-value="k8sNamespace"
          placeholder="kaiad-agents"
          @update:model-value="(v: string) => (k8sNamespace = v)"
        />
      </template>

      <template v-else-if="currentStep === 'review'">
        <h2 :style="{ margin: '0 0 0.25rem', fontSize: '1.1rem', fontWeight: 700 }">Review &amp; Finish</h2>
        <p :style="{ margin: '0 0 1.25rem', color: 'var(--color-text-secondary)', fontSize: '0.85rem' }">
          Confirm your settings, then click Finish to complete setup.
        </p>
        <div :style="{ display: 'flex', flexDirection: 'column', gap: '0.1rem' }">
          <div
            v-for="row in [
              { label: 'Public Base URL', value: publicBaseUrl },
              { label: 'Database URL', value: databaseUrl },
              { label: 'Redis URL', value: redisUrl },
              { label: 'Admin Email', value: adminEmail },
              { label: 'Admin Password', value: adminPassword ? '••••••••' : undefined },
              { label: 'Google OAuth', value: enableOAuth ? 'Enabled' : 'Disabled' },
              { label: 'Google Client ID', value: enableOAuth ? googleClientId : undefined },
              { label: 'Webhook Tenant', value: selectedTenantId || '(none)' },
              { label: 'K8s Namespace', value: k8sNamespace || '(none)' }
            ]"
            :key="row.label"
          >
            <div
              v-if="row.value"
              :style="{
                display: 'flex',
                gap: '0.5rem',
                fontSize: '0.85rem',
                padding: '0.35rem 0',
                borderBottom: '1px solid var(--color-border)'
              }"
            >
              <span :style="{ fontWeight: 500, minWidth: '150px', color: 'var(--color-text-secondary)' }">{{ row.label }}</span>
              <span :style="{ wordBreak: 'break-all' }">{{ row.value }}</span>
            </div>
          </div>
        </div>
        <div
          v-if="submitError"
          role="alert"
          :style="{
            padding: '0.5rem 0.75rem',
            marginTop: '1rem',
            background: 'var(--color-danger-bg)',
            color: 'var(--color-danger)',
            border: '1px solid var(--color-danger)',
            borderRadius: '8px',
            fontSize: '0.85rem'
          }"
        >{{ submitError }}</div>
      </template>

      <div
        :style="{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginTop: '1.5rem',
          gap: '0.5rem'
        }"
      >
        <div>
          <Button v-if="!isFirst" variant="ghost" @click="step = step - 1">← Back</Button>
        </div>
        <div :style="{ display: 'flex', gap: '0.5rem' }">
          <Button v-if="isSkippable && !isLast" variant="ghost" @click="step = step + 1">Skip</Button>
          <Button v-if="isLast" :loading="submitting" :disabled="submitting" @click="handleFinish">
            Finish Setup
          </Button>
          <Button v-else :disabled="!canAdvance" @click="step = step + 1">Next →</Button>
        </div>
      </div>
    </div>
  </div>
</template>
