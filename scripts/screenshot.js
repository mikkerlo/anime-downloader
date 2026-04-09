const { _electron: electron } = require('playwright');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

// Run tesseract OCR on the subtitle area of a screenshot.
// Crops the bottom 15% of the image (above the 40px control bar) where subtitles render,
// which dramatically improves OCR accuracy for white-on-dark subtitle text.
function ocr(imagePath) {
  const cropPath = imagePath.replace('.png', '-crop.png');
  try {
    execSync(`convert "${imagePath}" -gravity South -crop 100%x15%+0+40 "${cropPath}"`, { stdio: 'pipe' });
    const text = execSync(`tesseract "${cropPath}" stdout --psm 6 2>/dev/null`).toString().trim();
    return text;
  } catch {
    return '(OCR failed)';
  } finally {
    try { fs.unlinkSync(cropPath); } catch { /* ignore */ }
  }
}

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

  // Create a short H.264 MKV test file with solid dark background — 40s is enough since subtitles end at 33s.
  // Dark background ensures white subtitle text is clearly visible and OCR-detectable.
  const mkvTestFile = '/tmp/test-h264.mkv';
  if (!fs.existsSync(mkvTestFile)) {
    try {
      execSync('ffmpeg -f lavfi -i color=c=0x1a1a2e:s=640x480:d=40:r=24 -f lavfi -i sine=frequency=440:duration=40 -c:v libx264 -preset ultrafast -c:a aac /tmp/test-h264.mkv -y', { stdio: 'pipe' });
    } catch { /* may already exist */ }
  }

  // Prepare ASS subtitle file based on the gist content (https://gist.github.com/Cellane/3836678)
  // Timestamps shifted from 3:45+ to 0:01+ so we can use a short 30s test video.
  // Each subtitle gets a wide time window (6-8s) so it's still active when the screenshot
  // is taken — JASSUB uses requestVideoFrameCallback and needs the video playing.
  const assTestFile = '/tmp/test-subs.ass';
  const gistDialogues = [
    // "Just get up and come." — screenshot at 2s, subtitle active 0:00:01–0:00:06
    'Dialogue: 0,0:00:01.00,0:00:06.00,Default,Comment,0000,0000,0000,,Just get up and come.',
    // "H-Hey!" — screenshot at 8s, subtitle active 0:00:07–0:00:12
    'Dialogue: 0,0:00:07.00,0:00:12.00,Default,Comment,0000,0000,0000,,H-Hey!',
    // Sign translations with \move, \p1 drawing commands — screenshot at 15s, active 0:00:13–0:00:19
    'Dialogue: 1,0:00:13.00,0:00:19.00,f.o.,Comment,0000,0000,0020,,{\\move(355,420,355,35)\\p1\\an8\\1a&HFF&\\shad0\\bord2\\3c&H564765&}m 0 0 l 0 45 180 45 180 0{\\p0}',
    'Dialogue: 0,0:00:13.00,0:00:19.00,f.o.,Comment,0000,0000,0020,,{\\move(355,420,355,35)\\p1\\an8\\1a&HFF&\\shad0\\bord4.5\\3c&HA5A0BC&}m 0 0 l 0 45 180 45 180 0{\\p0}',
    'Dialogue: 0,0:00:13.00,0:00:19.00,f.o.,Comment,0000,0000,0020,,{\\move(355,420,355,35)\\p1\\an8\\c&HEBE9DC&\\shad0\\bord0\\3c&H595E70&}m 0 0 l 0 45 180 45 180 0{\\p0}',
    'Dialogue: 0,0:00:13.00,0:00:19.00,f.o.,Comment,0000,0000,0020,,{\\an8\\p1\\shad0\\bord0\\3c&H595E70&\\c&HA0A87B&\\frz90\\move(263,457,263,72)}m 0 0 b 0 0 30 30 0 30{\\p0}',
    'Dialogue: 0,0:00:13.00,0:00:19.00,f.o.,Comment,0000,0000,0020,,{\\an8\\p1\\shad0\\bord0\\3c&H595E70&\\c&HA0A87B&\\frz90\\move(290,457,290,72)}m 0 0 b 0 0 30 30 0 30{\\p0}',
    'Dialogue: 0,0:00:13.00,0:00:19.00,f.o.,Comment,0000,0000,0020,,{\\an8\\p1\\shad0\\bord0\\3c&H595E70&\\c&HA0A87B&\\frz90\\move(310,457,310,72)}m 0 0 b 0 0 30 30 0 30{\\p0}',
    'Dialogue: 0,0:00:13.00,0:00:19.00,f.o.,Comment,0000,0000,0020,,{\\an8\\p1\\shad0\\bord0\\3c&H595E70&\\c&HA0A87B&\\frz90\\move(338,460,338,75)}m 0 0 b 0 0 24 30 0 30{\\p0}',
    'Dialogue: 0,0:00:13.00,0:00:19.00,f.o.,Comment,0000,0000,0020,,{\\an8\\p1\\shad0\\bord0\\3c&H595E70&\\c&HA0A87B&\\frz90\\move(358,460,358,75)}m 0 0 b 0 0 24 30 0 30{\\p0}',
    'Dialogue: 0,0:00:13.00,0:00:19.00,f.o.,Comment,0000,0000,0020,,{\\an8\\p1\\shad0\\bord0\\3c&H595E70&\\c&HA0A87B&\\frz90\\move(383,460,383,75)}m 0 0 b 0 0 24 30 0 30{\\p0}',
    'Dialogue: 0,0:00:13.00,0:00:19.00,f.o.,Comment,0000,0000,0020,,{\\an8\\p1\\shad0\\bord0\\3c&H595E70&\\c&HA0A87B&\\frz90\\move(383,457,383,72)}m 0 0 b 0 0 30 30 0 30{\\p0}',
    'Dialogue: 0,0:00:13.00,0:00:19.00,f.o.,Comment,0000,0000,0020,,{\\an8\\p1\\shad0\\bord0\\3c&H595E70&\\c&HA0A87B&\\frz90\\move(410,457,410,72)}m 0 0 b 0 0 30 30 0 30{\\p0}',
    'Dialogue: 0,0:00:13.00,0:00:19.00,f.o.,Comment,0000,0000,0020,,{\\an8\\p1\\shad0\\bord0\\3c&H595E70&\\c&HA0A87B&\\frz90\\move(435,457,435,72)\\clip(0,0,448,480)}m 0 0 b 0 0 30 30 0 30{\\p0}',
    'Dialogue: 0,0:00:13.00,0:00:19.00,f.o.,Comment,0000,0000,0000,,{\\fs16\\b0\\shad0\\bord0\\fnBankGothic Md BT\\move(325,438,325,53)\\c&H4C5CC7&}Health Center',
    'Dialogue: 0,0:00:13.00,0:00:19.00,f.o.,Comment,0000,0000,0000,,{\\fscx112\\fs32\\b0\\shad0\\bord0\\c&H5A5548&\\fnColumbo\\move(355,470,355,85)}Yu Yu Land',
    // "Nobody's around now..." — screenshot at 21s, active 0:00:20–0:00:26
    'Dialogue: 0,0:00:20.00,0:00:26.00,Default,Comment,0000,0000,0000,,Nobody\'s around now, so we have the place all to ourselves!',
    // "This feels really good!" — screenshot at 28s, active 0:00:27–0:00:33 (video is 40s)
    'Dialogue: 0,0:00:27.00,0:00:33.00,Default,Comment,0000,0000,0000,,This feels really good!',
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
    // Wait for full cleanup (PlayerView unmount + remux temp file deletion)
    await page.waitForTimeout(3000);

    // Verify player is fully closed
    const playerClosed = await page.evaluate(() => !document.querySelector('.player-overlay'));
    console.log('Player fully closed:', playerClosed);

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

    // Verify player is open and JASSUB is active
    const playerReady = await page.evaluate(() => {
      const video = document.querySelector('video');
      return {
        hasPlayer: !!document.querySelector('.player-overlay'),
        hasVideo: !!video,
        videoReady: video?.readyState || 0,
        hasJassub: !!document.querySelector('.JASSUB'),
        hasJassubCanvas: !!document.querySelector('.JASSUB canvas'),
      };
    });
    console.log('Player ready state:', JSON.stringify(playerReady));
    if (!playerReady.hasPlayer || !playerReady.hasVideo) {
      console.error('❌ Player did not open! Skipping subtitle screenshots.');
      await app.close();
      process.exit(1);
    }

    // Helper: seek, wait for JASSUB render (video must keep playing for requestVideoFrameCallback),
    // then screenshot + OCR verification
    async function seekAndScreenshot(seekTime, label, screenshotPath, expectedText) {
      console.log(`Seeking to ${seekTime}s — ${label}...`);
      await page.evaluate((t) => {
        const video = document.querySelector('video');
        if (video) {
          video.currentTime = t;
          video.play(); // ensure playing — JASSUB needs requestVideoFrameCallback to fire
        }
      }, seekTime);
      // Wait for JASSUB to render the subtitle (needs ~1-2 RVFC cycles)
      await page.waitForTimeout(1500);
      // Move mouse to top-left corner away from subtitle area
      await page.mouse.move(1, 1);
      await page.waitForTimeout(300);
      await page.screenshot({ path: screenshotPath });
      console.log(`Screenshot saved to ${screenshotPath}`);

      // OCR verification
      const ocrText = ocr(screenshotPath);
      console.log(`OCR text: ${ocrText}`);
      if (expectedText) {
        const found = expectedText.some(t => ocrText.toLowerCase().includes(t.toLowerCase()));
        if (found) {
          console.log(`✅ OCR verified: found expected text`);
        } else {
          console.log(`⚠️  OCR did NOT find expected text "${expectedText.join('" or "')}" in screenshot`);
        }
      }
    }

    // Screenshot 1: "Just get up and come." — subtitle at 0:01–0:06, seek to 2s
    await seekAndScreenshot(2, '"Just get up and come."', '/tmp/app-ass-dialogue.png', ['get', 'up', 'come']);

    // Screenshot 2: "H-Hey!" — subtitle at 0:07–0:12, seek to 8s
    await seekAndScreenshot(8, '"H-Hey!"', '/tmp/app-ass-hhey.png', ['Hey']);

    // Screenshot 3: Sign translations — subtitle at 0:13–0:19, seek to 15s
    // Sign text uses small custom fonts, OCR may not detect — verify visually
    await seekAndScreenshot(15, 'sign translations (Health Center / Yu Yu Land)', '/tmp/app-ass-signs.png', ['Health', 'Yu', 'Land', 'Center']);

    // Screenshot 4: "Nobody's around now..." — subtitle at 0:20–0:26, seek to 21s
    await seekAndScreenshot(21, '"Nobody\'s around now..."', '/tmp/app-ass-nobody.png', ['Nobody', 'around', 'ourselves', 'place']);

    // Screenshot 5: "This feels really good!" — subtitle at 0:27–0:33, seek to 28s
    await seekAndScreenshot(28, '"This feels really good!"', '/tmp/app-ass-good.png', ['feels', 'good', 'really']);
  } else {
    console.log('Could not create MKV test file, skipping MKV and ASS screenshots');
  }

  await app.close();
})().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
