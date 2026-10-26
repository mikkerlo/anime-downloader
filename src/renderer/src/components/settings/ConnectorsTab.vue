<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue';
import { storeToRefs } from 'pinia';
import { useShikimoriStore } from '../../stores/shikimori';
import { useSettingsAutosave } from '../../composables/use-settings-autosave';
import SettingsGroup from './SettingsGroup.vue';
import SettingsRow from './SettingsRow.vue';
import ShikimoriPendingDialog from './ShikimoriPendingDialog.vue';

const shikimoriStore = useShikimoriStore();
const { user: shikimoriUser, sessionExpired, offlineQueueLength } = storeToRefs(shikimoriStore);
const { autoSave } = useSettingsAutosave();

const loaded = ref(false);

const token = ref('');
const tokenStatus = ref<'idle' | 'checking' | 'valid' | 'invalid'>('idle');
const tokenError = ref('');

const shikimoriAuthUrl = ref('');
const shikimoriCode = ref('');
const shikimoriConnecting = ref(false);
const shikimoriError = ref('');
const shikimoriShowUrl = ref(false);

async function testToken(): Promise<void> {
  tokenStatus.value = 'checking';
  tokenError.value = '';
  try {
    const result = await window.api.validateToken();
    if (result.valid) {
      tokenStatus.value = 'valid';
    } else {
      tokenStatus.value = 'invalid';
      tokenError.value = result.error || 'Invalid token';
    }
  } catch (err) {
    tokenStatus.value = 'invalid';
    tokenError.value = String(err);
  }
}

async function shikimoriConnect(): Promise<void> {
  shikimoriAuthUrl.value = await window.api.shikimoriGetAuthUrl();
  const opened = await window.api.shellOpenExternal(shikimoriAuthUrl.value);
  shikimoriShowUrl.value = !opened;
}

function shikimoriCopyUrl(): void {
  void navigator.clipboard.writeText(shikimoriAuthUrl.value);
}

// Unsynced changes kept for accounts other than the signed-in one (#588).
const parkedQueues = ref<ShikiParkedQueueSummary[]>([]);
const keptQueues = computed(() =>
  parkedQueues.value.filter((p) => p.ownerId === null || p.ownerId !== shikimoriUser.value?.id)
);

type PendingDialog =
  | { mode: 'disconnect'; count: number; nickname: string }
  | { mode: 'switch'; count: number; nickname: string; ownerId: number; newNickname: string }
  | { mode: 'discard'; count: number; nickname: string | null; ownerId: number | null };
const pendingDialog = ref<PendingDialog | null>(null);

async function loadParkedQueues(): Promise<void> {
  parkedQueues.value = await window.api.shikimoriGetParkedQueues();
}

async function shikimoriSubmitCode(): Promise<void> {
  const code = shikimoriCode.value.trim();
  if (!code) return;
  shikimoriConnecting.value = true;
  shikimoriError.value = '';
  const prev = shikimoriUser.value;
  try {
    const next = await window.api.shikimoriExchangeCode(code);
    shikimoriUser.value = next;
    shikimoriCode.value = '';
    shikimoriAuthUrl.value = '';
    await loadParkedQueues();
    const kept =
      prev && prev.id !== next.id && parkedQueues.value.find((p) => p.ownerId === prev.id);
    if (prev && kept) {
      pendingDialog.value = {
        mode: 'switch',
        count: kept.count,
        nickname: prev.nickname,
        ownerId: prev.id,
        newNickname: next.nickname
      };
    }
  } catch (err) {
    shikimoriError.value = String(err);
  } finally {
    shikimoriConnecting.value = false;
  }
}

async function logout(opts?: ShikiLogoutOptions): Promise<void> {
  await window.api.shikimoriLogout(opts);
  shikimoriUser.value = null;
  shikimoriAuthUrl.value = '';
  shikimoriCode.value = '';
  shikimoriError.value = '';
  await loadParkedQueues();
}

async function shikimoriDisconnect(): Promise<void> {
  if (offlineQueueLength.value > 0 && shikimoriUser.value) {
    pendingDialog.value = {
      mode: 'disconnect',
      count: offlineQueueLength.value,
      nickname: shikimoriUser.value.nickname
    };
    return;
  }
  await logout();
}

function confirmDiscardKept(kept: ShikiParkedQueueSummary): void {
  pendingDialog.value = {
    mode: 'discard',
    count: kept.count,
    nickname: kept.ownerId === null ? null : kept.nickname,
    ownerId: kept.ownerId
  };
}

async function onPendingKeep(): Promise<void> {
  const dialog = pendingDialog.value;
  pendingDialog.value = null;
  if (dialog?.mode === 'disconnect') await logout({ pending: 'keep' });
}

async function onPendingDiscard(): Promise<void> {
  const dialog = pendingDialog.value;
  pendingDialog.value = null;
  if (!dialog) return;
  if (dialog.mode === 'disconnect') {
    await logout({ pending: 'discard' });
    return;
  }
  await window.api.shikimoriDiscardParkedQueue(dialog.ownerId);
  await loadParkedQueues();
}

onMounted(async () => {
  token.value = ((await window.api.getSetting('token')) as string) || '';
  if (!shikimoriUser.value) {
    shikimoriUser.value = await window.api.shikimoriGetUser();
  }
  await loadParkedQueues();
  loaded.value = true;
});

let tokenTimer: ReturnType<typeof setTimeout> | null = null;
watch(token, (val) => {
  if (!loaded.value) return;
  tokenStatus.value = 'idle';
  if (tokenTimer) clearTimeout(tokenTimer);
  tokenTimer = setTimeout(() => autoSave('token', val.trim()), 800);
});
</script>

<template>
  <div>
    <SettingsGroup
      title="smotret-anime.ru"
      desc="API token for smotret-anime.ru. Required for downloading episodes."
    >
      <SettingsRow stack>
        <div class="token-row">
          <input
            id="token-input"
            v-model="token"
            type="password"
            class="field-input token-input"
            placeholder="Enter your API token..."
          />
          <button
            class="btn btn-sm"
            :disabled="!token || tokenStatus === 'checking'"
            @click="testToken"
          >
            {{ tokenStatus === 'checking' ? 'Testing...' : 'Test' }}
          </button>
        </div>
        <div v-if="tokenStatus === 'valid'" class="inline-result ok">Token is valid</div>
        <div v-if="tokenStatus === 'invalid'" class="inline-result bad">{{ tokenError }}</div>
      </SettingsRow>
    </SettingsGroup>

    <SettingsGroup title="Shikimori" desc="Connect your Shikimori account to sync watch progress.">
      <!-- Expiry is not a logout: the account, its caches and the queued updates
           are all still here, so the card keeps its identity and only swaps the
           chip and the primary action (#244). -->
      <div v-if="shikimoriUser" class="conn-card">
        <div class="conn-logo" style="background: var(--st-blue)">
          <img v-if="shikimoriUser.avatar" :src="shikimoriUser.avatar" />
          <span v-else>Sh</span>
        </div>
        <div class="conn-info">
          <div class="ci-name">
            {{ shikimoriUser.nickname }}
            <span v-if="sessionExpired" class="chip red"
              ><span class="dot"></span>Session expired</span
            >
            <span v-else class="chip green"><span class="dot"></span>Connected</span>
          </div>
          <div v-if="sessionExpired" class="ci-meta">
            Shikimori rejected the saved sign-in.
            <template v-if="offlineQueueLength > 0">
              {{ offlineQueueLength }} pending update{{ offlineQueueLength > 1 ? 's' : '' }} will
              sync after you reconnect.
            </template>
          </div>
          <div v-else class="ci-meta">Shikimori account</div>
        </div>
        <button
          v-if="sessionExpired"
          class="btn btn-sm btn-primary"
          :disabled="Boolean(shikimoriAuthUrl)"
          @click="shikimoriConnect"
        >
          Reconnect
        </button>
        <button v-else class="btn btn-sm btn-outline" @click="shikimoriDisconnect">
          Disconnect
        </button>
      </div>

      <SettingsRow v-if="!shikimoriUser || (sessionExpired && shikimoriAuthUrl)" stack>
        <div v-if="!shikimoriAuthUrl">
          <button class="btn btn-sm btn-primary" @click="shikimoriConnect">
            Connect Shikimori
          </button>
        </div>
        <div v-else class="shikimori-auth">
          <div v-if="shikimoriShowUrl">
            <p class="sr-desc">
              Could not open browser. Copy the link and open it manually, then paste the code.
            </p>
            <div class="shikimori-url-row">
              <span class="path-input shikimori-url">{{ shikimoriAuthUrl }}</span>
              <button class="btn btn-sm" @click="shikimoriCopyUrl">Copy Link</button>
            </div>
          </div>
          <p v-else class="sr-desc">
            A browser window has opened. Authorize the app, then paste the code below.
            <a href="#" class="shiki-show-url" @click.prevent="shikimoriShowUrl = true"
              >Show link</a
            >
          </p>
          <div class="token-row">
            <input
              v-model="shikimoriCode"
              type="text"
              class="field-input token-input"
              placeholder="Paste authorization code..."
              @keydown.enter="shikimoriSubmitCode"
            />
            <button
              class="btn btn-sm btn-primary"
              :disabled="!shikimoriCode.trim() || shikimoriConnecting"
              @click="shikimoriSubmitCode"
            >
              {{ shikimoriConnecting ? 'Connecting...' : 'Submit' }}
            </button>
          </div>
          <div v-if="shikimoriError" class="inline-result bad">{{ shikimoriError }}</div>
        </div>
      </SettingsRow>

      <SettingsRow
        v-for="kept in keptQueues"
        :key="kept.ownerId ?? 'unknown'"
        class="kept-queue-row"
      >
        <template #text>
          <div v-if="kept.ownerId === null" class="sr-desc">
            {{ kept.count }} unsynced change{{ kept.count === 1 ? '' : 's' }} from an unknown
            account. They won't sync automatically.
          </div>
          <div v-else class="sr-desc">
            {{ kept.nickname }}: {{ kept.count }} unsynced change{{
              kept.count === 1 ? '' : 's'
            }}
            kept. They sync when {{ kept.nickname }} signs in again.
          </div>
        </template>
        <button class="btn btn-sm btn-danger" @click="confirmDiscardKept(kept)">Discard</button>
      </SettingsRow>
    </SettingsGroup>

    <ShikimoriPendingDialog
      v-if="pendingDialog"
      :mode="pendingDialog.mode"
      :count="pendingDialog.count"
      :nickname="pendingDialog.nickname"
      :new-nickname="pendingDialog.mode === 'switch' ? pendingDialog.newNickname : undefined"
      @keep="onPendingKeep"
      @discard="onPendingDiscard"
      @cancel="pendingDialog = null"
    />
  </div>
</template>

<style scoped src="@renderer/assets/settings-tabs.css"></style>

<style scoped>
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
