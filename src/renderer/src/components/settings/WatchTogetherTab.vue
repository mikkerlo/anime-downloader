<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from 'vue';
import { useShikimoriStore } from '../../stores/shikimori';
import { useSettingsAutosave } from '../../composables/use-settings-autosave';
import SettingsGroup from './SettingsGroup.vue';
import SettingsRow from './SettingsRow.vue';
import SettingsSwitch from './SettingsSwitch.vue';

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

    <SettingsGroup
      title="Watch Together (Syncplay)"
      desc="Sync play/pause/seek with friends over the Internet via the Syncplay protocol. Works with other Syncplay clients (mpv, VLC) in the same room."
    >
      <SettingsRow
        label="Server"
        desc="Address and port of the relay server. Default: syncplay.pl:8999."
      >
        <div class="sp-host-row">
          <input
            id="sp-host"
            v-model="syncplayHost"
            type="text"
            class="field-input sp-host-input"
            placeholder="syncplay.pl"
          />
          <input
            v-model.number="syncplayPort"
            type="number"
            min="1"
            max="65535"
            class="field-input sp-port-input"
          />
        </div>
      </SettingsRow>
      <SettingsRow
        label="Default room"
        desc="Preselected room name when you open the Watch Together popover in the player. Any non-empty string is accepted; share it with friends out-of-band."
      >
        <input
          id="sp-room"
          v-model="syncplayRoom"
          type="text"
          class="field-input"
          placeholder="my-anime-room"
        />
      </SettingsRow>
      <SettingsRow
        label="Username"
        desc="Shown to other room members. Defaults to your Shikimori nickname if signed in."
      >
        <input
          id="sp-user"
          v-model="syncplayUsername"
          type="text"
          class="field-input"
          placeholder="username"
        />
      </SettingsRow>
      <SettingsRow
        label="Password (optional)"
        desc="Some servers require a password to log in. Leave empty for public servers."
      >
        <input id="sp-password" v-model="syncplayPassword" type="password" class="field-input" />
      </SettingsRow>
    </SettingsGroup>

    <SettingsGroup title="Connection">
      <SettingsRow
        label="Auto-reconnect on disconnect"
        desc="Retry with exponential backoff up to 5 times after a network drop."
      >
        <SettingsSwitch v-model="syncplayAutoReconnect" />
      </SettingsRow>
      <SettingsRow
        label="Test connection"
        desc="Connects briefly with the current settings, then disconnects."
      >
        <button
          class="btn btn-sm"
          :disabled="syncplayTestStatus === 'testing'"
          @click="testSyncplayConnection"
        >
          {{ syncplayTestStatus === 'testing' ? 'Testing…' : 'Test connection' }}
        </button>
      </SettingsRow>
      <SettingsRow v-if="syncplayTestStatus === 'ok' || syncplayTestStatus === 'failed'" stack>
        <div v-if="syncplayTestStatus === 'ok'" class="inline-result ok">
          Connected successfully
        </div>
        <div v-else class="inline-result bad">{{ syncplayTestError || 'Connection failed' }}</div>
      </SettingsRow>
      <SettingsRow stack>
        <p class="sr-desc">
          Connections are encrypted with TLS (required). The server must run Syncplay 1.6.3+ and
          present a valid TLS certificate for its hostname; servers that only accept plaintext are
          not supported.
        </p>
      </SettingsRow>
    </SettingsGroup>
  </div>
</template>

<style scoped src="@renderer/assets/settings-tabs.css"></style>

<style scoped>
.dev-banner {
  margin-bottom: 18px;
  padding: 10px 14px;
  border-radius: var(--radius-input);
  border: 1px solid color-mix(in srgb, var(--st-orange) 35%, transparent);
  background: color-mix(in srgb, var(--st-orange) 8%, transparent);
  color: var(--st-orange);
  font-size: 0.8rem;
  line-height: 1.45;
}

.dev-banner strong {
  margin-right: 4px;
}

.sp-host-row {
  display: flex;
  gap: 8px;
  align-items: center;
}

.sp-host-input {
  width: 200px;
}

.sp-port-input {
  width: 90px;
}
</style>
