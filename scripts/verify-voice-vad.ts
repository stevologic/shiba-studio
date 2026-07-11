// Unit-tests the barge-in speech-onset detector (lib/voice-vad.ts) with
// synthetic RMS streams — the pure state machine behind voice interruption.

import * as path from 'path';
import { GOAL_SCRATCH as SCRATCH } from '../lib/verify-scratch';
import { createVadDetector } from '../lib/voice-vad';

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); failures++; } else console.log(`ok: ${msg}`);
}

const TICK = 30;

/** Drive the detector with (rms, durationMs) segments; returns fire times. */
function run(segments: Array<[number, number]>, opts = {}): number[] {
  const det = createVadDetector(opts);
  const fires: number[] = [];
  let now = 0;
  for (const [rms, ms] of segments) {
    for (let t = 0; t < ms; t += TICK) {
      now += TICK;
      if (det.push(rms, now)) fires.push(now);
    }
  }
  return fires;
}

const QUIET = 0.003;
const SPEECH = 0.06;

function main() {
  // 1) Sustained speech after silence fires once, fast (~minSpeechMs).
  {
    const fires = run([[QUIET, 1200], [SPEECH, 1000]]);
    assert(fires.length === 1, `sustained speech fires exactly once (${fires.length})`);
    const onset = fires[0] - 1200;
    assert(onset >= 200 && onset <= 320, `fires ~200-320ms after onset (${onset}ms)`);
  }

  // 2) A short blip (e.g. a cough tick, door knock) does NOT fire.
  {
    const fires = run([[QUIET, 1200], [SPEECH, 120], [QUIET, 1000]]);
    assert(fires.length === 0, 'sub-200ms blip does not interrupt');
  }

  // 3) Brief dropouts inside speech (<150ms) don't reset the onset clock.
  {
    const fires = run([[QUIET, 1200], [SPEECH, 120], [QUIET, 90], [SPEECH, 300]]);
    assert(fires.length === 1, 'speech with a short dropout still fires');
  }

  // 4) Steady low-level noise raises the adaptive floor — no false fire.
  {
    const hum = 0.02; // above absMin, but constant → becomes the floor
    const fires = run([[hum, 4000]]);
    assert(fires.length === 0, 'constant room hum adapts into the noise floor (no fire)');
  }

  // 5) Speech over that hum still fires (threshold tracks the floor).
  {
    const fires = run([[0.02, 4000], [0.2, 1000]]);
    assert(fires.length === 1, 'loud speech over adapted hum fires');
  }

  // 6) Re-arm: two utterances separated by quiet fire twice.
  {
    const fires = run([[QUIET, 1200], [SPEECH, 600], [QUIET, 800], [SPEECH, 600]]);
    assert(fires.length === 2, `separate utterances fire separately (${fires.length})`);
  }

  // 7) One long utterance fires only once (no machine-gun interrupts).
  {
    const fires = run([[QUIET, 1200], [SPEECH, 5000]]);
    assert(fires.length === 1, 'one long utterance fires once');
  }

  // 8) Silence never fires.
  {
    const fires = run([[0, 5000]]);
    assert(fires.length === 0, 'pure silence never fires');
  }

  void (async () => {
    const fs = await import('fs/promises');
    await fs.mkdir(SCRATCH, { recursive: true }).catch(() => {});
    await fs.writeFile(path.join(SCRATCH, 'voice-vad-verify.log'), `failures=${failures}\n`);
    if (failures) { console.error(`\n${failures} VAD checks FAILED`); process.exit(1); }
    console.log('\nALL VOICE-VAD CHECKS PASSED');
    process.exit(0);
  })();
}

main();
