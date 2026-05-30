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
  <div class="side-panel">
    <h4 class="panel-toggle" @click="collapsed = !collapsed">
      <svg
        class="friends-icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        width="17"
        height="17"
      >
        <path
          stroke-linecap="round"
          stroke-linejoin="round"
          d="M18 18.72a9.094 9.094 0 003.741-.479 3 3 0 00-4.682-2.72m.94 3.198l.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0112 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 016 18.719m12 0a5.971 5.971 0 00-.941-3.197m0 0A5.995 5.995 0 0012 12.75a5.995 5.995 0 00-5.058 2.772m0 0a3 3 0 00-4.681 2.72 8.986 8.986 0 003.74.477m.94-3.197a5.971 5.971 0 00-.94 3.197M15 6.75a3 3 0 11-6 0 3 3 0 016 0zm6 3a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0zm-13.5 0a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0z"
        />
      </svg>
      Friends
      <span v-if="!friendsLoading && friendsRates.length > 0" class="panel-summary">{{
        friendsSummary
      }}</span>
      <span v-else-if="friendsLoading" class="panel-summary">Loading…</span>
      <svg
        class="panel-chevron"
        :class="{ collapsed }"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        width="16"
        height="16"
      >
        <path stroke-linecap="round" stroke-linejoin="round" d="M6 9l6 6 6-6" />
      </svg>
    </h4>
    <div v-if="!collapsed">
      <div v-if="friendsLoading" class="panel-muted">Loading friends…</div>
      <div v-else-if="friendsRates.length === 0" class="panel-muted">
        None of your friends have watched this anime
      </div>
      <template v-else>
        <div v-for="friend in friendsRates" :key="friend.nickname" class="friend-row">
          <img :src="friend.avatar" class="friend-av" :alt="friend.nickname" />
          <div class="friend-body">
            <div class="friend-name">{{ friend.nickname }}</div>
            <div class="friend-act">
              <span class="friend-status" :class="'status-' + friend.status">{{
                STATUS_LABELS[friend.status] || friend.status
              }}</span>
              <span v-if="friend.episodes > 0"
                >· ep {{ friend.episodes
                }}{{ numberOfEpisodes ? '/' + numberOfEpisodes : '' }}</span
              >
              <span v-if="friend.score > 0">· ★ {{ friend.score }}</span>
            </div>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.side-panel {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  padding: 18px;
}

.panel-toggle {
  font-family: var(--font-display);
  font-size: 0.92rem;
  font-weight: 700;
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  user-select: none;
}

.friends-icon {
  color: var(--accent);
  flex-shrink: 0;
}

.panel-summary {
  font-family: var(--font-data);
  font-size: 0.72rem;
  font-weight: 500;
  color: var(--text-3);
  margin-left: auto;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.panel-chevron {
  color: var(--text-3);
  flex-shrink: 0;
  margin-left: 4px;
  transition: transform 0.2s var(--ease);
}

.panel-chevron.collapsed {
  transform: rotate(-90deg);
}

.panel-muted {
  margin-top: 12px;
  font-size: 0.82rem;
  color: var(--text-3);
  line-height: 1.45;
}

.friend-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 0;
  border-top: 1px solid var(--border-soft);
}

.friend-row:first-of-type {
  margin-top: 6px;
  border-top: none;
}

.friend-av {
  width: 28px;
  height: 28px;
  min-width: 28px;
  border-radius: 50%;
  object-fit: cover;
  background: var(--surface-3);
}

.friend-body {
  flex: 1;
  min-width: 0;
}

.friend-name {
  font-size: 0.82rem;
  font-weight: 600;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.friend-act {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  font-size: 0.72rem;
  color: var(--text-3);
  margin-top: 2px;
}

.friend-status {
  font-weight: 700;
}

.status-watching,
.status-rewatching {
  color: var(--st-green);
}

.status-completed {
  color: var(--st-blue);
}

.status-planned {
  color: var(--st-purple);
}

.status-on_hold {
  color: var(--st-orange);
}

.status-dropped {
  color: var(--st-red);
}
</style>
