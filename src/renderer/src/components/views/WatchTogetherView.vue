<script setup lang="ts">
// Watch Together view (#213) — join a Syncplay room *before* opening the
// player. Shows the live member list (who's watching what) from the syncplay
// store and offers one-click "Join & watch" for app peers, which opens the
// built-in player streaming the peer's episode; PlayerView's Syncplay client
// then adopts the already-open connection and announces our file.
import { ref, computed, onMounted } from 'vue';
import { storeToRefs } from 'pinia';
import { useSyncplayStore } from '../../stores/syncplay';
import { useLibraryStore } from '../../stores/library';
import { useOpenEpisode } from '../../composables/use-open-episode';

const syncplayStore = useSyncplayStore();
const libraryStore = useLibraryStore();
const { status, roomUsers, isActive } = storeToRefs(syncplayStore);
const { openEpisode } = useOpenEpisode();

const roomInput = ref('');
const busy = ref(false);
const joiningUser = ref<string | null>(null);
const actionError = ref('');

const serverLabel = computed(() =>
  status.value.host ? `${status.value.host}:${status.value.port}` : ''
);

const otherUsers = computed(() =>
  roomUsers.value.filter((u) => u.username !== status.value.username)
);

const appPeerCount = computed(() => otherUsers.value.filter((u) => u.animeDlAppMeta).length);

async function connect(): Promise<void> {
  actionError.value = '';
  const cfg = (await window.api.getSetting('syncplay')) as {
    lastHost?: string;
    lastPort?: number;
    lastRoom?: string;
    username?: string;
    autoReconnect?: boolean;
  } | null;
  const room = roomInput.value.trim() || cfg?.lastRoom || '';
  if (!room) {
    actionError.value = 'Enter a room name first';
    return;
  }
  let username = cfg?.username?.trim() || '';
  if (!username) {
    const shiki = await window.api.shikimoriGetUser();
    if (shiki?.nickname) {
      username = shiki.nickname;
      await window.api.setSetting('syncplay', { ...(cfg || {}), username });
    }
  }
  if (!username) {
    actionError.value = 'Set a username in Settings → Watch Together';
    return;
  }
  busy.value = true;
  try {
    await window.api.syncplayConnect({
      host: cfg?.lastHost || 'syncplay.pl',
      port: cfg?.lastPort || 8999,
      room,
      username,
      autoReconnect: cfg?.autoReconnect ?? true
    });
  } finally {
    busy.value = false;
  }
}

async function disconnect(): Promise<void> {
  actionError.value = '';
  await window.api.syncplayDisconnect();
}

async function joinAndWatch(username: string): Promise<void> {
  if (joiningUser.value) return;
  actionError.value = '';
  joiningUser.value = username;
  try {
    // Re-read the room right before resolving — the peer may have advanced
    // episodes since the list rendered.
    await syncplayStore.refresh();
    const meta = roomUsers.value.find((u) => u.username === username)?.animeDlAppMeta;
    if (!meta) {
      actionError.value = `${username} is no longer sharing episode info`;
      return;
    }
    const result = await openEpisode({
      animeId: meta.animeId,
      episodeInt: meta.episodeInt,
      translationId: meta.translationId
    });
    if (!result.ok) actionError.value = result.error;
  } finally {
    joiningUser.value = null;
  }
}

onMounted(async () => {
  try {
    await syncplayStore.refresh();
  } catch {
    /* ignore */
  }
  const cfg = (await window.api.getSetting('syncplay')) as { lastRoom?: string } | null;
  roomInput.value = status.value.room || cfg?.lastRoom || '';
});
</script>

<template>
  <main class="wt-view">
    <header class="topbar">
      <h2>Watch Together</h2>
    </header>

    <section class="wt-card">
      <div class="wt-card-head">
        <span class="wt-dot" :class="'wt-' + status.state"></span>
        <span class="wt-state">
          <template v-if="status.state === 'ready'">
            Connected to <strong>{{ status.room }}</strong>
            <span v-if="serverLabel" class="wt-server">on {{ serverLabel }}</span>
          </template>
          <template v-else-if="isActive">Connecting… ({{ status.state }})</template>
          <template v-else>Not connected</template>
        </span>
        <span v-if="status.tls" class="wt-tls-badge">TLS</span>
      </div>

      <div v-if="!isActive" class="wt-connect-row">
        <input
          v-model="roomInput"
          type="text"
          class="wt-input"
          placeholder="room name"
          @keyup.enter="connect"
        />
        <button class="wt-btn primary" :disabled="busy" @click="connect">Join room</button>
      </div>
      <div v-else class="wt-connect-row">
        <button class="wt-btn" @click="disconnect">Disconnect</button>
      </div>

      <div v-if="!isActive && status.error" class="wt-error">{{ status.error }}</div>
      <div v-if="actionError" class="wt-error">{{ actionError }}</div>
      <p class="wt-hint">
        Server and username come from
        <a href="#" @click.prevent="libraryStore.navigate('settings')">Settings → Watch Together</a
        >. Share the room name with friends out-of-band.
      </p>
    </section>

    <section v-if="isActive" class="wt-card">
      <div class="wt-card-title">In room</div>
      <div v-if="otherUsers.length === 0" class="wt-empty">
        Room is empty — you're the first one here. Ask a friend to join
        <strong>{{ status.room }}</strong
        >.
      </div>
      <template v-else>
        <div v-for="u in otherUsers" :key="u.username" class="wt-user-row">
          <span
            class="wt-user-dot"
            :class="u.isReady === false ? 'buffering' : 'ready'"
            :title="u.isReady === false ? 'Buffering' : 'Ready'"
          ></span>
          <div class="wt-user-info">
            <div class="wt-user-name">{{ u.username }}</div>
            <div v-if="u.file" class="wt-user-file" :title="u.file.name">{{ u.file.name }}</div>
            <div v-else class="wt-user-file none">No file loaded</div>
          </div>
          <button
            v-if="u.animeDlAppMeta"
            class="wt-btn primary sm"
            :disabled="joiningUser !== null"
            @click="joinAndWatch(u.username)"
          >
            {{ joiningUser === u.username ? 'Opening…' : 'Join & watch' }}
          </button>
        </div>
        <div v-if="appPeerCount === 0" class="wt-empty subtle">
          No one here is using Anime DL — auto-join needs the app on the other side. You can still
          open the same episode manually and sync from the player.
        </div>
      </template>
    </section>
  </main>
</template>

<style scoped>
.wt-view {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  padding: 24px 28px;
  gap: 16px;
}

.topbar h2 {
  font-size: 1.3rem;
  font-weight: 700;
}

.wt-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  padding: 16px 18px;
  max-width: 640px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.wt-card-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.92rem;
  color: var(--text);
}

.wt-card-title {
  font-size: 0.92rem;
  font-weight: 600;
  color: var(--text);
}

.wt-server {
  color: var(--text-3);
  margin-left: 4px;
}

.wt-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--text-faint);
  flex-shrink: 0;
}

.wt-dot.wt-connecting,
.wt-dot.wt-tls-probing,
.wt-dot.wt-tls-handshake,
.wt-dot.wt-hello-sent,
.wt-dot.wt-reconnecting {
  background: var(--st-orange);
}

.wt-dot.wt-ready {
  background: var(--st-green);
}

.wt-tls-badge {
  font-size: 0.65rem;
  background: var(--surface-3);
  color: var(--text);
  padding: 1px 5px;
  border-radius: 4px;
}

.wt-connect-row {
  display: flex;
  gap: 8px;
}

.wt-input {
  flex: 1;
  max-width: 260px;
  padding: 8px 10px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-input);
  color: var(--text);
  font-size: 0.85rem;
}

.wt-input:focus {
  outline: none;
  border-color: var(--accent);
}

.wt-btn {
  padding: 8px 14px;
  background: transparent;
  border: 1px solid var(--border);
  border-radius: var(--radius-btn);
  color: var(--text-2);
  font-size: 0.85rem;
  cursor: pointer;
  transition: background 0.15s var(--ease);
}

.wt-btn:hover {
  background: var(--surface-2);
}

.wt-btn.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--accent-ink);
  font-weight: 600;
}

.wt-btn.primary:hover {
  background: var(--accent-hover);
}

.wt-btn:disabled {
  opacity: 0.55;
  cursor: default;
}

.wt-btn.sm {
  padding: 6px 10px;
  font-size: 0.78rem;
}

.wt-error {
  color: var(--st-red);
  font-size: 0.8rem;
  overflow-wrap: anywhere;
}

.wt-hint {
  font-size: 0.75rem;
  color: var(--text-3);
  line-height: 1.5;
}

.wt-hint a {
  color: var(--accent);
  text-decoration: none;
}

.wt-empty {
  font-size: 0.85rem;
  color: var(--text-2);
}

.wt-empty.subtle {
  font-size: 0.78rem;
  color: var(--text-3);
}

.wt-user-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 0;
  border-top: 1px solid var(--border-soft);
}

.wt-user-row:first-of-type {
  border-top: none;
}

.wt-user-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  flex-shrink: 0;
}

.wt-user-dot.ready {
  background: var(--st-green);
}

.wt-user-dot.buffering {
  background: var(--st-orange);
}

.wt-user-info {
  flex: 1;
  min-width: 0;
}

.wt-user-name {
  font-size: 0.88rem;
  font-weight: 600;
  color: var(--text);
}

.wt-user-file {
  font-size: 0.75rem;
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.wt-user-file.none {
  font-style: italic;
}
</style>
