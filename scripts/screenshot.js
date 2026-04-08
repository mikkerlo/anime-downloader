const { _electron: electron } = require('playwright');
const path = require('path');

(async () => {
  const appPath = path.join(__dirname, '..', 'out/main/index.js');
  
  console.log('Launching Electron app...');
  const app = await electron.launch({
    args: [appPath],
    env: {
      ...process.env,
      NODE_ENV: 'production',
    },
    timeout: 30000,
  });

  console.log('Waiting for first window...');
  const page = await app.firstWindow();
  
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(3000);

  console.log('Taking main view screenshot...');
  await page.screenshot({ path: '/tmp/app-screenshot.png' });
  console.log('Screenshot saved to /tmp/app-screenshot.png');

  // Open player with test data to verify quality selector
  console.log('Opening player with test data...');
  await page.evaluate(() => {
    if (window.__openTestPlayer) {
      window.__openTestPlayer(
        '',
        'https://example.com/stream1080.mp4',
        '',
        'Test Anime',
        '1',
        [
          { height: 1080, url: 'https://example.com/stream1080.mp4' },
          { height: 720, url: 'https://example.com/stream720.mp4' },
          { height: 480, url: 'https://example.com/stream480.mp4' }
        ],
        123,
        [
          { id: 123, label: 'AniLibria', type: 'voiceRu', height: 1080 },
          { id: 456, label: 'Studio Band', type: 'voiceRu', height: 720 },
          { id: 789, label: 'HorribleSubs', type: 'subEn', height: 1080 },
          { id: 101, label: 'Субтитры', type: 'subRu', height: 1080 }
        ]
      );
    }
  });
  await page.waitForTimeout(2000);
  await page.mouse.move(500, 400);
  await page.waitForTimeout(500);

  console.log('Taking player screenshot...');
  await page.screenshot({ path: '/tmp/app-player.png' });
  console.log('Player screenshot saved to /tmp/app-player.png');

  await app.close();
})().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
