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
  | 'connectors'
  | 'merging'
  | 'player'
  | 'shortcuts'
  | 'watch-together'
  | 'debug';

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
    <div class="tabs">
      <button
        class="tab"
        :class="{ active: activeTab === 'general' }"
        @click="activeTab = 'general'"
      >
        General
      </button>
      <button
        class="tab"
        :class="{ active: activeTab === 'storage' }"
        @click="activeTab = 'storage'"
      >
        Storage
      </button>
      <button
        class="tab"
        :class="{ active: activeTab === 'connectors' }"
        @click="activeTab = 'connectors'"
      >
        Connectors
      </button>
      <button
        class="tab"
        :class="{ active: activeTab === 'merging' }"
        @click="activeTab = 'merging'"
      >
        Merging
      </button>
      <button class="tab" :class="{ active: activeTab === 'player' }" @click="activeTab = 'player'">
        Player
      </button>
      <button
        class="tab"
        :class="{ active: activeTab === 'shortcuts' }"
        @click="activeTab = 'shortcuts'"
      >
        Shortcuts
      </button>
      <button
        class="tab"
        :class="{ active: activeTab === 'watch-together' }"
        @click="activeTab = 'watch-together'"
      >
        Watch Together
        <span class="tab-dev-badge">in development</span>
      </button>
      <button class="tab" :class="{ active: activeTab === 'debug' }" @click="activeTab = 'debug'">
        Debug
      </button>
    </div>
    <div class="body">
      <keep-alive>
        <component :is="activeComponent" />
      </keep-alive>
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
}

.topbar {
  padding: 16px 24px;
  border-bottom: 1px solid #0f3460;
}

.topbar h2 {
  font-size: 1.1rem;
  font-weight: 600;
  color: #e0e0e0;
}

.tabs {
  display: flex;
  gap: 0;
  border-bottom: 1px solid #0f3460;
  padding: 0 24px;
}

.tab {
  padding: 10px 20px;
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  color: #6a6a8a;
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s;
}

.tab:hover {
  color: #a0a0b8;
}

.tab.active {
  color: #e94560;
  border-bottom-color: #e94560;
}

.tab-dev-badge {
  margin-left: 6px;
  padding: 1px 6px;
  border-radius: 8px;
  background: rgba(245, 158, 11, 0.18);
  color: #f59e0b;
  font-size: 0.65rem;
  font-weight: 700;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  vertical-align: middle;
}

.body {
  flex: 1;
  overflow-y: auto;
  padding: 24px;
  max-width: 600px;
}

.saved-toast {
  position: absolute;
  bottom: 24px;
  right: 24px;
  padding: 8px 18px;
  background-color: #2d6a30;
  color: #6ab04c;
  font-size: 0.85rem;
  font-weight: 600;
  border-radius: 8px;
  pointer-events: none;
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
