<script setup lang="ts">
import { computed } from 'vue';
import { ffmpegMissingText } from '../../stores/shared-libraries';
import { usePrepareOfflineStore } from '../../stores/prepare-offline';

const props = defineProps<{ mkvCount: number }>();
const LINK = 'Prepare for offline';
const text = computed(() => ffmpegMissingText(props.mkvCount));
// The text ends "…or use Prepare for offline."; those words open the panel (#592).
const parts = computed(() => {
  const at = text.value.lastIndexOf(LINK);
  return at < 0
    ? { before: text.value, link: '', after: '' }
    : { before: text.value.slice(0, at), link: LINK, after: text.value.slice(at + LINK.length) };
});
const prepareOffline = usePrepareOfflineStore();
</script>

<template>
  <div class="sl-warn" data-testid="ffmpeg-missing-banner" role="status">
    {{ parts.before
    }}<a
      v-if="parts.link"
      href="#"
      data-testid="ffmpeg-missing-prepare"
      @click.prevent="prepareOffline.openPanel()"
      >{{ parts.link }}</a
    >{{ parts.after }}
  </div>
</template>

<style scoped src="./shared-library.css"></style>
