<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, type Component } from 'vue';
import { storeToRefs } from 'pinia';
import { TRACKER_LABELS } from '@shared/trackers/labels';
import { useTrackersStore } from '../../stores/trackers';
import { useShikimoriStore } from '../../stores/shikimori';
import SettingsGroup from './SettingsGroup.vue';
import SettingsRow from './SettingsRow.vue';
import TrackerPendingDialog from './TrackerPendingDialog.vue';
import type { TrackerConnectFormHandle } from './tracker-connect-form';

// One tracker's account in Settings → Trackers (#700): what Connectors' Shikimori
// group was, keyed by `trackerId`. The connect body is the tracker's own
// component (`tracker-connect-form.ts` has the contract); everything else
// here is generic.
const props = defineProps<{
  trackerId: TrackerId;
  desc: string;
  connectForm: Component;
}>();

const { accounts, aggregateSyncState } = storeToRefs(useTrackersStore());
const shikimoriStore = useShikimoriStore();

const label = computed(() => TRACKER_LABELS[props.trackerId]);
const account = computed(() => accounts.value.find((a) => a.trackerId === props.trackerId) ?? null);
const user = computed(() => account.value?.user ?? null);
// The live sync status, or the accounts payload before it loads (and, for
// "Needs setup", a tracker with no session to report a status for).
const syncRow = computed(
  () => aggregateSyncState.value.trackers.find((r) => r.trackerId === props.trackerId) ?? null
);
const sessionExpired = computed(() =>
  Boolean(syncRow.value?.sessionExpired || account.value?.sessionExpired)
);
const needsSetup = computed(() => Boolean(syncRow.value?.needsSetup || account.value?.needsSetup));
const queueLength = computed(() => syncRow.value?.queueLength ?? 0);

const connectFormRef = ref<TrackerConnectFormHandle | null>(null);
const connectActive = computed(() => connectFormRef.value?.active ?? false);

// `useShikimoriStore().user` isn't derived from the accounts broadcast (#697),
// so every sign-in and logout here refreshes it, or the facade's readers would
// stay signed in until a restart. A failed read isn't the caller's failure.
async function syncFacadeUser(): Promise<void> {
  if (props.trackerId !== 'shikimori') return;
  try {
    await shikimoriStore.refreshUser();
  } catch (err) {
    console.warn('[trackers] refreshing the Shikimori user failed:', err);
  }
}

// Unsynced changes kept for accounts other than the signed-in one (#588).
// Bucket keys are strings (#694), so the user's id is compared as one.
const parkedQueues = ref<TrackerParkedQueueSummary[]>([]);
const keptQueues = computed(() => {
  const own = user.value ? String(user.value.id) : undefined;
  return parkedQueues.value.filter((p) => p.ownerId !== own);
});

type PendingDialog =
  | { mode: 'disconnect'; count: number; nickname: string }
  | { mode: 'switch'; count: number; nickname: string; ownerId: string; newNickname: string }
  | { mode: 'discard'; count: number; nickname: string | null; ownerId: string | null };
const pendingDialog = ref<PendingDialog | null>(null);
const pendingError = ref('');

// A failed reload keeps the rows already shown; it isn't the caller's failure.
async function loadParkedQueues(): Promise<void> {
  try {
    parkedQueues.value = await window.api.trackerGetParkedQueues(props.trackerId);
  } catch (err) {
    console.warn(`[trackers] loading kept ${props.trackerId} changes failed:`, err);
  }
}

async function complete(signIn: () => Promise<TrackerUser>): Promise<void> {
  const prev = user.value;
  const next = await signIn();
  await syncFacadeUser();
  await loadParkedQueues();
  const prevOwner = prev ? String(prev.id) : null;
  const kept =
    prev && prev.id !== next.id && parkedQueues.value.find((p) => p.ownerId === prevOwner);
  if (prev && prevOwner && kept) {
    pendingDialog.value = {
      mode: 'switch',
      count: kept.count,
      nickname: prev.nickname,
      ownerId: prevOwner,
      newNickname: next.nickname
    };
  }
}

function reconnect(): void {
  void connectFormRef.value?.begin();
}

async function logout(opts?: TrackerLogoutOptions): Promise<void> {
  await window.api.trackerLogout(props.trackerId, opts);
  await syncFacadeUser();
  connectFormRef.value?.reset();
  await loadParkedQueues();
}

async function disconnect(): Promise<void> {
  if (queueLength.value > 0 && user.value) {
    pendingDialog.value = {
      mode: 'disconnect',
      count: queueLength.value,
      nickname: user.value.nickname
    };
    return;
  }
  await logout();
}

function confirmDiscardKept(kept: TrackerParkedQueueSummary): void {
  pendingDialog.value = {
    mode: 'discard',
    count: kept.count,
    nickname: kept.ownerId === null ? null : kept.nickname,
    ownerId: kept.ownerId
  };
}

async function onPendingKeep(): Promise<void> {
  const dialog = pendingDialog.value;
  pendingDialog.value = null;
  pendingError.value = '';
  if (dialog?.mode !== 'disconnect') return;
  try {
    await logout({ pending: 'keep' });
  } catch (err) {
    pendingError.value = String(err);
  }
}

async function onPendingDiscard(): Promise<void> {
  const dialog = pendingDialog.value;
  pendingDialog.value = null;
  pendingError.value = '';
  if (!dialog) return;
  try {
    if (dialog.mode === 'disconnect') {
      await logout({ pending: 'discard' });
      return;
    }
    await window.api.trackerDiscardParkedQueue(props.trackerId, dialog.ownerId);
  } catch (err) {
    pendingError.value = String(err);
  }
  await loadParkedQueues();
}

// Main changes kept buckets on its own too (a late edit parked for its owner,
// the drain consuming a parked entry), and announces both with this broadcast.
// Only the `tracker:*` event: Shikimori's is double-emitted (#694), and a
// second subscription would reload twice.
const unsubscribeQueueChanged = window.api.onTrackerOfflineQueueChanged(({ trackerId }) => {
  if (trackerId === props.trackerId) void loadParkedQueues();
});
onUnmounted(() => unsubscribeQueueChanged());

onMounted(async () => {
  if (props.trackerId === 'shikimori' && !shikimoriStore.user) await syncFacadeUser();
  await loadParkedQueues();
});
</script>

<template>
  <div class="tracker-account-card" :data-tracker-id="trackerId">
    <SettingsGroup :title="label" :desc="desc">
      <!-- Expiry is not a logout: the account, its caches and the queued updates
         are all still here, so the card keeps its identity and only swaps the
         chip and the primary action (#244). -->
      <div v-if="user" class="conn-card">
        <div class="conn-logo" style="background: var(--st-blue)">
          <img v-if="user.avatar" :src="user.avatar" />
          <span v-else>{{ label.slice(0, 2) }}</span>
        </div>
        <div class="conn-info">
          <div class="ci-name">
            {{ user.nickname }}
            <span v-if="sessionExpired" class="chip red"
              ><span class="dot"></span>Session expired</span
            >
            <span v-else-if="needsSetup" class="chip orange"
              ><span class="dot"></span>Needs setup</span
            >
            <span v-else class="chip green"><span class="dot"></span>Connected</span>
          </div>
          <div v-if="sessionExpired" class="ci-meta">
            {{ label }} rejected the saved sign-in.
            <template v-if="queueLength > 0">
              {{ queueLength }} pending update{{ queueLength > 1 ? 's' : '' }} will sync after you
              reconnect.
            </template>
          </div>
          <div v-else class="ci-meta">{{ label }} account</div>
        </div>
        <button
          v-if="sessionExpired"
          class="btn btn-sm btn-primary"
          :disabled="connectActive"
          @click="reconnect"
        >
          Reconnect
        </button>
        <button v-else class="btn btn-sm btn-outline" @click="disconnect">Disconnect</button>
      </div>

      <!-- With no account the chip has no card to sit on, so it gets a row; the
         connect body below says what to set up. -->
      <SettingsRow v-if="!user && needsSetup" class="needs-setup-row">
        <span class="chip orange"><span class="dot"></span>Needs setup</span>
      </SettingsRow>

      <!-- Kept mounted (v-show): Reconnect starts the body's sign-in, and the
         body is shown once it has one in progress. -->
      <SettingsRow v-show="!user || (sessionExpired && connectActive)" stack>
        <component :is="connectForm" ref="connectFormRef" :complete="complete" />
      </SettingsRow>

      <SettingsRow
        v-for="kept in keptQueues"
        :key="kept.ownerId ?? 'unknown'"
        class="kept-queue-row"
      >
        <template #text>
          <div v-if="kept.ownerId === null" class="sr-desc">
            {{ kept.count }} unsynced change{{ kept.count === 1 ? '' : 's' }} from an unknown
            account. They won't sync automatically.
          </div>
          <div v-else class="sr-desc">
            {{ kept.nickname }}: {{ kept.count }} unsynced change{{
              kept.count === 1 ? '' : 's'
            }}
            kept. They sync when {{ kept.nickname }} signs in again.
          </div>
        </template>
        <button class="btn btn-sm btn-danger" @click="confirmDiscardKept(kept)">Discard</button>
      </SettingsRow>
      <SettingsRow v-if="pendingError" stack>
        <div class="inline-result bad pending-error">{{ pendingError }}</div>
      </SettingsRow>
    </SettingsGroup>

    <TrackerPendingDialog
      v-if="pendingDialog"
      :mode="pendingDialog.mode"
      :tracker-label="label"
      :count="pendingDialog.count"
      :nickname="pendingDialog.nickname"
      :new-nickname="pendingDialog.mode === 'switch' ? pendingDialog.newNickname : undefined"
      @keep="onPendingKeep"
      @discard="onPendingDiscard"
      @cancel="pendingDialog = null"
    />
  </div>
</template>

<style scoped src="@renderer/assets/settings-tabs.css"></style>
