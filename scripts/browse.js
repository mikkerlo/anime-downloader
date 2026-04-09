const { _electron: electron } = require('playwright');
const path = require('path');

const TOKEN = process.env.SA_TOKEN;

(async () => {
  const appPath = path.join(__dirname, '..', 'out/main/index.js');

  console.log('Launching Electron app...');
  const app = await electron.launch({
    args: [appPath],
    env: { ...process.env, NODE_ENV: 'production' },
    timeout: 30000,
  });

  const page = await app.firstWindow();

  page.on('console', msg => {
    console.log(`[CONSOLE ${msg.type()}] ${msg.text()}`);
  });
  page.on('pageerror', err => {
    console.log(`[PAGE ERROR] ${err.message}`);
  });

  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(3000);

  // Setup token
  await page.click('button:has-text("Settings")');
  await page.waitForTimeout(1000);
  await page.click('text=Connectors');
  await page.waitForTimeout(1000);
  await page.fill('#token-input', TOKEN);
  await page.waitForTimeout(500);
  await page.click('text=Connectors');
  await page.waitForTimeout(2000);

  // Set built-in player
  await page.click('text=Player');
  await page.waitForTimeout(1000);
  const builtinRadio = await page.$('input[value="builtin"]');
  if (builtinRadio) await builtinRadio.click();
  await page.waitForTimeout(1000);

  // Search
  await page.click('button:has-text("Search")');
  await page.waitForTimeout(1000);
  await page.fill('.search-input', 'Dead mount death play');
  await page.click('.search-btn');
  await page.waitForTimeout(5000);

  // Open first result
  const firstCard = await page.$('.results-grid .card');
  if (firstCard) {
    await firstCard.click();
    await page.waitForTimeout(3000);

    const playBtn = await page.$('.link-btn.play');
    if (playBtn) {
      console.log('Clicking play...');
      await playBtn.click();
      await page.waitForTimeout(15000);

      await page.screenshot({ path: '/tmp/app-playing.png' });

      const state = await page.evaluate(() => {
        const video = document.querySelector('video');
        const libassCanvas = document.querySelector('.libassjs-canvas');
        const libassParent = document.querySelector('.libassjs-canvas-parent');
        return {
          hasPlayer: !!document.querySelector('.player-overlay'),
          hasVideo: !!video,
          videoReady: video?.readyState || 0,
          hasLibassCanvas: !!libassCanvas,
          hasLibassParent: !!libassParent,
          canvasSize: libassCanvas ? `${libassCanvas.width}x${libassCanvas.height}` : 'n/a',
        };
      });
      console.log('Player state:', JSON.stringify(state, null, 2));
    }
  }

  await app.close();
})().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
