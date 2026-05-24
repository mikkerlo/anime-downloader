<script setup lang="ts">
// Two-level translation picker (type group → translation item) for the
// player's controls bar. Phase 5 slice 5e (#118).
//
// The component is presentation-only: PlayerView owns the menu state +
// level + selectedTypeGroup refs and the computed groups/items, and
// emits a `select` on item click. Keeping state in the parent is what
// lets the menu auto-jump levels when the user opens it.

import { qualityLabel } from '../../utils';

type Translation = { id: number; label: string; type: string; height: number };
type TypeGroup = { type: string; label: string; items: Translation[] };

defineProps<{
  open: boolean;
  loading: boolean;
  level: 'types' | 'items';
  selectedTypeGroup: string;
  groups: TypeGroup[];
  selectedItems: Translation[];
  activeTranslationId: number;
  activeDownloadedTrIds: number[];
  currentLabel: string;
}>();

const emit = defineEmits<{
  'toggle-menu': [];
  'open-group': [type: string];
  'back-to-types': [];
  select: [tr: Translation];
}>();

function typeLabelForGroup(groups: TypeGroup[], type: string): string {
  return groups.find((g) => g.type === type)?.label || type;
}
</script>

<template>
  <div class="preset-wrapper">
    <button
      class="ctrl-btn preset-btn translation-btn"
      :class="{ loading }"
      @click="emit('toggle-menu')"
      title="Translation"
    >
      {{ loading ? '...' : currentLabel }}
    </button>
    <div v-if="open" class="preset-menu translation-menu">
      <template v-if="level === 'types'">
        <button
          v-for="group in groups"
          :key="group.type"
          class="preset-option group-option"
          @click="emit('open-group', group.type)"
        >
          <span class="tr-label">{{ group.label }}</span>
          <span class="tr-arrow">›</span>
        </button>
      </template>
      <template v-else>
        <button
          v-if="groups.length > 1"
          class="preset-option back-option"
          @click="emit('back-to-types')"
        >
          <span class="tr-arrow back-arrow">‹</span>
          <span class="tr-label">{{ typeLabelForGroup(groups, selectedTypeGroup) }}</span>
        </button>
        <button
          v-for="tr in selectedItems"
          :key="tr.id"
          class="preset-option"
          :class="{
            selected: activeTranslationId === tr.id,
            downloaded: activeDownloadedTrIds.includes(tr.id)
          }"
          @click="emit('select', tr)"
        >
          <span v-if="activeDownloadedTrIds.includes(tr.id)" class="tr-dl-icon">⬇</span>
          <span class="tr-label">{{ tr.label }}</span>
          <span class="tr-meta">{{ qualityLabel(tr.height) }}</span>
        </button>
      </template>
    </div>
  </div>
</template>

<style scoped src="@renderer/assets/player-menus.css"></style>
<style scoped>
.translation-btn {
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.translation-btn.loading {
  opacity: 0.6;
  pointer-events: none;
}

.translation-menu {
  min-width: 220px;
  max-height: 300px;
  overflow-y: auto;
}

.translation-menu .preset-option {
  display: flex;
  align-items: center;
  gap: 2px;
}

.group-option {
  justify-content: space-between;
}

.tr-arrow {
  font-size: 1rem;
  color: #8a8aaa;
  flex-shrink: 0;
}

.back-option {
  border-bottom: 1px solid #0f3460;
  margin-bottom: 4px;
  padding-bottom: 8px;
  gap: 6px;
}

.back-option .tr-label {
  color: #8a8aaa;
  font-size: 0.75rem;
}

.back-arrow {
  font-size: 1.1rem;
}

.tr-label {
  font-size: 0.8rem;
  color: #ddd;
}

.tr-meta {
  font-size: 0.65rem;
  color: #8a8aaa;
  margin-left: auto;
}

.preset-option.selected .tr-label {
  color: #e94560;
}

.preset-option.selected .tr-meta {
  color: #e94560;
  opacity: 0.7;
}

.tr-dl-icon {
  font-size: 0.7rem;
  color: #6ab04c;
  flex-shrink: 0;
}

.preset-option.downloaded .tr-label {
  color: #6ab04c;
}
</style>
