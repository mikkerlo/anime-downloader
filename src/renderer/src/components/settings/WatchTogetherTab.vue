<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from 'vue';
import { useShikimoriStore } from '../../stores/shikimori';
import { useSettingsAutosave } from '../../composables/use-settings-autosave';

const shikimoriStore = useShikimoriStore();
const { showSaved } = useSettingsAutosave();

const loaded = ref(false);

const syncplayHost = ref('syncplay.pl');
const syncplayPort = ref(8999);
const syncplayRoom = ref('');
const syncplayUsername = ref('');
const syncplayPassword = ref('');
const syncplayAutoReconnect = ref(true);
const syncplayTestStatus = ref<'idle' | 'testing' | 'ok' | 'failed'>('idle');
const syncplayTestError = ref('');

let syncplaySaveTimer: ReturnType<typeof setTimeout> | null = null;

function saveSyncplaySettings(): void {
  if (!loaded.value) return;
  void window.api.setSetting('syncplay', {
    lastHost: syncplayHost.value.trim(),
    lastPort: Math.max(1, Math.min(65535, Number(syncplayPort.value) || 8999)),
    lastRoom: syncplayRoom.value.trim(),
    username: syncplayUsername.value.trim(),
    autoReconnect: syncplayAutoReconnect.value
  });
  showSaved();
}

function scheduleSyncplaySave(): void {
  if (syncplaySaveTimer) clearTimeout(syncplaySaveTimer);
  syncplaySaveTimer = setTimeout(saveSyncplaySettings, 600);
}

async function testSyncplayConnection(): Promise<void> {
  const host = syncplayHost.value.trim();
  const port = Number(syncplayPort.value) || 8999;
  const room = syncplayRoom.value.trim() || 'test-room';
  const username = syncplayUsername.value.trim() || 'anime-dl-user';
  if (!host) return;
  syncplayTestStatus.value = 'testing';
  syncplayTestError.value = '';

  let unsub: Unsubscribe | null = null;
  const dispose = (): void => {
    unsub?.();
    unsub = null;
  };
  unsub = window.api.onSyncplayConnectionStatus((status) => {
    if (status.state === 'ready') {
      syncplayTestStatus.value = 'ok';
      dispose();
      void window.api.syncplayDisconnect();
    } else if (status.state === 'disconnected') {
      if (syncplayTestStatus.value === 'testing') {
        syncplayTestStatus.value = 'failed';
        syncplayTestError.value = status.error || 'Connection closed';
      }
      dispose();
    }
  });

  try {
    await window.api.syncplayConnect({
      host,
      port,
      room,
      username,
      password: syncplayPassword.value || undefined,
      autoReconnect: false
    });
    setTimeout(() => {
      if (syncplayTestStatus.value === 'testing') {
        syncplayTestStatus.value = 'failed';
        syncplayTestError.value = 'Timed out after 10s';
        dispose();
        void window.api.syncplayDisconnect();
      }
    }, 10_000);
  } catch (err) {
    syncplayTestStatus.value = 'failed';
    syncplayTestError.value = String(err);
    dispose();
  }
}

onMounted(async () => {
  const sp = (await window.api.getSetting('syncplay')) as {
    lastHost?: string;
    lastPort?: number;
    lastRoom?: string;
    username?: string;
    autoReconnect?: boolean;
  } | null;
  if (sp) {
    syncplayHost.value = sp.lastHost || 'syncplay.pl';
    syncplayPort.value = sp.lastPort || 8999;
    syncplayRoom.value = sp.lastRoom || '';
    syncplayUsername.value = sp.username || '';
    syncplayAutoReconnect.value = sp.autoReconnect ?? true;
  }
  if (!syncplayUsername.value && shikimoriStore.user) {
    syncplayUsername.value = shikimoriStore.user.nickname;
  }
  loaded.value = true;
});

onUnmounted(() => {
  if (syncplaySaveTimer) {
    clearTimeout(syncplaySaveTimer);
    syncplaySaveTimer = null;
  }
});

watch([syncplayHost, syncplayPort, syncplayRoom, syncplayUsername], () => {
  if (loaded.value) scheduleSyncplaySave();
});
watch(syncplayAutoReconnect, () => {
  if (loaded.value) saveSyncplaySettings();
});
</script>

<template>
  <div>
    <div class="dev-banner">
      <strong>Feature in development.</strong>
      Sync, attribution, and reconnect behavior may misfire — especially on rapid arrow-key seeks or
      shaky connections. Please report quirks with a screen recording or the renderer console log.
    </div>
    <div class="setting-group">
      <label class="setting-label">Watch Together (Syncplay)</label>
      <p class="setting-hint">
        Sync play/pause/seek with friends over the Internet via the Syncplay protocol. Works with
        other Syncplay clients (mpv, VLC) in the same room.
      </p>
    </div>

    <div class="setting-group">
      <label class="setting-label" for="sp-host">Server</label>
      <p class="setting-hint">Default: <code>syncplay.pl</code> on port <code>8999</code>.</p>
      <div class="sp-host-row">
        <input
          id="sp-host"
          v-model="syncplayHost"
          type="text"
          class="setting-input"
          placeholder="syncplay.pl"
        />
        <input
          v-model.number="syncplayPort"
          type="number"
          min="1"
          max="65535"
          class="setting-input sp-port-input"
        />
      </div>
    </div>

    <div class="setting-group">
      <label class="setting-label" for="sp-room">Default room</label>
      <p class="setting-hint">
        Preselected room name when you open the Watch Together popover in the player. Any non-empty
        string is accepted; share it with friends out-of-band.
      </p>
      <input
        id="sp-room"
        v-model="syncplayRoom"
        type="text"
        class="setting-input"
        placeholder="my-anime-room"
      />
    </div>

    <div class="setting-group">
      <label class="setting-label" for="sp-user">Username</label>
      <p class="setting-hint">
        Shown to other room members. Defaults to your Shikimori nickname if signed in.
      </p>
      <input
        id="sp-user"
        v-model="syncplayUsername"
        type="text"
        class="setting-input"
        placeholder="username"
      />
    </div>

    <div class="setting-group">
      <label class="setting-label" for="sp-password">Password (optional)</label>
      <p class="setting-hint">
        Some servers require a password to log in. Leave empty for public servers.
      </p>
      <input
        id="sp-password"
        v-model="syncplayPassword"
        type="password"
        class="setting-input"
        placeholder=""
      />
    </div>

    <div class="setting-group">
      <p class="setting-hint">
        Connections are encrypted with TLS (required). The server must run Syncplay 1.6.3+ and
        present a valid TLS certificate for its hostname; servers that only accept plaintext are not
        supported.
      </p>
    </div>

    <div class="setting-group">
      <label class="toggle-row">
        <input type="checkbox" v-model="syncplayAutoReconnect" />
        <span>Auto-reconnect on disconnect</span>
      </label>
      <p class="setting-hint">Retry with exponential backoff up to 5 times after a network drop.</p>
    </div>

    <div class="setting-group">
      <label class="setting-label">Test connection</label>
      <p class="setting-hint">Connects briefly with the current settings, then disconnects.</p>
      <button
        class="merge-all-btn"
        @click="testSyncplayConnection"
        :disabled="syncplayTestStatus === 'testing'"
      >
        {{ syncplayTestStatus === 'testing' ? 'Testing…' : 'Test connection' }}
      </button>
      <div
        v-if="syncplayTestStatus === 'ok'"
        class="token-result token-valid"
        style="margin-top: 6px"
      >
        Connected successfully
      </div>
      <div
        v-if="syncplayTestStatus === 'failed'"
        class="token-result token-invalid"
        style="margin-top: 6px"
      >
        {{ syncplayTestError || 'Connection failed' }}
      </div>
    </div>
  </div>
</template>

<style scoped src="@renderer/assets/settings-tabs.css"></style>

<style scoped>
.dev-banner {
  margin-bottom: 18px;
  padding: 10px 14px;
  border-radius: 6px;
  border: 1px solid rgba(245, 158, 11, 0.35);
  background: rgba(245, 158, 11, 0.08);
  color: #e0c382;
  font-size: 0.8rem;
  line-height: 1.45;
}

.dev-banner strong {
  color: #f59e0b;
  margin-right: 4px;
}

.sp-host-row {
  display: flex;
  gap: 8px;
  align-items: center;
}

.sp-port-input {
  max-width: 100px;
}
</style>
