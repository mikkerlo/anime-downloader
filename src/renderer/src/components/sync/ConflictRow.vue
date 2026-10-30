<script setup lang="ts">
import { computed } from 'vue';
import {
  choiceKey,
  choiceLabel,
  conflictValue,
  fieldName,
  partyLabel,
  suggestedChoice
} from './format';

// One held conflict (#585): Before / This PC / Shared Library / Shikimori, a
// column greyed when that party wasn't involved, and the row's choices.
const props = defineProps<{ item: SyncConflictItem; selected: SyncConflictChoice | null }>();
const emit = defineEmits<{ select: [choice: SyncConflictChoice] }>();

const fmt = (v: unknown): string =>
  conflictValue(props.item.fieldPath, v, props.item.title.episodes);

// Before: each leg's base; both, labelled, when they differ.
const before = computed(() => {
  const entries = Object.entries(props.item.bases).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return [{ label: '', value: '—' }];
  const distinct = new Set(entries.map(([, v]) => JSON.stringify(v)));
  if (distinct.size === 1) return [{ label: '', value: fmt(entries[0][1]) }];
  return entries.map(([party, v]) => ({ label: partyLabel(party, props.item), value: fmt(v) }));
});

const libraryCells = computed(() => {
  const involved = props.item.libraries.filter((l) => l.involved);
  if (involved.length > 0) {
    return involved.map((l) => ({
      key: l.libraryId,
      label: involved.length > 1 ? l.name : '',
      value: fmt(props.item.parties[`library:${l.libraryId}`])
    }));
  }
  return [];
});
const libraryAgrees = computed(
  () => libraryCells.value.length === 0 && props.item.libraries.length > 0
);
const shikimoriInvolved = computed(() => 'shikimori' in props.item.parties);
const suggestion = computed(() => suggestedChoice(props.item));
const isSelected = (c: SyncConflictChoice): boolean =>
  !!props.selected && choiceKey(props.selected) === choiceKey(c);
</script>

<template>
  <div class="conflict-row" data-testid="conflict-row" :data-field="item.fieldPath">
    <div class="field-name">{{ fieldName(item.fieldPath) }}</div>
    <div class="cols">
      <div class="col" data-testid="col-before" data-involved="true">
        <span class="col-head">Before</span>
        <span v-for="b in before" :key="b.label" class="col-value"
          ><span v-if="b.label" class="col-label">{{ b.label }}: </span>{{ b.value }}</span
        >
      </div>
      <div
        class="col"
        :class="{ uninvolved: !('local' in item.parties) }"
        data-testid="col-local"
        :data-involved="'local' in item.parties"
      >
        <span class="col-head">This PC</span>
        <span class="col-value">{{ fmt(item.parties.local) }}</span>
      </div>
      <div
        class="col"
        :class="{ uninvolved: libraryCells.length === 0 }"
        data-testid="col-library"
        :data-involved="libraryCells.length > 0"
      >
        <span class="col-head">Shared Library</span>
        <template v-if="libraryCells.length > 0">
          <span v-for="c in libraryCells" :key="c.key" class="col-value"
            ><span v-if="c.label" class="col-label">{{ c.label }}: </span>{{ c.value }}</span
          >
        </template>
        <span v-else-if="libraryAgrees" class="col-value" title="The same as This PC">{{
          fmt(item.parties.local)
        }}</span>
        <span v-else class="col-value">—</span>
      </div>
      <div
        class="col"
        :class="{ uninvolved: !shikimoriInvolved }"
        data-testid="col-shikimori"
        :data-involved="shikimoriInvolved"
      >
        <span class="col-head">Shikimori</span>
        <span class="col-value">{{ shikimoriInvolved ? fmt(item.parties.shikimori) : '—' }}</span>
      </div>
    </div>
    <p v-if="item.rewatchQuestion" class="question" data-testid="rewatch-question">
      Was this one rewatch or two?
    </p>
    <div class="choices" role="radiogroup">
      <label
        v-for="o in item.options"
        :key="choiceKey(o.choice)"
        class="choice"
        :class="{ on: isSelected(o.choice) }"
        data-testid="conflict-choice"
        :data-choice="choiceKey(o.choice)"
      >
        <input
          type="radio"
          :name="`choice-${item.id}`"
          :checked="isSelected(o.choice)"
          @change="emit('select', o.choice)"
        />
        <span>{{ choiceLabel(o.choice, item) }} · {{ fmt(o.value) }}</span>
        <span
          v-if="suggestion && choiceKey(suggestion) === choiceKey(o.choice)"
          class="newest"
          data-testid="suggested"
          >newest</span
        >
      </label>
    </div>
  </div>
</template>

<style scoped>
.conflict-row {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 0;
  border-top: 1px solid var(--border);
}

.field-name {
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--text);
}

.cols {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
}

.col {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 0.82rem;
  color: var(--text-2);
}

.col.uninvolved {
  opacity: 0.4;
}

.col-head {
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-3);
}

.col-label {
  color: var(--text-3);
}

.question {
  font-size: 0.85rem;
  color: var(--text);
}

.choices {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.choice {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-btn);
  font-size: 0.8rem;
  color: var(--text-2);
  cursor: pointer;
}

.choice.on {
  border-color: var(--accent);
  color: var(--text);
}

.choice input {
  margin: 0;
}

.newest {
  font-size: 0.68rem;
  font-weight: 700;
  color: var(--accent);
}
</style>
