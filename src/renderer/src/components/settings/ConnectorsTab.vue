<script setup lang="ts">
import { nextTick, ref, watch, onMounted } from 'vue';
import { useSettingsAutosave } from '../../composables/use-settings-autosave';
import SettingsGroup from './SettingsGroup.vue';
import SettingsRow from './SettingsRow.vue';

const { autoSave } = useSettingsAutosave();

const loaded = ref(false);

const token = ref('');
const tokenStatus = ref<'idle' | 'checking' | 'valid' | 'invalid'>('idle');
const tokenError = ref('');

async function testToken(): Promise<void> {
  tokenStatus.value = 'checking';
  tokenError.value = '';
  try {
    const result = await window.api.validateToken();
    if (result.valid) {
      tokenStatus.value = 'valid';
    } else {
      tokenStatus.value = 'invalid';
      tokenError.value = result.error || 'Invalid token';
    }
  } catch (err) {
    tokenStatus.value = 'invalid';
    tokenError.value = String(err);
  }
}

onMounted(async () => {
  token.value = ((await window.api.getSetting('token')) as string) || '';
  // The watcher below runs on the next flush: let it see the hydration write
  // while `loaded` is still false, so the value just read isn't saved back.
  await nextTick();
  loaded.value = true;
});

let tokenTimer: ReturnType<typeof setTimeout> | null = null;
watch(token, (val) => {
  if (!loaded.value) return;
  tokenStatus.value = 'idle';
  if (tokenTimer) clearTimeout(tokenTimer);
  tokenTimer = setTimeout(() => autoSave('token', val.trim()), 800);
});
</script>

<template>
  <div>
    <SettingsGroup
      title="Anime 365 (smotret-anime.app)"
      desc="API token for Anime 365 (smotret-anime.app). Required for downloading episodes."
    >
      <SettingsRow stack>
        <div class="token-row">
          <input
            id="token-input"
            v-model="token"
            type="password"
            class="field-input token-input"
            placeholder="Enter your API token..."
          />
          <button
            class="btn btn-sm"
            :disabled="!token || tokenStatus === 'checking'"
            @click="testToken"
          >
            {{ tokenStatus === 'checking' ? 'Testing...' : 'Test' }}
          </button>
        </div>
        <div v-if="tokenStatus === 'valid'" class="inline-result ok">Token is valid</div>
        <div v-if="tokenStatus === 'invalid'" class="inline-result bad">{{ tokenError }}</div>
      </SettingsRow>
    </SettingsGroup>
  </div>
</template>

<style scoped src="@renderer/assets/settings-tabs.css"></style>

<style scoped>
.token-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.token-input {
  flex: 1;
}
</style>
