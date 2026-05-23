<script setup lang="ts">
// Watch Together (Syncplay) dropdown — connection status indicator,
// room input, connect/disconnect button, room user list. Phase 5 slice
// 5e (#118).

defineProps<{
  open: boolean;
  status: SyncplayStatus;
  roomInput: string;
  roomUsers: SyncplayRoomUser[];
}>();

const emit = defineEmits<{
  'toggle-menu': [];
  'update:roomInput': [value: string];
  toggle: [];
}>();

function onInput(e: Event): void {
  emit('update:roomInput', (e.target as HTMLInputElement).value);
}
</script>

<template>
  <div class="preset-wrapper">
    <button
      class="ctrl-btn preset-btn syncplay-btn"
      :class="{ active: status.state === 'ready' }"
      @click="emit('toggle-menu')"
      title="Watch Together"
    >
      <span class="sp-dot" :class="'sp-' + status.state"></span>
      <span class="sp-label">Sync</span>
    </button>
    <div v-if="open" class="preset-menu syncplay-menu" @click.stop>
      <div class="sp-status-line">
        Status: <strong>{{ status.state }}</strong>
        <span v-if="status.tls" class="sp-tls-badge">TLS</span>
      </div>
      <div v-if="status.error" class="sp-error-line">
        {{ status.error }}
      </div>
      <label class="sp-label-row" for="sp-room-input">Room</label>
      <input
        id="sp-room-input"
        :value="roomInput"
        @input="onInput"
        type="text"
        class="sp-input"
        placeholder="room name"
        :disabled="status.state !== 'idle' && status.state !== 'disconnected'"
      />
      <button class="sp-action-btn" @click="emit('toggle')">
        {{ status.state === 'idle' || status.state === 'disconnected' ? 'Connect' : 'Disconnect' }}
      </button>
      <div v-if="roomUsers.length > 0" class="sp-users-list">
        <div class="sp-users-title">In room</div>
        <div v-for="u in roomUsers" :key="u.username" class="sp-user-row">
          <span
            class="sp-user-dot"
            :class="u.isReady === false ? 'sp-user-dot-buffering' : 'sp-user-dot-ready'"
            :title="u.isReady === false ? 'Buffering' : 'Ready'"
          ></span>
          <span class="sp-user-name">{{ u.username }}</span>
          <span v-if="u.file" class="sp-user-file" :title="u.file.name">{{ u.file.name }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped src="@renderer/assets/player-menus.css"></style>
<style scoped>
.syncplay-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.sp-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #6a6a8a;
}

.sp-dot.sp-idle,
.sp-dot.sp-disconnected {
  background: #6a6a8a;
}

.sp-dot.sp-connecting,
.sp-dot.sp-tls-probing,
.sp-dot.sp-tls-handshake,
.sp-dot.sp-hello-sent,
.sp-dot.sp-reconnecting {
  background: #f0932b;
}

.sp-dot.sp-ready {
  background: #6ab04c;
}

.sp-label {
  font-size: 0.8rem;
}

.syncplay-menu {
  min-width: 240px;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.sp-status-line {
  font-size: 0.8rem;
  color: #a0a0b8;
  display: flex;
  align-items: center;
  gap: 6px;
}

.sp-tls-badge {
  font-size: 0.65rem;
  background: #0f3460;
  color: #e0e0e0;
  padding: 1px 5px;
  border-radius: 3px;
}

.sp-error-line {
  color: #e94560;
  font-size: 0.75rem;
}

.sp-label-row {
  font-size: 0.75rem;
  color: #a0a0b8;
  margin-top: 4px;
}

.sp-input {
  width: 100%;
  padding: 6px 8px;
  background: #16213e;
  border: 1px solid #0f3460;
  border-radius: 4px;
  color: #e0e0e0;
  font-size: 0.8rem;
}

.sp-input:disabled {
  opacity: 0.55;
}

.sp-action-btn {
  padding: 6px 12px;
  background: #e94560;
  border: none;
  border-radius: 4px;
  color: #fff;
  font-size: 0.8rem;
  font-weight: 600;
  cursor: pointer;
}

.sp-action-btn:hover {
  background: #d13b53;
}

.sp-users-list {
  border-top: 1px solid #0f3460;
  padding-top: 6px;
  margin-top: 4px;
}

.sp-users-title {
  font-size: 0.75rem;
  color: #a0a0b8;
  margin-bottom: 4px;
}

.sp-user-row {
  display: grid;
  grid-template-columns: auto 1fr;
  column-gap: 6px;
  font-size: 0.8rem;
  padding: 2px 0;
  align-items: center;
}

.sp-user-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  grid-row: 1 / span 2;
}

.sp-user-dot-ready {
  background: #4ade80;
}

.sp-user-dot-buffering {
  background: #f59e0b;
}

.sp-user-file {
  grid-column: 2;
  font-size: 0.7rem;
  color: #6a6a8a;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
