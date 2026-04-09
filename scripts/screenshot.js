const { _electron: electron } = require('playwright');
const path = require('path');
const fs = require('fs');

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
          { id: 457, label: 'AniDUB', type: 'voiceRu', height: 1080 },
          { id: 789, label: 'HorribleSubs', type: 'subEn', height: 1080 },
          { id: 790, label: 'Erai-raws', type: 'subEn', height: 720 },
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

  // Close the streaming player
  await page.evaluate(() => {
    const closeBtn = document.querySelector('.close-btn');
    if (closeBtn) closeBtn.click();
  });
  await page.waitForTimeout(500);

  // Create a proper H.264 MKV test file for remux testing
  const { execSync } = require('child_process');
  const mkvTestFile = '/tmp/test-h264.mkv';
  if (!fs.existsSync(mkvTestFile)) {
    try {
      execSync('ffmpeg -f lavfi -i testsrc=duration=5:size=854x480:rate=24 -f lavfi -i sine=frequency=440:duration=5 -c:v libx264 -preset ultrafast -c:a aac /tmp/test-h264.mkv', { stdio: 'pipe' });
    } catch { /* may already exist */ }
  }

  if (fs.existsSync(mkvTestFile)) {
    // First: simulate the remux loading state using a fake path
    console.log('Simulating remux loading state...');
    await page.evaluate(() => {
      if (window.__openTestPlayer) {
        window.__openTestPlayer(
          '/fake/nonexistent/long-video.mkv',
          '',
          '',
          'Steins;Gate',
          '12',
          [],
          0,
          []
        );
      }
    });
    await page.waitForTimeout(200);
    console.log('Taking remux spinner screenshot...');
    await page.screenshot({ path: '/tmp/app-mkv-spinner.png' });
    console.log('Remux spinner screenshot saved to /tmp/app-mkv-spinner.png');

    // Wait for error and close
    await page.waitForTimeout(2000);
    await page.evaluate(() => {
      const closeBtn = document.querySelector('.close-btn');
      if (closeBtn) closeBtn.click();
    });
    await page.waitForTimeout(500);

    // Now test actual MKV playback with proper H.264 file
    console.log('Opening player with H.264 MKV test file...');
    await page.evaluate((mkvPath) => {
      if (window.__openTestPlayer) {
        window.__openTestPlayer(
          mkvPath,
          '',
          '',
          'MKV Test Anime',
          '1',
          [],
          0,
          []
        );
      }
    }, mkvTestFile);

    // Wait for remux to complete and video to load
    console.log('Waiting for remux + video load...');
    await page.waitForTimeout(8000);
    await page.mouse.move(500, 400);
    await page.waitForTimeout(500);

    console.log('Taking MKV playback screenshot...');
    await page.screenshot({ path: '/tmp/app-mkv-playing.png' });
    console.log('MKV playback screenshot saved to /tmp/app-mkv-playing.png');
  } else {
    console.log('Could not create MKV test file, skipping MKV screenshots');
  }

  await app.close();
})().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
