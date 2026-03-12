/**
 * Playwright: setup bodoge_testplay room + spreadsheet + run setup
 * Then auto-run bridge replay so user can watch.
 */
import { chromium } from 'playwright';
import { execSync, spawn } from 'child_process';

const SERVER_URL = 'http://localhost:3215';
const SPREADSHEET_URL = 'https://docs.google.com/spreadsheets/d/1gSmBMs2MuG5pay4p-RIOb8KNftSmmWQ0azj-NARdYNc/edit';

async function main() {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();

  page.on('console', msg => {
    if (msg.type() === 'error') console.log(`[browser:error] ${msg.text()}`);
  });

  console.log('[test] Opening bodoge_testplay...');
  await page.goto(SERVER_URL);
  await page.waitForLoadState('networkidle');
  console.log('[test] Page loaded');

  // Step 1: Create online room
  console.log('[test] Step 1: Creating online room...');
  await page.click('text=オンライン');
  await page.waitForTimeout(500);
  await page.waitForSelector('.room-btn-primary', { timeout: 5000 });
  await page.click('.room-btn-primary');

  await page.waitForSelector('.room-badge', { timeout: 20000 });
  const badgeText = await page.textContent('.room-badge');
  const roomId = badgeText?.match(/Room:\s*(\w+)/)?.[1];
  console.log(`[test] Room created: ${roomId}`);
  if (!roomId) throw new Error('Failed to get room ID');

  // Close dropdown
  await page.click('.room-badge');
  await page.waitForTimeout(300);
  await page.click('.app-title');
  await page.waitForTimeout(300);

  // Step 2: Load spreadsheet
  console.log('[test] Step 2: Loading spreadsheet...');
  await page.click('text=スプシ読み込み');
  await page.waitForTimeout(500);
  await page.fill('.sheets-url-input', SPREADSHEET_URL);
  await page.waitForTimeout(200);
  await page.click('.sheets-import-popup button:last-child');
  console.log('[test] Fetching spreadsheet data...');
  await page.waitForTimeout(8000);
  console.log('[test] Spreadsheet data fetched');

  // Step 3: Set player count to 3
  console.log('[test] Step 3: Setting player count to 3...');
  await page.click('.player-btn >> text=3人', { force: true });
  await page.waitForTimeout(300);

  // Step 4: Run setup
  console.log('[test] Step 4: Running setup...');
  await page.click('.setup-btn-primary', { force: true });
  await page.waitForTimeout(3000);
  console.log('[test] Setup complete!');

  // Step 5: Inject replay controls into the page
  console.log('[test] Step 5: Injecting replay controls...');
  await page.evaluate((controlPort) => {
    const panel = document.createElement('div');
    panel.id = 'replay-controls';
    panel.innerHTML = `
      <div style="
        position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
        background: rgba(0,0,0,0.85); color: white; padding: 12px 20px;
        border-radius: 12px; display: flex; gap: 10px; align-items: center;
        z-index: 99999; font-family: sans-serif; font-size: 14px;
        box-shadow: 0 4px 20px rgba(0,0,0,0.3);
      ">
        <span id="rc-status" style="min-width: 100px;">▶ 再生中</span>
        <button onclick="rcCmd('pause')" style="padding: 6px 16px; border: none; border-radius: 6px; background: #f39c12; color: white; cursor: pointer; font-size: 14px;">⏸ 一時停止</button>
        <button onclick="rcCmd('resume')" style="padding: 6px 16px; border: none; border-radius: 6px; background: #27ae60; color: white; cursor: pointer; font-size: 14px;">▶ 再生</button>
        <button onclick="rcCmd('step')" style="padding: 6px 16px; border: none; border-radius: 6px; background: #3498db; color: white; cursor: pointer; font-size: 14px;">⏭ 1ステップ</button>
        <span id="rc-round" style="margin-left: 10px; opacity: 0.7;">Round: -</span>
      </div>
    `;
    document.body.appendChild(panel);

    window.rcCmd = async function(cmd) {
      try {
        const res = await fetch('http://localhost:' + controlPort + '/' + cmd);
        const data = await res.json();
        updateStatus(cmd);
      } catch(e) { console.error('Control error:', e); }
    };

    function updateStatus(lastCmd) {
      const el = document.getElementById('rc-status');
      if (!el) return;
      if (lastCmd === 'pause') el.textContent = '⏸ 一時停止中';
      else if (lastCmd === 'resume') el.textContent = '▶ 再生中';
      else if (lastCmd === 'step') el.textContent = '⏭ ステップ';
    }

    // Poll status every second
    setInterval(async () => {
      try {
        const res = await fetch('http://localhost:' + controlPort + '/status');
        const data = await res.json();
        const roundEl = document.getElementById('rc-round');
        if (roundEl) roundEl.textContent = 'Round: ' + data.round + '/' + data.totalRounds;
        const statusEl = document.getElementById('rc-status');
        if (statusEl && data.paused) statusEl.textContent = '⏸ 一時停止中';
        else if (statusEl && !data.paused) statusEl.textContent = '▶ 再生中';
      } catch(e) {}
    }, 1000);
  }, 3216);  // Pass the control port number

  // Step 6: Auto-run bridge replay
  console.log(`[test] Step 6: Starting bridge replay in room ${roomId}...`);
  const bridge = spawn('npx', [
    'tsx', 'src/bridge/runner.ts', 'replay',
    '--log', 'test-replay.json',
    '--room', roomId,
    '--url', SERVER_URL,
    '--delay', '2000',
  ], { stdio: 'inherit', shell: true });

  bridge.on('close', (code) => {
    console.log(`[test] Bridge replay finished (exit code ${code})`);
    console.log('[test] Browser staying open for review.');
  });

  // Keep browser open
  await new Promise(() => {});
}

main().catch((err) => {
  console.error('[test] Error:', err);
  process.exit(1);
});
