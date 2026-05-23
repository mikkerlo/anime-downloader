<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useSettingsAutosave } from '../../composables/use-settings-autosave';

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

function formatBinding(binding: string): string {
  if (!binding) return 'None';
  return binding.replace(/CmdOrCtrl/g, isMac ? '⌘' : 'Ctrl').replace(/\+/g, isMac ? '' : '+');
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
    <div class="setting-group">
      <label class="setting-label">Keyboard Shortcuts</label>
      <p class="setting-hint">
        Click "Record" to set a new key, press Escape to cancel recording. Click "Clear" to disable
        a shortcut.
      </p>
    </div>

    <div
      v-for="(meta, action) in SHORTCUT_LABELS"
      :key="action"
      v-show="!String(action).startsWith('shader') || webgpuStatus.available"
      class="shortcut-row"
    >
      <div class="shortcut-info">
        <span class="shortcut-action">{{ meta.label }}</span>
        <span class="shortcut-hint">{{ meta.hint }}</span>
      </div>
      <div class="shortcut-controls">
        <span v-if="recordingAction === action" class="shortcut-key recording">
          Press a key...
        </span>
        <span v-else class="shortcut-key" :class="{ empty: !shortcutBindings[action] }">
          {{ formatBinding(shortcutBindings[action]) }}
        </span>
        <button v-if="recordingAction === action" class="shortcut-btn" @click="cancelRecording">
          Cancel
        </button>
        <button v-else class="shortcut-btn" @click="startRecording(action)">Record</button>
        <button
          class="shortcut-btn shortcut-clear"
          @click="clearBinding(action)"
          :disabled="!shortcutBindings[action]"
        >
          Clear
        </button>
      </div>
    </div>

    <div class="setting-group" style="margin-top: 16px">
      <button class="test-token-btn" @click="resetShortcuts">Reset to defaults</button>
    </div>
  </div>
</template>

<style scoped src="@renderer/assets/settings-tabs.css"></style>

<style scoped>
.shortcut-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  background-color: #16213e;
  border: 1px solid #0f3460;
  border-radius: 8px;
  margin-bottom: 8px;
}

.shortcut-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}

.shortcut-action {
  font-size: 0.9rem;
  font-weight: 600;
  color: #e0e0e0;
}

.shortcut-hint {
  font-size: 0.75rem;
  color: #6a6a8a;
}

.shortcut-controls {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
  margin-left: 16px;
}

.shortcut-key {
  display: inline-block;
  min-width: 80px;
  text-align: center;
  padding: 6px 12px;
  background-color: #0f3460;
  border: 1px solid #1a4a7a;
  border-radius: 6px;
  font-size: 0.85rem;
  font-weight: 600;
  color: #e0e0e0;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, monospace;
}

.shortcut-key.empty {
  color: #4a4a6a;
  font-weight: 400;
}

.shortcut-key.recording {
  border-color: #e94560;
  color: #e94560;
  animation: pulse-border 1s ease-in-out infinite;
  outline: none;
}

@keyframes pulse-border {
  0%,
  100% {
    border-color: #e94560;
  }
  50% {
    border-color: #c0374d;
  }
}

.shortcut-btn {
  padding: 6px 12px;
  background-color: #0f3460;
  border: none;
  border-radius: 6px;
  color: #a0a0b8;
  font-size: 0.8rem;
  cursor: pointer;
  transition: background-color 0.15s;
  white-space: nowrap;
}

.shortcut-btn:hover {
  background-color: #1a4a7a;
  color: #e0e0e0;
}

.shortcut-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.shortcut-clear {
  color: #e94560;
}
</style>
