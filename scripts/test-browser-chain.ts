// Targeted test: drive the SHIPPED browser tools with a runId to prove shared page (nav then screenshot has content)
import * as Browser from '../lib/browser';
import * as fs from 'fs/promises';
import * as path from 'path';

const SCRATCH_EVIDENCE = 'C:\\Users\\steph\\AppData\\Local\\Temp\\grok-goal-6bf363e51743\\implementer\\agent-run-evidence';

async function main() {
  const runId = 'test-browser-chain-' + Date.now();
  console.log('Testing per-run page sharing with runId=', runId);

  // Navigate on the run page
  const nav = await Browser.browserNavigate('https://example.com', runId);
  console.log('nav ok=', nav.ok, 'url=', nav.url);

  // Screenshot on SAME run page (should now have real content)
  const shot = await Browser.browserScreenshot('chain-test', runId);
  console.log('shot path=', shot.path);

  const st = await fs.stat(shot.path);
  console.log('screenshot size bytes=', st.size);

  if (st.size < 6000) {
    throw new Error('Screenshot still too small/blank after nav on shared page');
  }

  // Copy to evidence
  const dest = path.join(SCRATCH_EVIDENCE, 'chain-test-' + path.basename(shot.path));
  await fs.copyFile(shot.path, dest).catch(() => {});

  // Cleanup
  await Browser.closeRunPage(runId);

  console.log('BROWSER_CHAIN_TEST_PASSED size=', st.size);
}

main().catch(e => { console.error('BROWSER_CHAIN_TEST_FAILED', e); process.exit(1); });
