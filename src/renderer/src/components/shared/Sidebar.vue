<script setup lang="ts">
import { computed } from 'vue';
import { storeToRefs } from 'pinia';
import { useLibraryStore, type LibraryView } from '../../stores/library';
import { useShikimoriStore } from '../../stores/shikimori';
import { useDownloadsStore } from '../../stores/downloads';

const libraryStore = useLibraryStore();
const shikimoriStore = useShikimoriStore();
const downloadsStore = useDownloadsStore();
const { currentView } = storeToRefs(libraryStore);
const { user, loggedIn, offlineQueueLength, syncStatus } = storeToRefs(shikimoriStore);
const { groups } = storeToRefs(downloadsStore);

type MenuItem = { id: LibraryView; label: string; icon: string };

// Download icon — reused for the logo mark and the Downloads nav item.
const downloadIcon =
  'M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3';

const primaryItems: MenuItem[] = [
  {
    id: 'home',
    label: 'Home',
    icon: 'M2.25 12l8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25'
  },
  {
    id: 'search',
    label: 'Search',
    icon: 'M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z'
  },
  { id: 'downloads', label: 'Downloads', icon: downloadIcon },
  {
    id: 'library',
    label: 'Library',
    icon: 'M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25'
  }
];

const shikimoriItems: MenuItem[] = [
  {
    id: 'shikimori',
    label: 'Shikimori',
    icon: 'M3.75 12h16.5m-16.5 3.75h16.5M3.75 19.5h16.5M5.625 4.5h12.75a1.875 1.875 0 010 3.75H5.625a1.875 1.875 0 010-3.75z'
  },
  {
    id: 'friends',
    label: 'Friends',
    icon: 'M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z'
  },
  {
    id: 'calendar',
    label: 'Calendar',
    icon: 'M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5'
  }
];

const settingsItem: MenuItem = {
  id: 'settings',
  label: 'Settings',
  icon: 'M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a6.759 6.759 0 010 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 010-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.28z M15 12a3 3 0 11-6 0 3 3 0 016 0z'
};

// Active downloads + subtitles still in flight — surfaced as the count pill.
const downloadCount = computed(
  () =>
    groups.value.filter((g) =>
      [g.video, g.subtitle].some(
        (item) => item != null && (item.status === 'downloading' || item.status === 'queued')
      )
    ).length
);

const userInitial = computed(() => user.value?.nickname?.charAt(0).toUpperCase() ?? '?');

// Reflect the real Shikimori sync state rather than always reading "Synced":
// the app has an offline queue, so pending changes / an in-flight sync should
// show instead of a misleading green dot.
const fullySynced = computed(
  () => syncStatus.value.state !== 'syncing' && offlineQueueLength.value === 0
);
const syncLabel = computed(() => {
  if (syncStatus.value.state === 'syncing') return 'Syncing…';
  if (offlineQueueLength.value > 0) {
    return `${offlineQueueLength.value} pending`;
  }
  return 'Synced';
});
</script>

<template>
  <aside class="sidebar">
    <div class="logo">
      <div class="logo-mark">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
          <path stroke-linecap="round" stroke-linejoin="round" :d="downloadIcon" />
        </svg>
      </div>
      <div class="logo-text">
        <span class="name">Anime DL</span>
        <span class="sub">smotret-anime</span>
      </div>
    </div>

    <nav class="nav-group">
      <button
        v-for="item in primaryItems"
        :key="item.id"
        class="nav-item"
        :class="{ active: currentView === item.id }"
        @click="libraryStore.navigate(item.id)"
      >
        <svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">
          <path stroke-linecap="round" stroke-linejoin="round" :d="item.icon" />
        </svg>
        <span>{{ item.label }}</span>
        <span v-if="item.id === 'downloads' && downloadCount > 0" class="count">{{
          downloadCount
        }}</span>
      </button>
    </nav>

    <nav v-if="loggedIn" class="nav-group">
      <div class="nav-label">Shikimori</div>
      <button
        v-for="item in shikimoriItems"
        :key="item.id"
        class="nav-item"
        :class="{ active: currentView === item.id }"
        @click="libraryStore.navigate(item.id)"
      >
        <svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">
          <path stroke-linecap="round" stroke-linejoin="round" :d="item.icon" />
        </svg>
        <span>{{ item.label }}</span>
      </button>
    </nav>

    <nav class="nav-group">
      <button
        class="nav-item"
        :class="{ active: currentView === settingsItem.id }"
        @click="libraryStore.navigate(settingsItem.id)"
      >
        <svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">
          <path stroke-linecap="round" stroke-linejoin="round" :d="settingsItem.icon" />
        </svg>
        <span>{{ settingsItem.label }}</span>
      </button>
    </nav>

    <div v-if="loggedIn && user" class="sidebar-foot">
      <div class="user-chip">
        <img v-if="user.avatar" :src="user.avatar" :alt="user.nickname" class="user-avatar" />
        <div v-else class="user-avatar">{{ userInitial }}</div>
        <div class="user-meta">
          <div class="u-name">{{ user.nickname }}</div>
          <div class="u-sync" :class="{ offline: !fullySynced }">
            <span class="dot"></span>{{ syncLabel }}
          </div>
        </div>
      </div>
    </div>
  </aside>
</template>
