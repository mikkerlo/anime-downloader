<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue';
import { storeToRefs } from 'pinia';
import { SHIKIMORI_ORIGIN } from '@shared/shikimori';
import { useLibraryStore } from '../../stores/library';
import { useShikimoriStore } from '../../stores/shikimori';

const libraryStore = useLibraryStore();
const shikimoriStore = useShikimoriStore();
const { friends } = storeToRefs(shikimoriStore);

type Tab = 'all' | 'online' | 'activity';
const tab = ref<Tab>('all');
const tabs: { id: Tab; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'online', label: 'Online' },
  { id: 'activity', label: 'Activity' }
];

const loadingFriends = ref(false);
const loadingActivity = ref(false);
const error = ref('');

const activities = ref<ShikiFriendActivityEntry[]>([]);
let activityLoadedAt = 0;
const ACTIVITY_CACHE_MS = 5 * 60 * 1000;

const onlineCount = computed(() => friends.value.filter((f) => f.online).length);
const displayedFriends = computed(() =>
  tab.value === 'online' ? friends.value.filter((f) => f.online) : friends.value
);

function avatarBg(seed: string): string {
  let hue = 0;
  for (let i = 0; i < seed.length; i++) hue = (hue * 31 + seed.charCodeAt(i)) % 360;
  return `linear-gradient(135deg, hsl(${hue} 55% 48%), hsl(${(hue + 48) % 360} 52% 40%))`;
}

function initial(name: string): string {
  return name.charAt(0).toUpperCase() || '?';
}

function watchLabel(status: ShikiUserRateStatus): string {
  if (status === 'rewatching') return 'Rewatching';
  if (status === 'completed') return 'Last completed';
  return 'Watching';
}

function formatRelative(iso: string | null): string {
  if (!iso) return 'offline';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'offline';
  const sec = Math.floor(Math.max(0, Date.now() - then) / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(day / 365)}y ago`;
}

function stripHtml(html: string): string {
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  return (tmp.textContent || tmp.innerText || '').trim();
}

async function loadFriends(): Promise<void> {
  if (!shikimoriStore.loggedIn) {
    await shikimoriStore.refreshUser();
    if (!shikimoriStore.loggedIn) return;
  }
  loadingFriends.value = true;
  error.value = '';
  try {
    await shikimoriStore.refreshFriends();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to load friends';
  } finally {
    loadingFriends.value = false;
  }
}

async function loadActivity(force = false): Promise<void> {
  if (!force && activities.value.length > 0 && Date.now() - activityLoadedAt < ACTIVITY_CACHE_MS) {
    return;
  }
  if (!shikimoriStore.loggedIn) return;
  loadingActivity.value = true;
  try {
    activities.value = await window.api.shikimoriGetFriendsActivity();
    activityLoadedAt = Date.now();
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to load friends activity';
  } finally {
    loadingActivity.value = false;
  }
}

async function refresh(): Promise<void> {
  await loadFriends();
  if (tab.value === 'activity') await loadActivity(true);
}

function openWatching(card: ShikiFriendCard): void {
  const w = card.watching;
  if (!w) return;
  if (w.animeId != null) {
    libraryStore.openAnime(w.animeId, String(w.episode || ''));
  } else {
    void window.api.shellOpenExternal(`${SHIKIMORI_ORIGIN}/animes/${w.malId}`);
  }
}

function openActivity(entry: ShikiFriendActivityEntry): void {
  if (entry.smotretAnime) libraryStore.openAnime(entry.smotretAnime.id);
}

function openExternal(url: string): void {
  void window.api.shellOpenExternal(url);
}

// Lazily load the activity feed the first time the Activity tab is opened.
watch(tab, (t) => {
  if (t === 'activity') void loadActivity();
});

onMounted(() => loadFriends());
</script>

<template>
  <main class="friends-view">
    <header class="topbar">
      <h2>Friends</h2>
      <span class="sub">· {{ friends.length }} on Shikimori</span>
      <span class="topbar-spacer"></span>
      <span v-if="onlineCount > 0" class="chip green"
        ><span class="dot"></span>{{ onlineCount }} online</span
      >
      <button class="hdr-btn outline" :disabled="loadingFriends" @click="refresh">
        <svg
          :class="{ spinning: loadingFriends }"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182M20.015 4.356v4.992"
          />
        </svg>
        Sync now
      </button>
    </header>

    <div class="body">
      <div v-if="!shikimoriStore.loggedIn && !loadingFriends" class="empty-state">
        <div class="es-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z"
            />
          </svg>
        </div>
        <p>Connect your Shikimori account in Settings to see your friends.</p>
        <button class="cta-btn" @click="libraryStore.navigate('settings')">Open Settings</button>
      </div>

      <template v-else>
        <div class="pill-tabs">
          <button
            v-for="t in tabs"
            :key="t.id"
            class="pill-tab"
            :class="{ active: tab === t.id }"
            @click="tab = t.id"
          >
            {{ t.label }}
          </button>
        </div>

        <!-- Friend grid (All / Online) -->
        <template v-if="tab !== 'activity'">
          <div v-if="loadingFriends && friends.length === 0" class="status-text">
            Loading friends…
          </div>
          <div v-else-if="displayedFriends.length === 0" class="status-text">
            {{ tab === 'online' ? 'No friends online right now.' : 'No Shikimori friends yet.' }}
          </div>
          <div v-else class="friend-grid">
            <div v-for="f in displayedFriends" :key="f.id" class="friend-card">
              <div class="fc-head">
                <div class="fc-av" :style="{ background: avatarBg(f.nickname) }">
                  {{ initial(f.nickname) }}
                  <span class="fc-dot" :class="{ on: f.online }"></span>
                </div>
                <div class="fc-id">
                  <div class="fc-name">{{ f.nickname }}</div>
                  <div class="fc-handle">@{{ f.nickname }}</div>
                </div>
                <span class="fc-pres" :class="f.online ? 'on' : 'off'">{{
                  f.online ? 'Online' : formatRelative(f.lastOnlineAt)
                }}</span>
              </div>

              <button v-if="f.watching" class="fc-watching" @click="openWatching(f)">
                <div class="fc-poster">
                  <img :src="f.watching.image" :alt="f.watching.title" loading="lazy" />
                </div>
                <div class="fc-w-body">
                  <div class="fc-w-label">{{ watchLabel(f.watching.status) }}</div>
                  <div class="fc-w-title">{{ f.watching.title }}</div>
                  <div class="fc-w-ep mono">
                    EP {{ f.watching.episode
                    }}{{ f.watching.total ? ` / ${f.watching.total}` : '' }}
                  </div>
                </div>
              </button>

              <div class="fc-stats">
                <div class="fc-stat">
                  <span class="v mono">{{ f.mutual }}</span
                  ><span class="l">Mutual</span>
                </div>
                <div class="fc-stat">
                  <span class="v mono">{{ f.titles }}</span
                  ><span class="l">Titles</span>
                </div>
                <div class="fc-stat">
                  <span class="v mono">{{ f.mean.toFixed(1) }}</span
                  ><span class="l">Mean</span>
                </div>
              </div>

              <div class="fc-actions">
                <button
                  class="hdr-btn ghost sm"
                  @click="openExternal(`${SHIKIMORI_ORIGIN}/@${f.nickname}/list/anime`)"
                >
                  Compare
                </button>
                <button
                  class="hdr-btn ghost sm"
                  @click="openExternal(`${SHIKIMORI_ORIGIN}/@${f.nickname}`)"
                >
                  Message
                </button>
              </div>
            </div>
          </div>
        </template>

        <!-- Activity feed -->
        <template v-else>
          <div v-if="loadingActivity && activities.length === 0" class="status-text">
            Loading activity…
          </div>
          <div v-else-if="activities.length === 0" class="status-text">
            No recent activity from your Shikimori friends.
          </div>
          <div v-else class="feed">
            <div
              v-for="(entry, idx) in activities"
              :key="entry.friendId + '-' + entry.createdAt + '-' + idx"
              class="feed-row"
            >
              <div class="feed-av" :style="{ background: avatarBg(entry.friendNickname) }">
                {{ initial(entry.friendNickname) }}
              </div>
              <div class="feed-body">
                <div class="feed-text">
                  <strong>{{ entry.friendNickname }}</strong>
                  <button v-if="entry.smotretAnime" class="feed-link" @click="openActivity(entry)">
                    {{ entry.animeName }}
                  </button>
                  <span v-else class="feed-link-static">{{ entry.animeName }}</span>
                </div>
                <div class="feed-detail">{{ stripHtml(entry.description) }}</div>
              </div>
              <button
                v-if="entry.smotretAnime"
                class="feed-poster"
                :title="entry.animeName"
                @click="openActivity(entry)"
              >
                <img
                  :src="entry.smotretAnime.posterUrlSmall || entry.animeImage"
                  :alt="entry.animeName"
                  loading="lazy"
                />
              </button>
              <span class="feed-when mono">{{ formatRelative(entry.createdAt) }}</span>
            </div>
          </div>
        </template>
      </template>
    </div>
  </main>
</template>

<style scoped>
.friends-view {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-width: 0;
}

.topbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 var(--pad-x);
  height: 64px;
  flex-shrink: 0;
  border-bottom: 1px solid var(--border);
  background: color-mix(in srgb, var(--bg) 86%, transparent);
  backdrop-filter: blur(8px);
}

.topbar h2 {
  font-family: var(--font-display);
  font-size: 1.32rem;
  font-weight: 700;
  letter-spacing: -0.015em;
}

.topbar .sub {
  color: var(--text-3);
  font-size: 0.85rem;
  margin-left: -6px;
}

.topbar-spacer {
  flex: 1;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 0.7rem;
  font-weight: 700;
  padding: 3px 9px;
  border-radius: var(--radius-chip);
  letter-spacing: 0.03em;
}

.chip .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}

.chip.green {
  background: color-mix(in srgb, var(--st-green) 16%, transparent);
  color: var(--st-green);
}

.hdr-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 9px 15px;
  border-radius: var(--radius-btn);
  font-size: 0.84rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s var(--ease);
}

.hdr-btn svg {
  width: 15px;
  height: 15px;
}

.hdr-btn.outline {
  background: var(--surface-2);
  border: 1px solid var(--border);
  color: var(--text-2);
}

.hdr-btn.outline:hover:not(:disabled) {
  background: var(--surface-3);
  color: var(--text);
}

.hdr-btn.ghost {
  background: none;
  border: 1px solid transparent;
  color: var(--text-3);
}

.hdr-btn.ghost:hover {
  background: var(--surface-2);
  color: var(--text);
}

.hdr-btn.sm {
  padding: 7px 12px;
  font-size: 0.8rem;
}

.hdr-btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.spinning {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.body {
  flex: 1;
  overflow-y: auto;
  padding: var(--pad-y) var(--pad-x) 48px;
}

.pill-tabs {
  display: inline-flex;
  gap: 4px;
  padding: 4px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-btn);
  margin-bottom: 22px;
}

.pill-tab {
  padding: 6px 14px;
  border-radius: calc(var(--radius-btn) - 2px);
  background: none;
  border: none;
  color: var(--text-3);
  font-size: 0.82rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s;
}

.pill-tab:hover {
  color: var(--text);
}

.pill-tab.active {
  background: var(--surface-3);
  color: var(--text);
}

/* ---- friend grid ---- */
.friend-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(312px, 1fr));
  gap: var(--gap);
}

.friend-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  padding: 16px;
  transition:
    border-color 0.15s,
    transform 0.15s var(--ease);
}

.friend-card:hover {
  border-color: var(--border-strong);
}

.fc-head {
  display: flex;
  align-items: center;
  gap: 12px;
}

.fc-av {
  position: relative;
  width: 46px;
  height: 46px;
  min-width: 46px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  color: #fff;
  font-weight: 700;
  font-size: 1.05rem;
}

.fc-dot {
  position: absolute;
  bottom: 0;
  right: 0;
  width: 13px;
  height: 13px;
  border-radius: 50%;
  background: var(--text-faint);
  border: 2.5px solid var(--surface);
}

.fc-dot.on {
  background: var(--st-green);
}

.fc-id {
  flex: 1;
  min-width: 0;
}

.fc-name {
  font-size: 0.98rem;
  font-weight: 700;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.fc-handle {
  font-family: var(--font-data);
  font-size: 0.76rem;
  color: var(--text-3);
  margin-top: 1px;
}

.fc-pres {
  font-size: 0.72rem;
  font-weight: 600;
  flex-shrink: 0;
}

.fc-pres.on {
  color: var(--st-green);
}

.fc-pres.off {
  color: var(--text-faint);
  font-family: var(--font-data);
}

.fc-watching {
  display: flex;
  gap: 12px;
  align-items: center;
  width: 100%;
  text-align: left;
  margin-top: 15px;
  padding: 10px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-btn);
  cursor: pointer;
  transition: border-color 0.15s;
}

.fc-watching:hover {
  border-color: var(--accent);
}

.fc-poster {
  width: 38px;
  min-width: 38px;
  aspect-ratio: 2/3;
  border-radius: 5px;
  overflow: hidden;
  background: var(--bg-deep);
}

.fc-poster img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.fc-w-body {
  flex: 1;
  min-width: 0;
}

.fc-w-label {
  font-size: 0.62rem;
  font-weight: 700;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  color: var(--text-faint);
}

.fc-w-title {
  font-size: 0.86rem;
  font-weight: 600;
  color: var(--text);
  margin-top: 3px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.fc-w-ep {
  font-size: 0.72rem;
  color: var(--text-3);
  margin-top: 3px;
}

.fc-stats {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
  margin-top: 14px;
}

.fc-stat {
  text-align: center;
}

.fc-stat .v {
  font-size: 1.05rem;
  font-weight: 700;
  color: var(--text);
  display: block;
}

.fc-stat .l {
  font-size: 0.64rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-faint);
  margin-top: 3px;
  display: block;
}

.fc-actions {
  display: flex;
  gap: 8px;
  margin-top: 15px;
}

.fc-actions .hdr-btn {
  flex: 1;
  justify-content: center;
  border: 1px solid var(--border);
}

/* ---- activity feed ---- */
.feed {
  display: flex;
  flex-direction: column;
  max-width: 720px;
}

.feed-row {
  display: flex;
  align-items: center;
  gap: 13px;
  padding: 13px 4px;
  border-top: 1px solid var(--border-soft);
}

.feed-row:first-child {
  border-top: none;
}

.feed-av {
  width: 38px;
  height: 38px;
  min-width: 38px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  color: #fff;
  font-weight: 700;
  font-size: 0.86rem;
}

.feed-body {
  flex: 1;
  min-width: 0;
}

.feed-text {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 0.88rem;
  color: var(--text-2);
}

.feed-text strong {
  color: var(--text);
  font-weight: 700;
}

.feed-link {
  background: none;
  border: none;
  padding: 0;
  color: var(--accent);
  font-weight: 600;
  font-size: 0.88rem;
  font-family: inherit;
  cursor: pointer;
}

.feed-link:hover {
  text-decoration: underline;
}

.feed-link-static {
  color: var(--text-3);
  font-size: 0.88rem;
}

.feed-detail {
  font-family: var(--font-data);
  font-size: 0.76rem;
  color: var(--text-3);
  margin-top: 4px;
}

.feed-poster {
  width: 32px;
  min-width: 32px;
  aspect-ratio: 2/3;
  border-radius: 5px;
  overflow: hidden;
  border: none;
  padding: 0;
  cursor: pointer;
  background: var(--bg-deep);
}

.feed-poster img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.feed-when {
  font-size: 0.72rem;
  color: var(--text-faint);
  flex-shrink: 0;
  width: 64px;
  text-align: right;
}

.status-text {
  text-align: center;
  color: var(--text-faint);
  font-size: 1rem;
  padding: 60px 20px;
}

.cta-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  background: var(--accent);
  color: var(--accent-ink);
  border: none;
  padding: 9px 16px;
  border-radius: var(--radius-btn);
  font-size: 0.86rem;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s;
}

.cta-btn:hover {
  background: var(--accent-hover);
}
</style>
