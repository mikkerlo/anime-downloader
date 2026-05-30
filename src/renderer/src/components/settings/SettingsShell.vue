<script setup lang="ts">
import { ref, computed } from 'vue';
import { useSettingsAutosave } from '../../composables/use-settings-autosave';
import GeneralTab from './GeneralTab.vue';
import StorageTab from './StorageTab.vue';
import ConnectorsTab from './ConnectorsTab.vue';
import MergingTab from './MergingTab.vue';
import PlayerTab from './PlayerTab.vue';
import ShortcutsTab from './ShortcutsTab.vue';
import WatchTogetherTab from './WatchTogetherTab.vue';
import DebugTab from './DebugTab.vue';

type TabName =
  | 'general'
  | 'storage'
  | 'player'
  | 'connectors'
  | 'merging'
  | 'shortcuts'
  | 'watch-together'
  | 'debug';

type TabDef = { id: TabName; label: string; icon: string; badge?: string };

// Heroicons-style 24px outline paths, matching the Sidebar's inline-svg convention.
const TABS: TabDef[] = [
  {
    id: 'general',
    label: 'General',
    icon: 'M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a6.759 6.759 0 010 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 010-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.28z M15 12a3 3 0 11-6 0 3 3 0 016 0z'
  },
  {
    id: 'storage',
    label: 'Storage',
    icon: 'M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z'
  },
  {
    id: 'player',
    label: 'Player',
    icon: 'M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 010 1.972l-11.54 6.347a1.125 1.125 0 01-1.667-.986V5.653z'
  },
  {
    id: 'connectors',
    label: 'Connectors',
    icon: 'M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m13.35-.622l1.757-1.757a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244'
  },
  {
    id: 'merging',
    label: 'Merging',
    icon: 'M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.456-2.456L14.25 6l1.035-.259a3.375 3.375 0 002.456-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456z'
  },
  {
    id: 'shortcuts',
    label: 'Shortcuts',
    icon: 'M6 6h.008v.008H6V6zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zM6 18h.008v.008H6V18zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zM18 6h.008v.008H18V6zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zM18 18h.008v.008H18V18zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zM12 12h.008v.008H12V12zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z'
  },
  {
    id: 'watch-together',
    label: 'Watch Together',
    badge: 'in development',
    icon: 'M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z'
  },
  {
    id: 'debug',
    label: 'Debug',
    icon: 'M12 12.75c1.148 0 2.278.08 3.383.237 1.037.146 1.866.966 1.866 2.013 0 3.728-2.35 6.75-5.25 6.75S6.75 18.728 6.75 15c0-1.046.83-1.867 1.866-2.013A24.204 24.204 0 0112 12.75zm0 0c2.883 0 5.647.508 8.207 1.44a23.91 23.91 0 01-1.152 6.06M12 12.75c-2.883 0-5.647.508-8.208 1.44.125 2.104.52 4.136 1.153 6.06M12 12.75a2.25 2.25 0 002.248-2.354M12 12.75a2.25 2.25 0 01-2.248-2.354M12 8.25c.995 0 1.971-.08 2.922-.236.403-.066.74-.358.795-.762a3.778 3.778 0 00-.399-2.25M12 8.25c-.995 0-1.97-.08-2.922-.236-.402-.066-.74-.358-.795-.762a3.734 3.734 0 01.4-2.253M12 8.25a2.25 2.25 0 00-2.248 2.146M12 8.25a2.25 2.25 0 012.248 2.146M8.683 5a6.032 6.032 0 01-1.155-1.002c.07-.63.27-1.222.574-1.747m.581 2.749A3.75 3.75 0 0115.318 5m0 0c.427-.283.815-.62 1.155-.999a4.471 4.471 0 00-.575-1.752M4.921 6a24.048 24.048 0 00-.392 3.314c1.668.546 3.416.914 5.223 1.082M19.08 6c.205 1.08.337 2.187.392 3.314a23.882 23.882 0 01-5.223 1.082'
  }
];

const activeTab = ref<TabName>('general');
const { savedVisible } = useSettingsAutosave();

const activeComponent = computed(() => {
  switch (activeTab.value) {
    case 'general':
      return GeneralTab;
    case 'storage':
      return StorageTab;
    case 'connectors':
      return ConnectorsTab;
    case 'merging':
      return MergingTab;
    case 'player':
      return PlayerTab;
    case 'shortcuts':
      return ShortcutsTab;
    case 'watch-together':
      return WatchTogetherTab;
    case 'debug':
      return DebugTab;
  }
  return GeneralTab;
});
</script>

<template>
  <main class="settings-view">
    <header class="topbar">
      <h2>Settings</h2>
    </header>
    <div class="body">
      <div class="settings-layout">
        <nav class="settings-nav">
          <button
            v-for="t in TABS"
            :key="t.id"
            class="settings-tab"
            :class="{ active: activeTab === t.id }"
            :aria-current="activeTab === t.id ? 'page' : undefined"
            @click="activeTab = t.id"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">
              <path stroke-linecap="round" stroke-linejoin="round" :d="t.icon" />
            </svg>
            <span class="st-label">{{ t.label }}</span>
            <span v-if="t.badge" class="st-badge">{{ t.badge }}</span>
          </button>
        </nav>

        <div class="settings-panel">
          <keep-alive>
            <component :is="activeComponent" />
          </keep-alive>
        </div>
      </div>
    </div>
    <transition name="saved-fade">
      <div v-if="savedVisible" class="saved-toast">Saved</div>
    </transition>
  </main>
</template>

<style scoped>
.settings-view {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  position: relative;
  background: var(--bg);
}

.topbar {
  padding: 18px var(--pad-x);
  border-bottom: 1px solid var(--border-soft);
}

.topbar h2 {
  font-family: var(--font-display);
  font-size: 1.15rem;
  font-weight: 700;
  color: var(--text);
}

.body {
  flex: 1;
  overflow-y: auto;
  padding: var(--pad-x);
}

.settings-layout {
  display: grid;
  grid-template-columns: 208px 1fr;
  gap: 30px;
  align-items: start;
}

@media (max-width: 920px) {
  .settings-layout {
    grid-template-columns: 1fr;
  }
}

.settings-nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
  position: sticky;
  top: 0;
}

.settings-tab {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 10px 12px;
  border: none;
  background: none;
  border-radius: var(--radius-btn);
  color: var(--text-3);
  font-family: var(--font-ui);
  font-size: 0.88rem;
  font-weight: 600;
  text-align: left;
  cursor: pointer;
  transition: all 0.15s var(--ease);
}

.settings-tab:hover {
  background: var(--surface-2);
  color: var(--text);
}

.settings-tab.active {
  background: var(--accent-soft);
  color: var(--accent);
}

.settings-tab svg {
  width: 18px;
  height: 18px;
  flex-shrink: 0;
}

.st-label {
  flex: 1;
  min-width: 0;
}

.st-badge {
  padding: 1px 6px;
  border-radius: var(--radius-chip);
  background: color-mix(in srgb, var(--st-orange) 18%, transparent);
  color: var(--st-orange);
  font-size: 0.58rem;
  font-weight: 700;
  letter-spacing: 0.02em;
  text-transform: uppercase;
}

.settings-panel {
  max-width: 760px;
}

.saved-toast {
  position: absolute;
  bottom: 24px;
  right: 24px;
  padding: 8px 18px;
  background: var(--surface-2);
  border: 1px solid var(--st-green);
  color: var(--st-green);
  font-size: 0.85rem;
  font-weight: 600;
  border-radius: var(--radius-btn);
  pointer-events: none;
  box-shadow: var(--shadow-card);
}

.saved-fade-enter-active,
.saved-fade-leave-active {
  transition: opacity 0.3s;
}

.saved-fade-enter-from,
.saved-fade-leave-to {
  opacity: 0;
}
</style>
