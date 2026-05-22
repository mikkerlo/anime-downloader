<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{
  friendsRates: ShikiFriendRate[];
  friendsLoading: boolean;
  numberOfEpisodes?: number;
}>();

const collapsed = defineModel<boolean>('collapsed', { default: false });

const STATUS_LABELS: Record<string, string> = {
  planned: 'Planned',
  watching: 'Watching',
  rewatching: 'Rewatching',
  completed: 'Completed',
  on_hold: 'On Hold',
  dropped: 'Dropped'
};

const friendsSummary = computed(() => {
  const counts = new Map<string, number>();
  for (const r of props.friendsRates) {
    counts.set(r.status, (counts.get(r.status) || 0) + 1);
  }
  const labels: Record<string, string> = {
    watching: 'watching',
    completed: 'completed',
    planned: 'planned',
    on_hold: 'on hold',
    dropped: 'dropped',
    rewatching: 'rewatching'
  };
  return [...counts.entries()]
    .map(([status, count]) => `${count} ${labels[status] || status}`)
    .join(' · ');
});
</script>

<template>
  <div class="friends-panel">
    <div class="friends-header" @click="collapsed = !collapsed">
      <div class="friends-header-left">
        <svg
          class="friends-chevron"
          :class="{ collapsed }"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          width="14"
          height="14"
        >
          <path stroke-linecap="round" stroke-linejoin="round" d="M6 9l6 6 6-6" />
        </svg>
        <span class="friends-label">Friends</span>
      </div>
      <span v-if="!friendsLoading && friendsRates.length > 0" class="friends-summary">{{
        friendsSummary
      }}</span>
      <span v-if="friendsLoading" class="friends-summary">Loading...</span>
    </div>
    <div v-if="!collapsed" class="friends-body">
      <div v-if="friendsLoading" class="friends-loading">Loading friends...</div>
      <div v-else-if="friendsRates.length === 0" class="friends-empty">
        None of your friends have watched this anime
      </div>
      <div v-else class="friends-list">
        <div v-for="friend in friendsRates" :key="friend.nickname" class="friend-row">
          <img :src="friend.avatar" class="friend-avatar" />
          <span class="friend-name">{{ friend.nickname }}</span>
          <span class="friend-status-badge" :class="'status-' + friend.status">
            {{ STATUS_LABELS[friend.status] || friend.status }}
          </span>
          <span class="friend-score">{{ friend.score > 0 ? friend.score + '/10' : '—' }}</span>
          <span class="friend-episodes">{{
            friend.episodes > 0
              ? 'ep ' + friend.episodes + (numberOfEpisodes ? '/' + numberOfEpisodes : '')
              : ''
          }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.friends-panel {
  background-color: #16213e;
  border: 1px solid #0f3460;
  border-radius: 10px;
  padding: 14px 18px;
  margin-bottom: 20px;
}

.friends-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  cursor: pointer;
  user-select: none;
}

.friends-header-left {
  display: flex;
  align-items: center;
  gap: 6px;
}

.friends-chevron {
  color: #a0a0b8;
  transition: transform 0.15s;
}

.friends-chevron.collapsed {
  transform: rotate(-90deg);
}

.friends-label {
  font-size: 0.85rem;
  font-weight: 600;
  color: #a0a0b8;
}

.friends-summary {
  font-size: 0.8rem;
  color: #6a6a8a;
}

.friends-body {
  margin-top: 10px;
}

.friends-loading,
.friends-empty {
  font-size: 0.85rem;
  color: #6a6a8a;
}

.friends-list {
  display: grid;
  grid-template-columns: 24px minmax(80px, auto) auto auto auto;
  gap: 8px 12px;
  align-items: center;
  font-size: 0.85rem;
}

.friend-row {
  display: contents;
}

.friend-avatar {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  object-fit: cover;
}

.friend-name {
  color: #e0e0e0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.friend-status-badge {
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 0.75rem;
  font-weight: 600;
  text-align: center;
  white-space: nowrap;
}

.status-watching {
  background-color: #27ae601a;
  color: #6ab04c;
}

.status-completed {
  background-color: #3498db1a;
  color: #3498db;
}

.status-planned {
  background-color: #9b59b61a;
  color: #9b59b6;
}

.status-on_hold {
  background-color: #f39c121a;
  color: #f39c12;
}

.status-dropped {
  background-color: #e945601a;
  color: #e94560;
}

.status-rewatching {
  background-color: #1abc9c1a;
  color: #1abc9c;
}

.friend-score {
  color: #f39c12;
  font-size: 0.8rem;
  text-align: right;
  white-space: nowrap;
}

.friend-episodes {
  color: #6a6a8a;
  font-size: 0.8rem;
  white-space: nowrap;
}
</style>
