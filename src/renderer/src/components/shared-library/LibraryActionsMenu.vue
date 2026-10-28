<script setup lang="ts">
import { ref } from 'vue';
import ForgetLibraryDialog from './ForgetLibraryDialog.vue';
import { useSharedLibrariesStore } from '../../stores/shared-libraries';

// A library's ⋯ menu (#581): Open folder, Re-locate…, Forget. Shared by the
// Shared Libraries tab and Settings → Storage.
const props = defineProps<{ library: AttachedLibraryInfo }>();
const emit = defineEmits<{ error: [message: string] }>();
const shared = useSharedLibrariesStore();

const open = ref(false);
const forgetting = ref(false);

async function openFolder(): Promise<void> {
  open.value = false;
  const err = await window.api.fileOpen(props.library.root);
  emit('error', err ? `Couldn't open the folder: ${err}` : '');
}

async function relocate(): Promise<void> {
  open.value = false;
  const res = await window.api.sharedLibraryRelocate(props.library.libraryId);
  emit('error', res.ok ? '' : (res.error ?? ''));
  if (res.ok) await shared.refresh();
}

function forget(): void {
  open.value = false;
  forgetting.value = true;
}

async function forgotten(): Promise<void> {
  emit('error', '');
  await shared.refresh();
}
</script>

<template>
  <div class="actions-menu">
    <button
      class="sl-btn menu-btn"
      data-testid="library-menu"
      :aria-expanded="open"
      title="More"
      @click.stop="open = !open"
    >
      ⋯
    </button>
    <div v-if="open" class="menu-backdrop" @click="open = false"></div>
    <div v-if="open" class="menu" role="menu">
      <button class="menu-item" role="menuitem" data-testid="menu-open-folder" @click="openFolder">
        Open folder
      </button>
      <button class="menu-item" role="menuitem" data-testid="menu-relocate" @click="relocate">
        Re-locate…
      </button>
      <button class="menu-item danger" role="menuitem" data-testid="menu-forget" @click="forget">
        Forget
      </button>
    </div>
    <ForgetLibraryDialog
      v-if="forgetting"
      :library="library"
      @close="forgetting = false"
      @forgotten="forgotten"
    />
  </div>
</template>

<style scoped src="./shared-library.css"></style>

<style scoped>
.actions-menu {
  position: relative;
}

.menu-btn {
  padding: 4px 10px;
  font-size: 1rem;
  line-height: 1;
}

.menu-backdrop {
  position: fixed;
  inset: 0;
  z-index: 50;
}

.menu {
  position: absolute;
  right: 0;
  top: calc(100% + 4px);
  z-index: 51;
  min-width: 160px;
  display: flex;
  flex-direction: column;
  padding: 4px;
  background: var(--surface);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-input);
}

.menu-item {
  padding: 7px 10px;
  background: none;
  border: none;
  border-radius: var(--radius-input);
  color: var(--text-2);
  font-family: inherit;
  font-size: 0.82rem;
  text-align: left;
  cursor: pointer;
}

.menu-item:hover {
  background: var(--surface-2);
  color: var(--text);
}

.menu-item.danger {
  color: var(--st-red);
}
</style>
