<script setup lang="ts">
import { computed, ref } from 'vue';
import type { TrackerConnectFormProps } from './tracker-connect-form';

// AniList's sign-in (#703): the implicit grant. "Open AniList" runs
// `tracker:begin-auth`, which opens AniList's authorization screen and then its
// pin page with the token; the user pastes it here, and `tracker:complete-auth`
// checks it with `Viewer` before anything is stored.
const props = defineProps<TrackerConnectFormProps>();

const opened = ref(false);
const authUrl = ref('');
const token = ref('');
const connecting = ref(false);
const error = ref('');
const connectedAs = ref('');

function resultError(result: TrackerAuthResult): string | null {
  switch (result.status) {
    case 'error':
      return result.message;
    case 'offline':
      return 'You’re offline. Connect to the internet to sign in to AniList.';
    case 'needs-setup':
      return 'AniList sign-in needs setting up first.';
    default:
      return null;
  }
}

// The card discards this promise (Sign in again, Reconnect), so a failure is
// shown here. `tracker:begin-auth` stays pending until the sign-in finishes;
// the paste field shows at once.
async function begin(): Promise<void> {
  error.value = '';
  connectedAs.value = '';
  opened.value = true;
  try {
    const result = await window.api.trackerBeginAuth('anilist');
    if (result.status === 'open-failed' || result.status === 'port-busy') {
      authUrl.value = result.authorizeUrl;
      return;
    }
    const message = resultError(result);
    if (message) {
      error.value = message;
      if (result.status !== 'error') opened.value = false;
    }
  } catch (err) {
    error.value = String(err);
    opened.value = false;
  }
}

function copyUrl(): void {
  void navigator.clipboard.writeText(authUrl.value);
}

async function signIn(value: string): Promise<TrackerUser> {
  const result = await window.api.trackerCompleteAuth('anilist', value);
  if (result.status === 'connected' && result.account.user) return result.account.user;
  if (result.status === 'cancelled') throw new Error('The sign-in was cancelled.');
  throw new Error(resultError(result) ?? 'The sign-in didn’t finish.');
}

async function submit(): Promise<void> {
  const value = token.value.trim();
  if (!value) return;
  connecting.value = true;
  error.value = '';
  let user: TrackerUser | null = null;
  try {
    await props.complete(async () => {
      user = await signIn(value);
      return user;
    });
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
    return;
  } finally {
    connecting.value = false;
  }
  connectedAs.value = user ? (user as TrackerUser).nickname : '';
  token.value = '';
  authUrl.value = '';
  opened.value = false;
}

function reset(): void {
  opened.value = false;
  authUrl.value = '';
  token.value = '';
  error.value = '';
  connectedAs.value = '';
}

// A sign-in in progress, or the reason one couldn't start.
const active = computed(() => Boolean(opened.value || error.value));

defineExpose({ active, begin, reset });
</script>

<template>
  <div v-if="!opened">
    <button class="btn btn-sm btn-primary anilist-open" @click="begin">Open AniList</button>
  </div>
  <div v-else class="anilist-auth">
    <div v-if="authUrl" class="anilist-url-block">
      <p class="sr-desc">Could not open the browser. Copy the link and open it yourself.</p>
      <div class="anilist-url-row">
        <span class="path-input anilist-url">{{ authUrl }}</span>
        <button class="btn btn-sm" @click="copyUrl">Copy Link</button>
      </div>
    </div>
    <p v-else class="sr-desc">
      AniList opened in your browser. Authorize the app there.
      <button class="btn btn-sm btn-outline anilist-reopen" @click="begin">Open AniList</button>
    </p>
    <p class="sr-desc anilist-hint">
      AniList shows a long token after you authorize. Copy all of it.
    </p>
    <div class="token-row">
      <input
        v-model="token"
        type="password"
        class="field-input token-input anilist-token"
        placeholder="Paste the token from AniList..."
        autocomplete="off"
        @keydown.enter="submit"
      />
      <button
        class="btn btn-sm btn-primary anilist-submit"
        :disabled="!token.trim() || connecting"
        @click="submit"
      >
        {{ connecting ? 'Checking...' : 'Submit' }}
      </button>
    </div>
  </div>
  <div v-if="connectedAs" class="inline-result ok connected-as">Connected as {{ connectedAs }}</div>
  <div v-if="error" class="inline-result bad connect-error">{{ error }}</div>
</template>

<style scoped src="@renderer/assets/settings-tabs.css"></style>

<style scoped>
.connect-error,
.connected-as {
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

.anilist-auth {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.anilist-url-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.anilist-url {
  user-select: all;
  word-break: break-all;
}

.anilist-reopen {
  margin-left: 6px;
}
</style>
