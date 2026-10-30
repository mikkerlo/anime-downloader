<script setup lang="ts">
import { computed, ref } from 'vue';

// The identity check's warnings (#578): a library someone else owns, and the
// no-account choice between videos only and a local claim. Any PC without a
// Shikimori account gets the choice, online or not.
const props = defineProps<{ candidate: SharedLibraryCandidate }>();
const emit = defineEmits<{ choose: [choice: SharedLibraryAttachChoice]; cancel: [] }>();

const confirming = ref(false);
const nickname = computed(() => props.candidate.ownerNickname || 'its owner');
</script>

<template>
  <div class="sl-backdrop" @click.self="emit('cancel')">
    <div class="sl-modal" data-testid="identity-warning">
      <template v-if="candidate.identity === 'foreign'">
        <div class="sl-title">This library belongs to {{ nickname }}</div>
        <p class="sl-text">
          You're logged in to Shikimori as someone else, so this PC uses it as videos only: its
          watch state is ignored, and the app never writes into it.
        </p>
        <p class="sl-text">
          To keep your own progress on this drive, create your own Shared Library next to it.
        </p>
        <div class="sl-actions">
          <button class="sl-btn" @click="emit('cancel')">Cancel</button>
          <button class="sl-btn primary" data-testid="use-videos" @click="emit('choose', 'videos')">
            Use as videos only
          </button>
        </div>
      </template>
      <template v-else-if="!confirming">
        <div class="sl-title">This library belongs to {{ nickname }}</div>
        <p class="sl-text">
          This PC has no Shikimori account. You can use the library as videos only, or use it as
          {{ nickname }}: this PC then syncs {{ nickname }}'s watch state with the drive, and what
          you watch here goes back to {{ nickname }}'s PC with it. It never sends anything to
          Shikimori.
        </p>
        <div class="sl-actions">
          <button class="sl-btn" @click="emit('cancel')">Cancel</button>
          <button class="sl-btn" data-testid="use-videos" @click="emit('choose', 'videos')">
            Use as videos only
          </button>
          <button class="sl-btn primary" data-testid="use-as-owner" @click="confirming = true">
            Use this library as {{ nickname }}
          </button>
        </div>
      </template>
      <template v-else>
        <div class="sl-title">Use this library as {{ nickname }}?</div>
        <p class="sl-text">Only do this if you are {{ nickname }}.</p>
        <div class="sl-actions">
          <button class="sl-btn" @click="confirming = false">Back</button>
          <button
            class="sl-btn primary"
            data-testid="confirm-claim"
            @click="emit('choose', 'claim')"
          >
            I am {{ nickname }}
          </button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped src="./shared-library.css"></style>
