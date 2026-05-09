<script setup lang="ts">
import { onMounted, ref } from "vue";
import { api, type AuthProviderEntry } from "../../lib/api.js";
import Button from "../../components/Button.vue";
import Input from "../../components/Input.vue";

const email = ref("");
const password = ref("");
const error = ref<string | null>(null);
const loading = ref(false);
const providers = ref<AuthProviderEntry[]>([]);
const oauthLoading = ref<string | null>(null);

onMounted(async () => {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  const state = params.get("state");
  if (code && state) {
    loading.value = true;
    try {
      const { token } = await api.handleOAuthCallback(code, state);
      localStorage.setItem("sm_token", token);
      window.history.replaceState({}, "", window.location.pathname);
      window.location.hash = "dashboard";
      window.location.reload();
    } catch (err) {
      error.value = (err as Error).message;
      loading.value = false;
    }
  }
  try {
    const res = await api.getAuthProviders();
    providers.value = res.providers;
  } catch {
    /* ignore */
  }
});

async function handleSubmit(e: Event) {
  e.preventDefault();
  error.value = null;
  loading.value = true;
  try {
    const { token } = await api.login(email.value, password.value);
    localStorage.setItem("sm_token", token);
    window.location.hash = "dashboard";
    window.location.reload();
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    loading.value = false;
  }
}

async function handleOAuthLogin(provider: AuthProviderEntry) {
  oauthLoading.value = provider.id;
  error.value = null;
  try {
    const { authorizeUrl } = await api.getOAuthAuthorizeUrl(provider.id);
    window.location.href = authorizeUrl;
  } catch (err) {
    error.value = (err as Error).message;
    oauthLoading.value = null;
  }
}
</script>

<template>
  <div
    :style="{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: '100vh',
      background: 'var(--color-canvas)'
    }"
  >
    <form
      :style="{
        width: '360px',
        background: 'var(--color-surface)',
        border: '1px solid var(--color-border)',
        borderRadius: '12px',
        padding: '2rem'
      }"
      @submit="handleSubmit"
    >
      <h1 :style="{ margin: '0 0 0.25rem', fontSize: '1.25rem', fontWeight: 700 }">Kaiad</h1>
      <p :style="{ margin: '0 0 1.5rem', color: 'var(--color-text-secondary)', fontSize: '0.9rem' }">
        Sign in to continue
      </p>

      <div
        v-if="error"
        role="alert"
        :style="{
          padding: '0.5rem 0.75rem',
          marginBottom: '1rem',
          background: 'var(--color-danger-bg)',
          color: 'var(--color-danger)',
          border: '1px solid var(--color-danger)',
          borderRadius: '8px',
          fontSize: '0.85rem'
        }"
      >
        {{ error }}
      </div>

      <div :style="{ display: 'flex', flexDirection: 'column', gap: '1rem', marginBottom: '1.25rem' }">
        <Input
          label="Email"
          type="email"
          required
          :model-value="email"
          placeholder="you@example.com"
          @update:model-value="(v: string) => (email = v)"
        />
        <Input
          label="Password"
          type="password"
          required
          :model-value="password"
          placeholder="••••••••"
          @update:model-value="(v: string) => (password = v)"
        />
      </div>

      <Button type="submit" :loading="loading" :class-name="'sm-btn--full'">Sign in</Button>

      <div v-if="providers.length > 0" :style="{ marginTop: '1.5rem' }">
        <div
          :style="{
            display: 'flex',
            alignItems: 'center',
            gap: '0.75rem',
            marginBottom: '1rem',
            color: 'var(--color-text-secondary)',
            fontSize: '0.8rem'
          }"
        >
          <span :style="{ flex: 1, height: '1px', background: 'var(--color-border)' }" />
          or
          <span :style="{ flex: 1, height: '1px', background: 'var(--color-border)' }" />
        </div>
        <div :style="{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }">
          <Button
            v-for="p in providers"
            :key="p.id"
            type="button"
            variant="secondary"
            :loading="oauthLoading === p.id"
            @click="handleOAuthLogin(p)"
          >
            Sign in with {{ p.name }}
          </Button>
        </div>
      </div>
    </form>
  </div>
</template>
