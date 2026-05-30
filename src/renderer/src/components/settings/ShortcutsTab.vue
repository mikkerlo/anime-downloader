<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useSettingsAutosave } from '../../composables/use-settings-autosave';
import SettingsGroup from './SettingsGroup.vue';
import SettingsRow from './SettingsRow.vue';

const { showSaved } = useSettingsAutosave();

const DEFAULT_SHORTCUTS: Record<string, string> = {
  back: 'Escape',
  focusSearch: 'CmdOrCtrl+F',
  goDownloads: 'CmdOrCtrl+D',
  playerPrevEpisode: 'Shift+ArrowLeft',
  playerNextEpisode: 'Shift+ArrowRight',
  shaderModeA: 'CmdOrCtrl+1',
  shaderModeB: 'CmdOrCtrl+2',
  shaderModeC: 'CmdOrCtrl+3',
  shaderOff: 'CmdOrCtrl+Backquote'
};

const SHORTCUT_LABELS: Record<string, { label: string; hint: string }> = {
  back: { label: 'Go back', hint: 'Navigate back from anime detail view' },
  focusSearch: { label: 'Focus search', hint: 'Switch to Search tab and focus the input' },
  goDownloads: { label: 'Go to downloads', hint: 'Switch to Downloads tab' },
  playerPrevEpisode: {
    label: 'Previous episode',
    hint: 'Go to previous episode in the built-in player'
  },
  playerNextEpisode: { label: 'Next episode', hint: 'Go to next episode in the built-in player' },
  shaderModeA: { label: 'Shader: Mode A', hint: 'Switch to Anime4K Mode A in player' },
  shaderModeB: { label: 'Shader: Mode B', hint: 'Switch to Anime4K Mode B in player' },
  shaderModeC: { label: 'Shader: Mode C', hint: 'Switch to Anime4K Mode C in player' },
  shaderOff: { label: 'Shader: Off', hint: 'Disable Anime4K shaders in player' }
};

const shortcutBindings = ref<Record<string, string>>({});
const recordingAction = ref<string | null>(null);
const isMac = navigator.platform.toUpperCase().includes('MAC');

const webgpuStatus = ref<{ available: boolean; gpuName: string }>({
  available: false,
  gpuName: ''
});

const KEY_SYMBOLS: Record<string, string> = {
  CmdOrCtrl: isMac ? '⌘' : 'Ctrl',
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  Backquote: '`',
  ' ': 'Space'
};

function keycaps(binding: string): string[] {
  if (!binding) return [];
  return binding.split('+').map((part) => KEY_SYMBOLS[part] || part);
}

function captureKey(e: KeyboardEvent): void {
  if (!recordingAction.value) return;
  e.preventDefault();
  e.stopPropagation();

  if (e.key === 'Escape' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
    stopRecording();
    return;
  }

  // Ignore bare modifier keys
  if (['Control', 'Meta', 'Alt', 'Shift'].includes(e.key)) return;

  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('CmdOrCtrl');
  if (e.shiftKey) parts.push('Shift');
  if (e.altKey) parts.push('Alt');

  const keyName = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  parts.push(keyName);

  shortcutBindings.value[recordingAction.value] = parts.join('+');
  stopRecording();
  saveShortcuts();
}

function startRecording(action: string): void {
  recordingAction.value = action;
  window.addEventListener('keydown', captureKey, true);
}

function stopRecording(): void {
  recordingAction.value = null;
  window.removeEventListener('keydown', captureKey, true);
}

function cancelRecording(): void {
  stopRecording();
}

function clearBinding(action: string): void {
  shortcutBindings.value[action] = '';
  saveShortcuts();
}

function resetShortcuts(): void {
  shortcutBindings.value = { ...DEFAULT_SHORTCUTS };
  saveShortcuts();
}

function saveShortcuts(): void {
  void window.api.setSetting('keyboardShortcuts', { ...shortcutBindings.value });
  showSaved();
}

onMounted(async () => {
  const saved = (await window.api.getSetting('keyboardShortcuts')) as Record<string, string> | null;
  shortcutBindings.value = saved ? { ...DEFAULT_SHORTCUTS, ...saved } : { ...DEFAULT_SHORTCUTS };

  // Probe WebGPU to decide whether shader shortcuts are shown.
  try {
    if (navigator.gpu) {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) {
        const info = adapter.info;
        webgpuStatus.value = {
          available: true,
          gpuName: info.device || info.description || info.vendor || 'Unknown GPU'
        };
      }
    }
  } catch {
    /* WebGPU not available */
  }
});
</script>

<template>
  <div>
    <SettingsGroup
      title="Keyboard shortcuts"
      desc="Click “Record” to set a new key, press Escape to cancel recording. Click “Clear” to disable a shortcut."
    >
      <SettingsRow
        v-for="(meta, action) in SHORTCUT_LABELS"
        v-show="!String(action).startsWith('shader') || webgpuStatus.available"
        :key="action"
        :label="meta.label"
        :desc="meta.hint"
      >
        <div class="shortcut-controls">
          <span v-if="recordingAction === action" class="kbd recording">Press a key…</span>
          <span v-else-if="!shortcutBindings[action]" class="kbd empty">None</span>
          <div v-else class="kbd-group">
            <template v-for="(cap, i) in keycaps(shortcutBindings[action])" :key="i">
              <span v-if="i > 0" class="plus">+</span>
              <span class="kbd">{{ cap }}</span>
            </template>
          </div>
          <button v-if="recordingAction === action" class="btn btn-sm" @click="cancelRecording">
            Cancel
          </button>
          <button v-else class="btn btn-sm" @click="startRecording(action)">Record</button>
          <button
            class="btn btn-sm btn-danger"
            :disabled="!shortcutBindings[action]"
            @click="clearBinding(action)"
          >
            Clear
          </button>
        </div>
      </SettingsRow>
    </SettingsGroup>

    <SettingsGroup>
      <SettingsRow label="Reset" desc="Restore all shortcuts to their defaults.">
        <button class="btn btn-sm" @click="resetShortcuts">Reset to defaults</button>
      </SettingsRow>
    </SettingsGroup>
  </div>
</template>

<style scoped src="@renderer/assets/settings-tabs.css"></style>

<style scoped>
.shortcut-controls {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.shortcut-controls .kbd.recording {
  animation: pulse-border 1s ease-in-out infinite;
}

@keyframes pulse-border {
  0%,
  100% {
    border-color: var(--accent);
  }
  50% {
    border-color: var(--accent-line);
  }
}
</style>
