const { _electron: electron } = require('playwright');
const path = require('path');
const fs = require('fs');

(async () => {
  const appPath = path.join('/home/runner/work/anime-downloader/anime-downloader', 'out/main/index.js');
  const app = await electron.launch({
    args: [appPath],
    env: { ...process.env, NODE_ENV: 'production' },
    timeout: 30000,
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  
  // Collect ALL console messages
  const logs = [];
  page.on('console', msg => {
    const text = msg.text();
    logs.push(`[${msg.type()}] ${text}`);
  });
  page.on('pageerror', err => {
    logs.push(`[PAGE ERROR] ${err.message}`);
  });
  
  await page.waitForTimeout(3000);
  
  const assContent = fs.readFileSync('/tmp/test-subs.ass', 'utf-8');
  const mkvPath = '/tmp/test-h264.mkv';
  
  console.log('Opening player with MKV + ASS subs...');
  await page.evaluate(({ mkvPath, subs }) => {
    if (window.__openTestPlayer) {
      window.__openTestPlayer(mkvPath, '', subs, 'Diag Test', '1', [], 0, []);
    }
  }, { mkvPath, subs: assContent });
  
  // Wait for remux
  await page.waitForTimeout(15000);
  
  // Check JASSUB state
  const state = await page.evaluate(() => {
    const video = document.querySelector('video');
    const jassubDivs = document.querySelectorAll('.JASSUB');
    const allCanvases = document.querySelectorAll('canvas');
    const jassubCanvases = [...allCanvases].filter(c => c.parentElement && c.parentElement.className === 'JASSUB');
    
    return {
      videoSrc: video ? video.src.substring(0, 80) : 'no video',
      videoReadyState: video ? video.readyState : -1,
      videoDuration: video ? video.duration : 0,
      videoCurrentTime: video ? video.currentTime : 0,
      videoWidth: video ? video.videoWidth : 0,
      videoHeight: video ? video.videoHeight : 0,
      jassubDivCount: jassubDivs.length,
      jassubCanvasCount: jassubCanvases.length,
      jassubCanvasInfo: jassubCanvases.length > 0 ? {
        width: jassubCanvases[0].width,
        height: jassubCanvases[0].height,
        display: jassubCanvases[0].style.display,
        position: jassubCanvases[0].style.position,
        zIndex: jassubCanvases[0].style.zIndex,
        parentStyle: jassubCanvases[0].parentElement ? jassubCanvases[0].parentElement.style.cssText : 'none',
      } : null,
      allCanvasCount: allCanvases.length,
    };
  });
  
  console.log('State:', JSON.stringify(state, null, 2));
  
  // Now seek to subtitle time and check
  await page.evaluate(() => {
    const video = document.querySelector('video');
    if (video) video.currentTime = 227;
  });
  await page.waitForTimeout(3000);
  
  const state2 = await page.evaluate(() => {
    const video = document.querySelector('video');
    const jassubCanvases = [...document.querySelectorAll('canvas')].filter(c => c.parentElement && c.parentElement.className === 'JASSUB');
    
    return {
      currentTime: video ? video.currentTime : 0,
      jassubCanvasSize: jassubCanvases.length > 0 ? `${jassubCanvases[0].width}x${jassubCanvases[0].height}` : 'none',
      jassubParentRect: jassubCanvases.length > 0 && jassubCanvases[0].parentElement ? jassubCanvases[0].parentElement.getBoundingClientRect() : null,
    };
  });
  
  console.log('After seek:', JSON.stringify(state2, null, 2));
  console.log('Console logs:', logs.filter(l => l.toLowerCase().includes('jassub') || l.toLowerCase().includes('subtitle') || l.toLowerCase().includes('error') || l.toLowerCase().includes('worker')).join('\n'));
  console.log('\nAll console logs:');
  logs.forEach(l => console.log('  ' + l));
  
  await app.close();
})().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
