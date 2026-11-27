<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { storeToRefs } from 'pinia';
import { useTrackersStore } from '../../stores/trackers';
import type { TrackerConnectFormProps } from './tracker-connect-form';

// MyAnimeList's connect body (#702): the guided setup of the user's own MAL
// app (the app ships no MAL client ID), the client ID and optional secret, the
// Test, and the loopback sign-in with its paste fallback. Main owns the
// attempt (`tracker:begin-auth`); a busy port never opens the browser until
// the user clicks Open anyway.
const props = defineProps<TrackerConnectFormProps>();

const REPO_URL = 'https://github.com/mikkerlo/anime-downloader';
const CREATE_URL = 'https://myanimelist.net/apiconfig/create';
const APP_NAME = 'anime-dl personal sync';
const APP_DESCRIPTION =
  'Personal client for the anime-dl desktop app. It reads and updates my own anime list on MyAnimeList.';

const { accounts } = storeToRefs(useTrackersStore());
const account = computed(() => accounts.value.find((a) => a.trackerId === 'mal') ?? null);
const connected = computed(() => Boolean(account.value?.user));
const expired = computed(() => Boolean(account.value?.sessionExpired));
const needsSetup = computed(() => Boolean(account.value?.needsSetup));

const config = ref<TrackerClientConfig | null>(null);
const clientIdInput = ref('');
const secretInput = ref('');
const saving = ref(false);
const saveError = ref('');
const testing = ref(false);
const testResult = ref<TrackerTestClientConfigResult | null>(null);

type Phase = 'idle' | 'waiting' | 'port-busy' | 'open-failed';
const phase = ref<Phase>('idle');
const authorizeUrl = ref('');
const pasteInput = ref('');
const pasting = ref(false);
const error = ref('');
const stepsToggled = ref<boolean | null>(null);

const savedClientId = computed(() => config.value?.clientId ?? null);
const redirectUri = computed(() => config.value?.redirectUri ?? '');
const port = computed(() => {
  try {
    return new URL(redirectUri.value).port;
  } catch {
    return '';
  }
});
// Expanded until a client ID is saved, and again on "Needs setup".
const stepsOpen = computed(() => stepsToggled.value ?? (!savedClientId.value || needsSetup.value));
const canConnect = computed(
  () => Boolean(savedClientId.value) && clientIdInput.value.trim() !== '' && phase.value === 'idle'
);
const showConnect = computed(() => !connected.value || expired.value);

const setupSteps = computed(() => [
  { label: 'App Name', value: APP_NAME },
  { label: 'App Type', value: 'other' },
  { label: 'App Description', value: APP_DESCRIPTION },
  { label: 'App Redirect URL', value: redirectUri.value },
  { label: 'Homepage URL', value: REPO_URL },
  { label: 'Commercial / Non-Commercial', value: 'non-commercial' },
  { label: 'Purpose of Use', value: 'hobbyist' }
]);

async function loadConfig(): Promise<void> {
  try {
    config.value = await window.api.trackerGetClientConfig('mal');
    clientIdInput.value = config.value.clientId ?? '';
  } catch (err) {
    saveError.value = messageOf(err);
  }
}

onMounted(() => void loadConfig());

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function copy(text: string): void {
  void navigator.clipboard.writeText(text);
}

function openCreatePage(): void {
  void window.api.shellOpenExternal(CREATE_URL);
}

async function save(opts: { removeSecret?: boolean } = {}): Promise<void> {
  const clientId = clientIdInput.value.trim();
  if (!clientId) return;
  saving.value = true;
  saveError.value = '';
  testResult.value = null;
  try {
    const input: TrackerClientConfigInput = { clientId };
    if (opts.removeSecret) input.secret = null;
    else if (secretInput.value) input.secret = secretInput.value;
    config.value = await window.api.trackerSetClientConfig('mal', input);
    secretInput.value = '';
  } catch (err) {
    saveError.value = messageOf(err);
  } finally {
    saving.value = false;
  }
}

async function test(): Promise<void> {
  testing.value = true;
  testResult.value = null;
  try {
    testResult.value = await window.api.trackerTestClientConfig('mal');
  } catch (err) {
    testResult.value = { ok: false, kind: 'item', message: messageOf(err) };
  } finally {
    testing.value = false;
  }
}

// An attempt main still holds (`port-busy`, `open-failed`): the paste finishes it.
class HeldAttempt extends Error {}
class Cancelled extends Error {}

function userOf(result: TrackerAuthResult): TrackerUser {
  switch (result.status) {
    case 'connected':
      if (!result.account.user) throw new Error('MyAnimeList sign-in returned no account');
      return result.account.user;
    case 'cancelled':
      throw new Cancelled();
    case 'offline':
      throw new Error('You’re offline. Connect to the internet, then press Connect again.');
    case 'needs-setup':
      throw new Error('Save your client ID first.');
    case 'port-busy':
    case 'open-failed':
      phase.value = result.status;
      authorizeUrl.value = result.authorizeUrl;
      throw new HeldAttempt();
    case 'error':
      throw new Error(result.message);
  }
}

function settleFailure(err: unknown): void {
  if (err instanceof HeldAttempt) return;
  phase.value = 'idle';
  authorizeUrl.value = '';
  if (!(err instanceof Cancelled)) error.value = messageOf(err);
}

// The card discards this promise (Reconnect), so a failure is shown here.
async function begin(): Promise<void> {
  if (!savedClientId.value || phase.value !== 'idle') return;
  error.value = '';
  pasteInput.value = '';
  phase.value = 'waiting';
  try {
    await props.complete(async () => userOf(await window.api.trackerBeginAuth('mal')));
    phase.value = 'idle';
    authorizeUrl.value = '';
  } catch (err) {
    settleFailure(err);
  }
}

async function cancel(): Promise<void> {
  await window.api.trackerCancelAuth('mal');
  phase.value = 'idle';
  authorizeUrl.value = '';
  pasteInput.value = '';
}

// From this click only: whoever holds the port receives the code.
function openAnyway(): void {
  void window.api.shellOpenExternal(authorizeUrl.value);
}

async function submitPaste(): Promise<void> {
  const url = pasteInput.value.trim();
  if (!url) return;
  error.value = '';
  pasting.value = true;
  try {
    if (phase.value === 'waiting') {
      // The pending Connect resolves with this exchange: only a refusal is ours.
      const result = await window.api.trackerCompleteAuth('mal', url);
      if (result.status === 'error') error.value = result.message;
      return;
    }
    await props.complete(async () => userOf(await window.api.trackerCompleteAuth('mal', url)));
    phase.value = 'idle';
    authorizeUrl.value = '';
    pasteInput.value = '';
  } catch (err) {
    if (err instanceof HeldAttempt) return;
    if (!(err instanceof Cancelled)) error.value = messageOf(err);
  } finally {
    pasting.value = false;
  }
}

function reset(): void {
  phase.value = 'idle';
  authorizeUrl.value = '';
  pasteInput.value = '';
  error.value = '';
}

// A sign-in in progress, the reason one couldn't start, or setup to finish.
const active = computed(() => phase.value !== 'idle' || Boolean(error.value) || needsSetup.value);

defineExpose({ active, begin, reset });
</script>

<template>
  <div class="mal-form">
    <div class="mal-steps">
      <button class="btn btn-sm btn-ghost steps-toggle" @click="stepsToggled = !stepsOpen">
        {{ stepsOpen ? 'Hide setup steps' : 'Setup steps' }}
      </button>
      <ol v-if="stepsOpen" class="steps-list" data-testid="mal-setup-steps">
        <li>
          Create an app on MyAnimeList:
          <a href="#" class="mal-link" @click.prevent="openCreatePage">{{ CREATE_URL }}</a>
          . Already have a client ID? Reuse it: MyAnimeList allows at most 5 per account.
          <ul class="step-values">
            <li v-for="s in setupSteps" :key="s.label" class="step-value">
              <span class="step-label">{{ s.label }}:</span>
              <span class="path-input step-text">{{ s.value }}</span>
              <button class="btn btn-sm" @click="copy(s.value)">Copy</button>
            </li>
            <li class="step-value">
              <span class="step-label">Name/Company Name:</span> your own name
            </li>
            <li class="step-value">Tick the API agreement, then Submit.</li>
          </ul>
          <p class="sr-desc">The redirect URL must be the only line in its field.</p>
        </li>
        <li>Back on the list (Return to list), open your app with Edit and copy its Client ID.</li>
        <li>Paste the Client ID below, save it, and press Test.</li>
      </ol>
    </div>

    <div class="mal-row">
      <input
        v-model="clientIdInput"
        type="text"
        class="field-input mal-input"
        placeholder="Client ID"
        data-testid="mal-client-id"
      />
      <button
        class="btn btn-sm"
        :disabled="!clientIdInput.trim() || saving"
        data-testid="mal-save"
        @click="save()"
      >
        {{ saving ? 'Saving...' : 'Save' }}
      </button>
      <button
        class="btn btn-sm"
        :disabled="!savedClientId || testing"
        data-testid="mal-test"
        @click="test"
      >
        {{ testing ? 'Testing...' : 'Test' }}
      </button>
    </div>
    <div class="mal-row">
      <template v-if="config?.hasSecret">
        <span class="sr-desc" data-testid="mal-secret-saved">A secret is saved</span>
        <button
          class="btn btn-sm btn-outline"
          :disabled="saving"
          data-testid="mal-remove-secret"
          @click="save({ removeSecret: true })"
        >
          Remove
        </button>
      </template>
      <input
        v-else
        v-model="secretInput"
        type="password"
        autocomplete="off"
        class="field-input mal-input"
        placeholder="Client secret (optional)"
        data-testid="mal-secret"
      />
    </div>
    <div v-if="saveError" class="inline-result bad">{{ saveError }}</div>
    <div
      v-if="testResult"
      class="inline-result"
      :class="testResult.ok ? 'ok' : 'bad'"
      data-testid="mal-test-result"
    >
      {{ testResult.ok ? 'Client ID works' : testResult.message }}
    </div>

    <div v-if="showConnect && phase === 'idle'">
      <button
        class="btn btn-sm btn-primary"
        :disabled="!canConnect"
        data-testid="mal-connect"
        @click="begin"
      >
        Connect MyAnimeList
      </button>
    </div>

    <div v-else-if="phase !== 'idle'" class="mal-auth" data-testid="mal-auth">
      <p v-if="phase === 'waiting'" class="sr-desc">Waiting for MyAnimeList in your browser…</p>
      <template v-else>
        <p v-if="phase === 'port-busy'" class="sr-warn" data-testid="mal-port-busy">
          Another app is using port {{ port }}. Whatever holds that port receives the sign-in code,
          so the browser wasn’t opened.
        </p>
        <p v-else class="sr-desc">
          Could not open the browser. Copy the link and open it yourself.
        </p>
        <div class="mal-row">
          <button
            v-if="phase === 'port-busy'"
            class="btn btn-sm"
            data-testid="mal-open-anyway"
            @click="openAnyway"
          >
            Open anyway
          </button>
          <button class="btn btn-sm" data-testid="mal-copy-link" @click="copy(authorizeUrl)">
            Copy link
          </button>
        </div>
      </template>
      <p class="sr-desc">Browser shows an error? Paste its address here.</p>
      <div class="mal-row">
        <input
          v-model="pasteInput"
          type="text"
          class="field-input mal-input"
          placeholder="http://localhost:…/callback?code=…"
          data-testid="mal-paste"
          @keydown.enter="submitPaste"
        />
        <button
          class="btn btn-sm btn-primary"
          :disabled="!pasteInput.trim() || pasting"
          data-testid="mal-paste-submit"
          @click="submitPaste"
        >
          Submit
        </button>
        <button class="btn btn-sm btn-outline" data-testid="mal-cancel" @click="cancel">
          Cancel
        </button>
      </div>
    </div>
    <div v-if="error" class="inline-result bad" data-testid="mal-error">{{ error }}</div>
  </div>
</template>

<style scoped src="@renderer/assets/settings-tabs.css"></style>

<style scoped>
.mal-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.mal-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.mal-input {
  flex: 1;
}

.mal-auth {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.steps-toggle {
  align-self: flex-start;
}

.steps-list {
  margin: 0;
  padding-left: 20px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 0.82rem;
}

.step-values {
  list-style: none;
  padding: 0;
  margin: 6px 0 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.step-value {
  display: flex;
  align-items: center;
  gap: 8px;
}

.step-label {
  flex-shrink: 0;
  min-width: 190px;
}

.step-text {
  flex: 1;
  user-select: all;
  overflow-wrap: anywhere;
}

.mal-link {
  color: var(--st-blue);
  text-decoration: none;
}

.mal-link:hover {
  text-decoration: underline;
}
</style>
