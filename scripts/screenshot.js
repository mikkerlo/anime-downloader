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
      execSync('ffmpeg -f lavfi -i testsrc=duration=20:size=854x480:rate=24 -f lavfi -i sine=frequency=440:duration=20 -c:v libx264 -preset ultrafast -c:a aac /tmp/test-h264.mkv', { stdio: 'pipe' });
    } catch { /* may already exist */ }
  }

  // Prepare ASS test subtitle file
  const assTestFile = '/tmp/test-subs.ass';
  if (!fs.existsSync(assTestFile)) {
    fs.writeFileSync(assTestFile, [
      '[Script Info]',
      'Title: Test ASS Subtitles',
      'ScriptType: v4.00+',
      'PlayResX: 854',
      'PlayResY: 480',
      'ScaledBorderAndShadow: yes',
      '',
      '[V4+ Styles]',
      'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
      'Style: Default,Arial,36,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,2,1,2,20,20,30,1',
      'Style: Top,Arial,28,&H0000FFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,2,1,8,20,20,20,1',
      'Style: Styled,Arial,32,&H0000FF00,&H000000FF,&H00000000,&H80000000,0,-1,0,0,100,100,0,0,1,2,1,2,20,20,30,1',
      '',
      '[Events]',
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
      'Dialogue: 0,0:00:00.50,0:00:04.00,Default,,0,0,0,,{\\b1}ASS Subtitle Rendering{\\b0} with full styling',
      'Dialogue: 0,0:00:04.00,0:00:08.00,Top,,0,0,0,,Top-positioned subtitle with {\\c&H0000FF&}color{\\c}',
      'Dialogue: 0,0:00:04.00,0:00:08.00,Default,,0,0,0,,Bottom subtitle {\\c&HFF0000&}simultaneously{\\c}',
      'Dialogue: 0,0:00:08.00,0:00:12.00,Styled,,0,0,0,,{\\fad(500,500)}Italic green with fade effect',
      'Dialogue: 0,0:00:12.00,0:00:16.00,Default,,0,0,0,,{\\i1}Italic{\\i0}, {\\b1}Bold{\\b0}, {\\c&H0000FF&}Blue{\\c}',
      'Dialogue: 0,0:00:16.00,0:00:20.00,Default,,0,0,0,,{\\bord4\\3c&H0000FF&\\shad2}Custom border + shadow',
    ].join('\n'));
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

    // Close MKV player
    await page.evaluate(() => {
      const closeBtn = document.querySelector('.close-btn');
      if (closeBtn) closeBtn.click();
    });
    await page.waitForTimeout(1000);

    // Test ASS subtitle rendering with JASSUB
    console.log('Opening player with ASS subtitles...');
    const assContent = fs.readFileSync(assTestFile, 'utf-8');
    await page.evaluate(({ mkvPath, subs }) => {
      if (window.__openTestPlayer) {
        window.__openTestPlayer(
          mkvPath,
          '',
          subs,
          'Styled Subtitles Test',
          '1',
          [],
          0,
          []
        );
      }
    }, { mkvPath: mkvTestFile, subs: assContent });

    // Wait for remux + JASSUB init + seek to subtitle
    console.log('Waiting for remux + subtitle rendering...');
    await page.waitForTimeout(10000);
    // Seek to 1s to see the first subtitle
    await page.evaluate(() => {
      const video = document.querySelector('video');
      if (video) video.currentTime = 1.5;
    });
    await page.waitForTimeout(2000);
    await page.mouse.move(500, 400);
    await page.waitForTimeout(500);

    console.log('Taking ASS subtitle screenshot...');
    await page.screenshot({ path: '/tmp/app-ass-subs.png' });
    console.log('ASS subtitle screenshot saved to /tmp/app-ass-subs.png');

    // Seek to 5s for dual subtitle test
    await page.evaluate(() => {
      const video = document.querySelector('video');
      if (video) video.currentTime = 5;
    });
    await page.waitForTimeout(2000);
    await page.mouse.move(500, 400);
    await page.waitForTimeout(500);

    console.log('Taking dual ASS subtitle screenshot...');
    await page.screenshot({ path: '/tmp/app-ass-dual.png' });
    console.log('Dual ASS subtitle screenshot saved to /tmp/app-ass-dual.png');

    // Seek to 13s for styled text test
    await page.evaluate(() => {
      const video = document.querySelector('video');
      if (video) video.currentTime = 13;
    });
    await page.waitForTimeout(2000);
    await page.mouse.move(500, 400);
    await page.waitForTimeout(500);

    console.log('Taking styled ASS subtitle screenshot...');
    await page.screenshot({ path: '/tmp/app-ass-styled.png' });
    console.log('Styled ASS subtitle screenshot saved to /tmp/app-ass-styled.png');
  } else {
    console.log('Could not create MKV test file, skipping MKV and ASS screenshots');
  }

  await app.close();
})().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
