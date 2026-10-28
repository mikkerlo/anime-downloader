<script setup lang="ts">
import { ref } from 'vue';
import { storeToRefs } from 'pinia';
import LibraryActionsMenu from './LibraryActionsMenu.vue';
import { lastSyncWhen, useSharedLibrariesStore } from '../../stores/shared-libraries';
import { formatAgo } from '../../utils';

// Settings → Storage → Shared Libraries (#581): every attached library, with
// the same Open folder / Re-locate / Forget actions as the Library tab.
const { libraries } = storeToRefs(useSharedLibrariesStore());
const error = ref('');

const MODE_LABEL: Record<SharedLibraryMode, string> = {
  videos: 'Videos only',
  metadata: 'With metadata'
};
</script>

<template>
  <div v-if="libraries.length > 0" class="sl-table-wrap">
    <p v-if="error" class="sl-error">{{ error }}</p>
    <table class="sl-table" data-testid="shared-libraries-table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Owner</th>
          <th>Mode</th>
          <th>Root</th>
          <th>Last seen</th>
          <th>Last sync</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="lib in libraries" :key="lib.libraryId" data-testid="shared-library-row">
          <td>
            <span class="dot" :class="lib.available ? 'on' : 'off'"></span>
            {{ lib.name }}
          </td>
          <td>{{ lib.ownerNickname ?? '—' }}</td>
          <td>
            {{ MODE_LABEL[lib.mode]
            }}<template v-if="lib.access === 'read-only'"> · Read-only</template>
          </td>
          <td class="root" :title="lib.root">{{ lib.root }}</td>
          <td>{{ lib.available ? 'Connected' : formatAgo(lib.lastSeenAt) }}</td>
          <td>{{ lastSyncWhen(lib.lastSyncAt) }}</td>
          <td><LibraryActionsMenu :library="lib" @error="error = $event" /></td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped src="./shared-library.css"></style>

<style scoped>
.sl-table-wrap {
  padding: 4px 0 8px;
}

.sl-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.8rem;
  color: var(--text-2);
}

.sl-table th {
  text-align: left;
  font-weight: 600;
  color: var(--text-faint);
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
}

.sl-table td {
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
  vertical-align: middle;
}

.root {
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-right: 6px;
}

.dot.on {
  background: var(--st-green);
}

.dot.off {
  background: var(--text-faint);
}
</style>
