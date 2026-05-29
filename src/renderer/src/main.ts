import { createApp } from 'vue'
import { createPinia } from 'pinia'

// Bundled fonts (self-hosted via @fontsource — no CDN, render offline).
// Manrope drives UI + display; JetBrains Mono drives data (speeds/sizes/ETAs).
// The per-weight CSS ships every subset, including Cyrillic for Russian titles.
import '@fontsource/manrope/400.css'
import '@fontsource/manrope/500.css'
import '@fontsource/manrope/600.css'
import '@fontsource/manrope/700.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import '@fontsource/jetbrains-mono/700.css'

import './assets/theme.css'
import App from './App.vue'

createApp(App).use(createPinia()).mount('#app')
