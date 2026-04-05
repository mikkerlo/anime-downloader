<script setup lang="ts">
import { getAnimeName } from '../utils'

defineProps<{
  anime: AnimeSearchResult
  starred: boolean
}>()

const emit = defineEmits<{
  toggleStar: [anime: AnimeSearchResult]
}>()
</script>

<template>
  <div class="card">
    <div class="poster-wrap">
      <img :src="anime.posterUrlSmall" :alt="anime.title" class="poster" loading="lazy" />
      <button class="star-btn" :class="{ active: starred }" @click.stop="emit('toggleStar', anime)">
        <svg viewBox="0 0 24 24" :fill="starred ? 'currentColor' : 'none'" stroke="currentColor" stroke-width="1.5" width="20" height="20">
          <path stroke-linecap="round" stroke-linejoin="round" d="M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.563.563 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.563.563 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z" />
        </svg>
      </button>
    </div>
    <div class="info">
      <div class="title" :title="anime.title">{{ getAnimeName(anime) }}</div>
      <div class="meta">
        <span v-if="anime.typeTitle">{{ anime.typeTitle }}</span>
        <span v-if="anime.year"> · {{ anime.year }}</span>
        <span v-if="anime.numberOfEpisodes"> · {{ anime.numberOfEpisodes }} ep</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.card {
  background-color: #16213e;
  border-radius: 10px;
  overflow: hidden;
  transition: transform 0.15s, box-shadow 0.15s;
  cursor: pointer;
}

.card:hover {
  transform: translateY(-4px);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
}

.poster-wrap {
  position: relative;
  aspect-ratio: 2 / 3;
  overflow: hidden;
  background-color: #0f3460;
}

.poster {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.star-btn {
  position: absolute;
  top: 8px;
  right: 8px;
  background: rgba(0, 0, 0, 0.6);
  border: none;
  border-radius: 50%;
  width: 34px;
  height: 34px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  color: rgba(255, 255, 255, 0.7);
  transition: color 0.15s, transform 0.15s;
}

.star-btn:hover {
  color: #fbbf24;
  transform: scale(1.1);
}

.star-btn.active {
  color: #fbbf24;
}

.info {
  padding: 10px 12px 12px;
}

.title {
  font-size: 0.85rem;
  font-weight: 600;
  color: #e0e0e0;
  line-height: 1.3;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.meta {
  margin-top: 4px;
  font-size: 0.75rem;
  color: #6a6a8a;
}
</style>
