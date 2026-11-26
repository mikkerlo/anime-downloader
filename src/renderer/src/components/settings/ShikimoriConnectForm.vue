<script setup lang="ts">
import { computed, ref } from 'vue';
import type { TrackerConnectFormProps } from './tracker-connect-form';

// Shikimori's out-of-band code paste, unchanged since it lived in Connectors.
// It stays on `shikimori:get-auth-url` / `shikimori:exchange-code` for good
// (#700): unlike `tracker:begin-auth`, they don't refuse while offline.
const props = defineProps<TrackerConnectFormProps>();

const authUrl = ref('');
const code = ref('');
const connecting = ref(false);
const error = ref('');
const showUrl = ref(false);

// The card discards this promise (Reconnect), so a failure is shown here.
async function begin(): Promise<void> {
  error.value = '';
  try {
    authUrl.value = await window.api.shikimoriGetAuthUrl();
    const opened = await window.api.shellOpenExternal(authUrl.value);
    showUrl.value = !opened;
  } catch (err) {
    error.value = String(err);
  }
}

function copyUrl(): void {
  void navigator.clipboard.writeText(authUrl.value);
}

async function submit(): Promise<void> {
  const value = code.value.trim();
  if (!value) return;
  connecting.value = true;
  error.value = '';
  try {
    await props.complete(() => window.api.shikimoriExchangeCode(value));
  } catch (err) {
    error.value = String(err);
    return;
  } finally {
    connecting.value = false;
  }
  code.value = '';
  authUrl.value = '';
}

function reset(): void {
  authUrl.value = '';
  code.value = '';
  error.value = '';
}

// A sign-in in progress, or the reason one couldn't start.
const active = computed(() => Boolean(authUrl.value || error.value));

defineExpose({ active, begin, reset });
</script>

<template>
  <div v-if="!authUrl">
    <button class="btn btn-sm btn-primary" @click="begin">Connect Shikimori</button>
  </div>
  <div v-else class="shikimori-auth">
    <div v-if="showUrl">
      <p class="sr-desc">
        Could not open browser. Copy the link and open it manually, then paste the code.
      </p>
      <div class="shikimori-url-row">
        <span class="path-input shikimori-url">{{ authUrl }}</span>
        <button class="btn btn-sm" @click="copyUrl">Copy Link</button>
      </div>
    </div>
    <p v-else class="sr-desc">
      A browser window has opened. Authorize the app, then paste the code below.
      <a href="#" class="shiki-show-url" @click.prevent="showUrl = true">Show link</a>
    </p>
    <div class="token-row">
      <input
        v-model="code"
        type="text"
        class="field-input token-input"
        placeholder="Paste authorization code..."
        @keydown.enter="submit"
      />
      <button class="btn btn-sm btn-primary" :disabled="!code.trim() || connecting" @click="submit">
        {{ connecting ? 'Connecting...' : 'Submit' }}
      </button>
    </div>
  </div>
  <div v-if="error" class="inline-result bad connect-error">{{ error }}</div>
</template>

<style scoped src="@renderer/assets/settings-tabs.css"></style>

<style scoped>
.connect-error {
  margin-top: 10px;
}

.token-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.token-input {
  flex: 1;
}

.shikimori-auth {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.shikimori-url-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.shikimori-url {
  user-select: all;
}

.shiki-show-url {
  color: var(--st-blue);
  text-decoration: none;
  font-size: 0.8rem;
}

.shiki-show-url:hover {
  text-decoration: underline;
}
</style>
