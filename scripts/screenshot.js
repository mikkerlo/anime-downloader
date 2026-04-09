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

  // Create a proper H.264 MKV test file (250s to cover gist subtitle timestamps up to 4:04)
  const { execSync } = require('child_process');
  const mkvTestFile = '/tmp/test-h264.mkv';
  if (!fs.existsSync(mkvTestFile)) {
    try {
      execSync('ffmpeg -f lavfi -i testsrc=duration=250:size=640x480:rate=24 -f lavfi -i sine=frequency=440:duration=250 -c:v libx264 -preset ultrafast -c:a aac /tmp/test-h264.mkv -y', { stdio: 'pipe' });
    } catch { /* may already exist */ }
  }

  // Prepare ASS subtitle file using the actual gist content (https://gist.github.com/Cellane/3836678)
  // This contains real anime-style ASS subtitles with \move, \p1 drawing commands, sign translations, etc.
  const assTestFile = '/tmp/test-subs.ass';
  if (!fs.existsSync(assTestFile)) {
    const gistDialogues = [
      'Dialogue: 0,0:03:45.67,0:03:46.17,Default,Comment,0000,0000,0000,,Here.',
      'Dialogue: 0,0:03:46.78,0:03:48.02,Default,Comment,0000,0000,0000,,Just get up and come.',
      'Dialogue: 0,0:03:48.09,0:03:49.42,Default,Comment,0000,0000,0000,,H-Hey!',
      'Dialogue: 1,0:03:49.42,0:03:53.93,f.o.,Comment,0000,0000,0020,,{\\move(355,420,355,35)\\p1\\an8\\1a&HFF&\\shad0\\bord2\\3c&H564765&}m 0 0 l 0 45 180 45 180 0{\\p0}',
      'Dialogue: 0,0:03:49.42,0:03:53.93,f.o.,Comment,0000,0000,0020,,{\\move(355,420,355,35)\\p1\\an8\\1a&HFF&\\shad0\\bord4.5\\3c&HA5A0BC&}m 0 0 l 0 45 180 45 180 0{\\p0}',
      'Dialogue: 0,0:03:49.42,0:03:53.93,f.o.,Comment,0000,0000,0020,,{\\move(355,420,355,35)\\p1\\an8\\c&HEBE9DC&\\shad0\\bord0\\3c&H595E70&}m 0 0 l 0 45 180 45 180 0{\\p0}',
      'Dialogue: 0,0:03:49.42,0:03:53.93,f.o.,Comment,0000,0000,0020,,{\\an8\\p1\\shad0\\bord0\\3c&H595E70&\\c&HA0A87B&\\frz90\\move(263,457,263,72)}m 0 0 b 0 0 30 30 0 30{\\p0}',
      'Dialogue: 0,0:03:49.42,0:03:53.93,f.o.,Comment,0000,0000,0020,,{\\an8\\p1\\shad0\\bord0\\3c&H595E70&\\c&HA0A87B&\\frz90\\move(290,457,290,72)}m 0 0 b 0 0 30 30 0 30{\\p0}',
      'Dialogue: 0,0:03:49.42,0:03:53.93,f.o.,Comment,0000,0000,0020,,{\\an8\\p1\\shad0\\bord0\\3c&H595E70&\\c&HA0A87B&\\frz90\\move(310,457,310,72)}m 0 0 b 0 0 30 30 0 30{\\p0}',
      'Dialogue: 0,0:03:49.42,0:03:53.93,f.o.,Comment,0000,0000,0020,,{\\an8\\p1\\shad0\\bord0\\3c&H595E70&\\c&HA0A87B&\\frz90\\move(338,460,338,75)}m 0 0 b 0 0 24 30 0 30{\\p0}',
      'Dialogue: 0,0:03:49.42,0:03:53.93,f.o.,Comment,0000,0000,0020,,{\\an8\\p1\\shad0\\bord0\\3c&H595E70&\\c&HA0A87B&\\frz90\\move(358,460,358,75)}m 0 0 b 0 0 24 30 0 30{\\p0}',
      'Dialogue: 0,0:03:49.42,0:03:53.93,f.o.,Comment,0000,0000,0020,,{\\an8\\p1\\shad0\\bord0\\3c&H595E70&\\c&HA0A87B&\\frz90\\move(383,460,383,75)}m 0 0 b 0 0 24 30 0 30{\\p0}',
      'Dialogue: 0,0:03:49.42,0:03:53.93,f.o.,Comment,0000,0000,0020,,{\\an8\\p1\\shad0\\bord0\\3c&H595E70&\\c&HA0A87B&\\frz90\\move(383,457,383,72)}m 0 0 b 0 0 30 30 0 30{\\p0}',
      'Dialogue: 0,0:03:49.42,0:03:53.93,f.o.,Comment,0000,0000,0020,,{\\an8\\p1\\shad0\\bord0\\3c&H595E70&\\c&HA0A87B&\\frz90\\move(410,457,410,72)}m 0 0 b 0 0 30 30 0 30{\\p0}',
      'Dialogue: 0,0:03:49.42,0:03:53.93,f.o.,Comment,0000,0000,0020,,{\\an8\\p1\\shad0\\bord0\\3c&H595E70&\\c&HA0A87B&\\frz90\\move(435,457,435,72)\\clip(0,0,448,480)}m 0 0 b 0 0 30 30 0 30{\\p0}',
      'Dialogue: 0,0:03:49.42,0:03:53.93,f.o.,Comment,0000,0000,0000,,{\\fs16\\b0\\shad0\\bord0\\fnBankGothic Md BT\\move(325,438,325,53)\\c&H4C5CC7&}Health Center',
      'Dialogue: 0,0:03:49.42,0:03:53.93,f.o.,Comment,0000,0000,0000,,{\\fscx112\\fs32\\b0\\shad0\\bord0\\c&H5A5548&\\fnColumbo\\move(355,470,355,85)}Yu Yu Land',
      'Dialogue: 0,0:03:58.10,0:03:58.43,Default,Comment,0000,0000,0000,,See?',
      'Dialogue: 0,0:03:58.89,0:04:02.10,Default,Comment,0000,0000,0000,,Nobody\'s around now, so we have the place all to ourselves!',
      'Dialogue: 0,0:04:02.70,0:04:04.43,Default,Comment,0000,0000,0000,,This feels really good!',
    ];
    fs.writeFileSync(assTestFile, [
      '[Script Info]',
      'Title: Cellane Gist Test Subtitles',
      'ScriptType: v4.00+',
      'WrapStyle: 0',
      'PlayResX: 640',
      'PlayResY: 480',
      'ScaledBorderAndShadow: yes',
      '',
      '[V4+ Styles]',
      'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
      'Style: Default,Arial,24,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,2,1,2,20,20,30,1',
      'Style: f.o.,Arial,24,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,20,20,30,1',
      '',
      '[Events]',
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
      ...gistDialogues
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

    // Test ASS subtitle rendering with JASSUB using actual gist content
    console.log('Opening player with gist ASS subtitles...');
    const assContent = fs.readFileSync(assTestFile, 'utf-8');
    await page.evaluate(({ mkvPath, subs }) => {
      if (window.__openTestPlayer) {
        window.__openTestPlayer(
          mkvPath,
          '',
          subs,
          'Angel Beats',
          '1',
          [],
          0,
          []
        );
      }
    }, { mkvPath: mkvTestFile, subs: assContent });

    // Wait for remux + JASSUB init
    console.log('Waiting for remux + subtitle init...');
    await page.waitForTimeout(12000);

    // Screenshot 1: "Just get up and come." (3:47)
    console.log('Seeking to 3:47 — "Just get up and come."...');
    await page.evaluate(() => {
      const video = document.querySelector('video');
      if (video) video.currentTime = 227;  // 3:47
    });
    await page.waitForTimeout(3000);
    await page.mouse.move(500, 400);
    await page.waitForTimeout(500);
    await page.screenshot({ path: '/tmp/app-ass-dialogue.png' });
    console.log('Dialogue screenshot saved to /tmp/app-ass-dialogue.png');

    // Screenshot 2: "H-Hey!" (3:48.5)
    console.log('Seeking to 3:48 — "H-Hey!"...');
    await page.evaluate(() => {
      const video = document.querySelector('video');
      if (video) video.currentTime = 228.5;  // 3:48.5
    });
    await page.waitForTimeout(3000);
    await page.mouse.move(500, 400);
    await page.waitForTimeout(500);
    await page.screenshot({ path: '/tmp/app-ass-hhey.png' });
    console.log('H-Hey screenshot saved to /tmp/app-ass-hhey.png');

    // Screenshot 3: Sign translations with \move + drawing commands (3:51 — mid-animation)
    console.log('Seeking to 3:51 — sign translations (Health Center / Yu Yu Land)...');
    await page.evaluate(() => {
      const video = document.querySelector('video');
      if (video) video.currentTime = 231;  // 3:51
    });
    await page.waitForTimeout(3000);
    await page.mouse.move(500, 400);
    await page.waitForTimeout(500);
    await page.screenshot({ path: '/tmp/app-ass-signs.png' });
    console.log('Signs screenshot saved to /tmp/app-ass-signs.png');

    // Screenshot 4: "Nobody's around now..." (3:59)
    console.log('Seeking to 3:59 — "Nobody\'s around now..."...');
    await page.evaluate(() => {
      const video = document.querySelector('video');
      if (video) video.currentTime = 239;  // 3:59
    });
    await page.waitForTimeout(3000);
    await page.mouse.move(500, 400);
    await page.waitForTimeout(500);
    await page.screenshot({ path: '/tmp/app-ass-nobody.png' });
    console.log('Nobody screenshot saved to /tmp/app-ass-nobody.png');

    // Screenshot 5: "This feels really good!" (4:03)
    console.log('Seeking to 4:03 — "This feels really good!"...');
    await page.evaluate(() => {
      const video = document.querySelector('video');
      if (video) video.currentTime = 243;  // 4:03
    });
    await page.waitForTimeout(3000);
    await page.mouse.move(500, 400);
    await page.waitForTimeout(500);
    await page.screenshot({ path: '/tmp/app-ass-good.png' });
    console.log('Good screenshot saved to /tmp/app-ass-good.png');
  } else {
    console.log('Could not create MKV test file, skipping MKV and ASS screenshots');
  }

  await app.close();
})().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
