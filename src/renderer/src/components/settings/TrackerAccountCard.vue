<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, type Component } from 'vue';
import { storeToRefs } from 'pinia';
import { TRACKER_LABELS } from '@shared/trackers/labels';
import { useTrackersStore } from '../../stores/trackers';
import { useShikimoriStore } from '../../stores/shikimori';
import { useSettingsAutosave } from '../../composables/use-settings-autosave';
import SettingsGroup from './SettingsGroup.vue';
import SettingsRow from './SettingsRow.vue';
import SettingsSwitch from './SettingsSwitch.vue';
import TrackerPendingDialog from './TrackerPendingDialog.vue';
import type { TrackerConnectFormHandle } from './tracker-connect-form';
import { formatExpiry, isExpiringSoon } from './session-expiry';

// One tracker's account in Settings → Trackers (#700): what Connectors' Shikimori
// group was, keyed by `trackerId`. The connect body is the tracker's own
// component (`tracker-connect-form.ts` has the contract); everything else
// here is generic.
const props = defineProps<{
  trackerId: TrackerId;
  desc: string;
  connectForm: Component;
}>();

const emit = defineEmits<{
  /** A logout of the primary resolved and left 2+ trackers: `TrackersTab` asks which is primary. */
  'needs-primary-choice': [candidates: TrackerId[]];
}>();

const trackersStore = useTrackersStore();
const {
  accounts,
  aggregateSyncState,
  connected,
  primary,
  primaryCapable,
  multiAccount,
  secondTrackerEnabled,
  openReconcile
} = storeToRefs(trackersStore);
const shikimoriStore = useShikimoriStore();
const { showSaved } = useSettingsAutosave();

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
// A tracker whose token ends on a known date (AniList, #703): warned from two
// weeks before it, while the session still works. `now` ticks once a minute,
// so a window left open crosses the threshold, and the end date, by itself.
const now = ref(Date.now());
const nowTimer = setInterval(() => (now.value = Date.now()), 60_000);
onUnmounted(() => clearInterval(nowTimer));
const expiresAt = computed(() => account.value?.sessionExpiresAt);
const expiringSoon = computed(
  () => !sessionExpired.value && isExpiringSoon(expiresAt.value, now.value)
);
// Past `exp` but before the first 401 says so: "expired", not "expires".
const expired = computed(() => typeof expiresAt.value === 'number' && now.value >= expiresAt.value);
const expiryDate = computed(() =>
  typeof expiresAt.value === 'number' ? formatExpiry(expiresAt.value) : ''
);

const connectFormRef = ref<TrackerConnectFormHandle | null>(null);
const connectActive = computed(() => connectFormRef.value?.active ?? false);

// ---- Multi-account controls (#701): only with 2+ connected accounts --------
const isPrimary = computed(() => primary.value === props.trackerId);
const primaryLabel = computed(() => (primary.value ? TRACKER_LABELS[primary.value] : ''));
// Only a tracker main has a primary write path for can be picked (#692).
const canBePrimary = computed(() => primaryCapable.value.includes(props.trackerId));
const showControls = computed(() => multiAccount.value && user.value !== null);
const mirrorOn = computed(() => trackersStore.mirrorOn(props.trackerId));
// The second-tracker flag (#701): no Connect while another tracker is connected.
const connectBlocked = computed(
  () =>
    !user.value &&
    !secondTrackerEnabled.value &&
    connected.value.some((id) => id !== props.trackerId)
);
// What the last mirror-off confirm actually removed (its `discarded`).
const discardedNote = ref(0);
// Switching the mirror back on offers a review, shown only once #708 sets `openReconcile`.
const reconcileOffered = ref(false);
const choiceError = ref('');

async function choosePrimary(): Promise<void> {
  choiceError.value = '';
  try {
    await trackersStore.setPrimary(props.trackerId);
    showSaved();
  } catch (err) {
    // The store didn't move, so the DOM goes back to it. The radios share one
    // group across the cards: the click also unchecked the primary's radio in
    // another card, and Vue won't re-patch it, since its `checked` binding
    // never changed.
    for (const radio of document.querySelectorAll<HTMLInputElement>(
      'input[name="tracker-primary"]'
    )) {
      radio.checked = radio.value === primary.value;
    }
    choiceError.value = String(err);
  }
}

async function onMirrorToggle(enabled: boolean): Promise<void> {
  choiceError.value = '';
  discardedNote.value = 0;
  reconcileOffered.value = false;
  try {
    const result = await trackersStore.setMirror(props.trackerId, enabled);
    if (enabled) {
      if (result.applied) showSaved();
      reconcileOffered.value = result.offerReconcile === true;
      return;
    }
    // Off asks first, even with nothing queued.
    pendingDialog.value = {
      mode: 'mirror-off',
      count: result.pendingMirrorChanges ?? 0,
      nickname: null
    };
  } catch (err) {
    choiceError.value = String(err);
  }
}

async function onMirrorConfirm(): Promise<void> {
  pendingDialog.value = null;
  try {
    const result = await trackersStore.setMirror(props.trackerId, false, { confirm: true });
    showSaved();
    // What main removed at the confirm, never the dialog's count.
    discardedNote.value = result.discarded ?? 0;
  } catch (err) {
    choiceError.value = String(err);
  }
}

function reviewDifferences(): void {
  reconcileOffered.value = false;
  openReconcile.value?.(props.trackerId);
}

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
  | { mode: 'discard'; count: number; nickname: string | null; ownerId: string | null }
  | { mode: 'mirror-off'; count: number; nickname: null };
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
  const result = await window.api.trackerLogout(props.trackerId, opts);
  discardedNote.value = 0;
  reconcileOffered.value = false;
  await syncFacadeUser();
  connectFormRef.value?.reset();
  await loadParkedQueues();
  // Only a logout that resolved asks; a rejected one never gets here.
  const choice = result?.needsPrimaryChoice;
  if (choice) emit('needs-primary-choice', choice.candidates);
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
  if (!dialog || dialog.mode === 'mirror-off') return;
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
            <span v-if="expiringSoon" class="chip orange expiry-chip"
              ><span class="dot"></span>{{ expired ? 'Expired' : 'Expires' }} {{ expiryDate }}</span
            >
            <span v-if="showControls && isPrimary" class="chip neutral primary-badge">Primary</span>
          </div>
          <div v-if="sessionExpired" class="ci-meta">
            {{ label }} rejected the saved sign-in.
            <template v-if="queueLength > 0">
              {{ queueLength }} pending update{{ queueLength > 1 ? 's' : '' }} will sync after you
              reconnect.
            </template>
          </div>
          <div v-else-if="expiringSoon" class="ci-meta expiry-warning">
            Your {{ label }} sign-in {{ expired ? 'expired' : 'expires' }} on {{ expiryDate }}. Sign
            in again to keep syncing.
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
        <button
          v-else-if="expiringSoon"
          class="btn btn-sm btn-primary sign-in-again"
          :disabled="connectActive"
          @click="reconnect"
        >
          Sign in again
        </button>
        <button v-if="!sessionExpired" class="btn btn-sm btn-outline" @click="disconnect">
          Disconnect
        </button>
      </div>

      <!-- With no account the chip has no card to sit on, so it gets a row; the
         connect body below says what to set up. -->
      <SettingsRow v-if="!user && needsSetup" class="needs-setup-row">
        <span class="chip orange"><span class="dot"></span>Needs setup</span>
      </SettingsRow>

      <!-- Kept mounted (v-show): Reconnect starts the body's sign-in, and the
         body is shown once it has one in progress, or the reason it couldn't start.
         "Needs setup" shows it too: the setup to fix is the body's (MAL, #702).
         The second-tracker flag (#701) hides it for a tracker that isn't connected. -->
      <SettingsRow
        v-show="
          (!user && !connectBlocked) ||
          (user && needsSetup) ||
          ((sessionExpired || expiringSoon) && connectActive)
        "
        stack
      >
        <component :is="connectForm" ref="connectFormRef" :complete="complete" />
      </SettingsRow>
      <SettingsRow v-if="connectBlocked" class="second-tracker-row">
        <template #text>
          <div class="sr-desc">Connecting a second tracker isn't available yet.</div>
        </template>
      </SettingsRow>

      <!-- Primary and mirror controls (#701), with 2+ connected accounts only. -->
      <SettingsRow
        v-if="showControls && canBePrimary"
        class="primary-row"
        label="Primary tracker"
        desc="The source of truth for your lists, next episodes and auto-download."
      >
        <input
          type="radio"
          name="tracker-primary"
          :value="trackerId"
          :checked="isPrimary"
          :aria-label="`Make ${label} the primary tracker`"
          @change="choosePrimary"
        />
      </SettingsRow>
      <SettingsRow
        v-if="showControls && !isPrimary"
        class="mirror-row"
        label="Mirror changes to this tracker"
        :desc="`Changes you make in ${primaryLabel} are sent to ${label} too.`"
      >
        <SettingsSwitch :model-value="mirrorOn" @update:model-value="onMirrorToggle" />
      </SettingsRow>
      <SettingsRow v-if="discardedNote > 0" stack>
        <div class="inline-result mirror-discarded">
          {{ discardedNote }} change{{ discardedNote === 1 ? '' : 's' }} discarded
        </div>
      </SettingsRow>
      <SettingsRow
        v-if="showControls && reconcileOffered && openReconcile"
        class="reconcile-offer-row"
      >
        <template #text>
          <div class="sr-desc">Review differences with {{ primaryLabel }}?</div>
        </template>
        <button class="btn btn-sm btn-primary" data-action="review" @click="reviewDifferences">
          Review
        </button>
        <button
          class="btn btn-sm btn-outline"
          data-action="not-now"
          @click="reconcileOffered = false"
        >
          Not now
        </button>
      </SettingsRow>
      <SettingsRow v-if="choiceError" stack>
        <div class="inline-result bad choice-error">{{ choiceError }}</div>
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
      :primary-label="primaryLabel"
      @keep="onPendingKeep"
      @discard="onPendingDiscard"
      @confirm="onMirrorConfirm"
      @cancel="pendingDialog = null"
    />
  </div>
</template>

<style scoped src="@renderer/assets/settings-tabs.css"></style>
