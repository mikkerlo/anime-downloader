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

  console.log('Taking screenshot...');
  await page.screenshot({ path: '/tmp/app-screenshot.png' });
  console.log('Screenshot saved to /tmp/app-screenshot.png');

  await app.close();
})().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
