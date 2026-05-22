<script setup lang="ts">
import { ref, watch, onMounted } from 'vue';
import { storeToRefs } from 'pinia';
import { useShikimoriStore } from '../../stores/shikimori';
import { useSettingsAutosave } from '../../composables/use-settings-autosave';

const shikimoriStore = useShikimoriStore();
const { user: shikimoriUser } = storeToRefs(shikimoriStore);
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

async function shikimoriSubmitCode(): Promise<void> {
  const code = shikimoriCode.value.trim();
  if (!code) return;
  shikimoriConnecting.value = true;
  shikimoriError.value = '';
  try {
    shikimoriUser.value = await window.api.shikimoriExchangeCode(code);
    shikimoriCode.value = '';
    shikimoriAuthUrl.value = '';
  } catch (err) {
    shikimoriError.value = String(err);
  } finally {
    shikimoriConnecting.value = false;
  }
}

async function shikimoriDisconnect(): Promise<void> {
  await window.api.shikimoriLogout();
  shikimoriUser.value = null;
  shikimoriAuthUrl.value = '';
  shikimoriCode.value = '';
  shikimoriError.value = '';
}

onMounted(async () => {
  token.value = ((await window.api.getSetting('token')) as string) || '';
  if (!shikimoriUser.value) {
    shikimoriUser.value = await window.api.shikimoriGetUser();
  }
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
    <div class="setting-group">
      <label class="setting-label" for="token-input">smotret-anime.ru</label>
      <p class="setting-hint">API token for smotret-anime.ru. Required for downloading episodes.</p>
      <div class="token-row">
        <input
          id="token-input"
          v-model="token"
          type="password"
          class="setting-input"
          placeholder="Enter your API token..."
        />
        <button
          class="test-token-btn"
          :disabled="!token || tokenStatus === 'checking'"
          @click="testToken"
        >
          {{ tokenStatus === 'checking' ? 'Testing...' : 'Test' }}
        </button>
      </div>
      <div v-if="tokenStatus === 'valid'" class="token-result token-valid">Token is valid</div>
      <div v-if="tokenStatus === 'invalid'" class="token-result token-invalid">
        {{ tokenError }}
      </div>
    </div>

    <div class="setting-group">
      <label class="setting-label">Shikimori</label>
      <p class="setting-hint">Connect your Shikimori account to sync watch progress.</p>

      <template v-if="shikimoriUser">
        <div class="shikimori-user">
          <img v-if="shikimoriUser.avatar" :src="shikimoriUser.avatar" class="shikimori-avatar" />
          <span class="shikimori-nickname">{{ shikimoriUser.nickname }}</span>
          <button class="test-token-btn" @click="shikimoriDisconnect">Disconnect</button>
        </div>
      </template>

      <template v-else>
        <div v-if="!shikimoriAuthUrl">
          <button class="browse-btn" @click="shikimoriConnect">Connect Shikimori</button>
        </div>
        <div v-else class="shikimori-auth">
          <div v-if="shikimoriShowUrl">
            <p class="setting-hint" style="margin-bottom: 6px">
              Could not open browser. Copy the link and open it manually, then paste the code.
            </p>
            <div class="shikimori-url-row">
              <span class="dir-path shikimori-url">{{ shikimoriAuthUrl }}</span>
              <button class="test-token-btn" @click="shikimoriCopyUrl">Copy Link</button>
            </div>
          </div>
          <p v-else class="setting-hint" style="margin-bottom: 6px">
            A browser window has opened. Authorize the app, then paste the code below.
            <a href="#" class="shiki-show-url" @click.prevent="shikimoriShowUrl = true"
              >Show link</a
            >
          </p>
          <div class="token-row" style="margin-top: 8px">
            <input
              v-model="shikimoriCode"
              type="text"
              class="setting-input"
              placeholder="Paste authorization code..."
              @keydown.enter="shikimoriSubmitCode"
            />
            <button
              class="test-token-btn"
              :disabled="!shikimoriCode.trim() || shikimoriConnecting"
              @click="shikimoriSubmitCode"
            >
              {{ shikimoriConnecting ? 'Connecting...' : 'Submit' }}
            </button>
          </div>
          <div v-if="shikimoriError" class="token-result token-invalid">
            {{ shikimoriError }}
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped src="@renderer/assets/settings-tabs.css"></style>

<style scoped>
.shikimori-user {
  display: flex;
  align-items: center;
  gap: 10px;
}

.shikimori-avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
}

.shikimori-nickname {
  font-size: 0.9rem;
  font-weight: 600;
  color: #e0e0e0;
  flex: 1;
}

.shikimori-url-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.shikimori-url {
  font-size: 0.75rem;
  user-select: all;
}

.shiki-show-url {
  color: #3498db;
  text-decoration: none;
  font-size: 0.8rem;
}

.shiki-show-url:hover {
  text-decoration: underline;
}
</style>
