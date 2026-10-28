<script setup lang="ts">
import { computed } from 'vue';
import { ffmpegMissingText } from '../../stores/shared-libraries';

const props = defineProps<{ mkvCount: number }>();
const text = computed(() => ffmpegMissingText(props.mkvCount));
</script>

<template>
  <div class="sl-warn" data-testid="ffmpeg-missing-banner" role="status">{{ text }}</div>
</template>

<style scoped src="./shared-library.css"></style>
