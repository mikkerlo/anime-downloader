<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { storeToRefs } from 'pinia';
import ConflictRow from './ConflictRow.vue';
import { suggestedChoice } from './format';
import { useSyncStore } from '../../stores/sync';
import { LAYER } from '../overlay-layers';

// The review sheet (#585): the held conflicts grouped by title, then field.
// "Apply all suggested" takes each row's newest-`at` suggestion and leaves the
// rows without one; "Apply" applies the rows the user picked.
const sync = useSyncStore();

// Escape closes this sheet only: in the capture phase, and stopped, so a layer
// underneath (Prepare for offline's panel) never sees it.
function onKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return;
  e.stopImmediatePropagation();
  sync.closeReview();
}
onMounted(() => window.addEventListener('keydown', onKeydown, true));
onUnmounted(() => window.removeEventListener('keydown', onKeydown, true));
const { conflicts } = storeToRefs(sync);

const picked = ref<Record<string, SyncConflictChoice>>({});
const message = ref('');
const notes = ref<string[]>([]);
const busy = ref(false);

const groups = computed(() => {
  const out: { animeId: string; title: SyncConflictItem['title']; rows: SyncConflictItem[] }[] = [];
  for (const c of conflicts.value) {
    let g = out.find((x) => x.animeId === c.animeId);
    if (!g) out.push((g = { animeId: c.animeId, title: c.title, rows: [] }));
    g.rows.push(c);
  }
  for (const g of out) g.rows.sort((a, b) => a.fieldPath.localeCompare(b.fieldPath));
  return out;
});

const pickedCount = computed(
  () => Object.keys(picked.value).filter((id) => conflicts.value.some((c) => c.id === id)).length
);

const rowsNeedChoice = (n: number): string =>
  `${n} ${n === 1 ? 'row needs' : 'rows need'} a choice`;

async function apply(choices: Record<string, SyncConflictChoice>): Promise<void> {
  if (Object.keys(choices).length === 0) return;
  busy.value = true;
  try {
    const res = await sync.resolve(choices);
    for (const id of res.resolved) delete picked.value[id];
    notes.value = [...res.notes.map((n) => n.text), ...res.failed.map((f) => f.reason)];
  } catch (err) {
    notes.value = [String(err)];
  } finally {
    busy.value = false;
  }
}

async function applyAllSuggested(): Promise<void> {
  const choices: Record<string, SyncConflictChoice> = {};
  let left = 0;
  for (const c of conflicts.value) {
    const s = suggestedChoice(c);
    if (s) choices[c.id] = s;
    else left++;
  }
  message.value = left > 0 ? rowsNeedChoice(left) : '';
  await apply(choices);
}

async function applyPicked(): Promise<void> {
  const choices: Record<string, SyncConflictChoice> = {};
  for (const c of conflicts.value) if (picked.value[c.id]) choices[c.id] = picked.value[c.id];
  message.value = '';
  await apply(choices);
}
</script>

<template>
  <div
    class="sl-backdrop"
    data-testid="conflict-review-backdrop"
    :style="{ zIndex: LAYER.reviewSheet }"
    @click.self="sync.closeReview()"
  >
    <div class="sl-modal sheet" data-testid="conflict-review-sheet">
      <div class="sl-title" data-testid="review-title">
        Needs your input ({{ conflicts.length }})
      </div>
      <p class="sl-muted">
        Applied here, on each connected library and on Shikimori. You can change any of these later
        from the title page.
      </p>
      <p v-if="conflicts.length === 0" class="sl-text" data-testid="review-empty">
        Nothing needs your input.
      </p>
      <section
        v-for="g in groups"
        :key="g.animeId"
        class="title-group"
        data-testid="conflict-title"
      >
        <header class="title-head">
          <img v-if="g.title.poster" class="poster" :src="g.title.poster" alt="" />
          <span class="title-name">{{ g.title.name }}</span>
        </header>
        <ConflictRow
          v-for="row in g.rows"
          :key="row.id"
          :item="row"
          :selected="picked[row.id] ?? null"
          @select="picked[row.id] = $event"
        />
      </section>
      <p v-if="message" class="sl-warn" data-testid="review-message">{{ message }}</p>
      <p v-for="n in notes" :key="n" class="sl-muted" data-testid="review-note">{{ n }}</p>
      <div class="sl-actions">
        <button class="sl-btn" :disabled="busy" @click="sync.closeReview()">Close</button>
        <button
          class="sl-btn"
          data-testid="apply-suggested"
          :disabled="busy || conflicts.length === 0"
          @click="applyAllSuggested"
        >
          Apply all suggested
        </button>
        <button
          class="sl-btn primary"
          data-testid="apply-picked"
          :disabled="busy || pickedCount === 0"
          @click="applyPicked"
        >
          Apply
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped src="../shared-library/shared-library.css"></style>

<style scoped>
.sheet {
  width: 760px;
}

.title-group {
  display: flex;
  flex-direction: column;
}

.title-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 0 4px;
}

.poster {
  width: 32px;
  height: 46px;
  object-fit: cover;
  border-radius: 4px;
}

.title-name {
  font-weight: 700;
  color: var(--text);
}
</style>
