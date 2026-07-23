import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseRichCard, RICH_CARD_FENCE, RICH_CARD_PROMPT } from '../lib/rich-cards';

async function main() {
  // Stats: normalized, bounded, tones validated.
  const stats = parseRichCard(JSON.stringify({
    kind: 'stats',
    title: 'Sprint',
    stats: [
      { label: 'Cards delivered', value: '16', delta: '+4', tone: 'up' },
      { label: 'Open bugs', value: '2', tone: 'nonsense' },
      { label: '', value: 'dropped — empty label' },
    ],
  }));
  assert(stats && stats.kind === 'stats');
  assert.equal(stats.stats.length, 2, 'entries without label/value are dropped');
  assert.equal(stats.stats[0].tone, 'up');
  assert.equal(stats.stats[1].tone, undefined, 'invalid tones are dropped');

  // Progress: percent clamped and rounded.
  const progress = parseRichCard('{"kind":"progress","items":[{"label":"Beta","percent":141.4},{"label":"Docs","percent":-3}]}');
  assert(progress && progress.kind === 'progress');
  assert.deepEqual(progress.items.map((item) => item.percent), [100, 0], 'percent clamps to 0–100');

  // Checklist: unknown states default to pending.
  const checklist = parseRichCard('{"kind":"checklist","items":[{"text":"Ship","state":"done"},{"text":"Test","state":"???"}]}');
  assert(checklist && checklist.kind === 'checklist');
  assert.equal(checklist.items[1].state, 'pending');

  // Timeline + callout normalize.
  const timeline = parseRichCard('{"kind":"timeline","items":[{"label":"Beta live","date":"Jul 23","state":"done"}]}');
  assert(timeline && timeline.kind === 'timeline' && timeline.items[0].state === 'done');
  const callout = parseRichCard('{"kind":"callout","tone":"weird","title":"Heads up"}');
  assert(callout && callout.kind === 'callout');
  assert.equal(callout.tone, 'info', 'unknown callout tones fall back to info');

  // Bounds: item lists cap at 12.
  const big = parseRichCard(JSON.stringify({
    kind: 'checklist',
    items: Array.from({ length: 30 }, (_, index) => ({ text: `item ${index}`, state: 'pending' })),
  }));
  assert(big && big.kind === 'checklist');
  assert.equal(big.items.length, 12, 'card item lists are bounded');

  // Media: URL guard allows https/data-image/same-origin paths, rejects the rest.
  const media = parseRichCard('{"kind":"media","src":"/shiba-logo.svg","body":"Our mark","layout":"right"}');
  assert(media && media.kind === 'media' && media.layout === 'right');
  assert.equal(parseRichCard('{"kind":"media","src":"javascript:alert(1)"}'), null, 'script URLs rejected');
  assert.equal(parseRichCard('{"kind":"media","src":"//evil.example/x.png"}'), null, 'protocol-relative URLs rejected');
  assert(parseRichCard('{"kind":"media","src":"data:image/png;base64,AAAA"}'), 'inline data images allowed');

  // Sparkline: non-finite samples dropped, series needs ≥2 points, capped at 60.
  const spark = parseRichCard(JSON.stringify({
    kind: 'sparkline',
    series: [
      { label: 'Runs', values: [1, 'x', 3, null, 8], value: '8', tone: 'up' },
      { label: 'Too short', values: [5] },
      { label: 'Long', values: Array.from({ length: 200 }, (_, index) => index) },
    ],
  }));
  assert(spark && spark.kind === 'sparkline');
  assert.equal(spark.series.length, 2, 'series without two finite samples are dropped');
  assert.deepEqual(spark.series[0].values, [1, 3, 8], 'non-numeric samples are filtered');
  assert.equal(spark.series[1].values.length, 60, 'samples cap at 60');

  // Bars: negative rows dropped; unit preserved.
  const bars = parseRichCard('{"kind":"bars","unit":"runs","items":[{"label":"Engineer","value":12},{"label":"Bad","value":-3}]}');
  assert(bars && bars.kind === 'bars');
  assert.equal(bars.items.length, 1, 'negative magnitudes are dropped');
  assert.equal(bars.unit, 'runs');

  // Malformed payloads must return null (renderers fall back to plain code).
  for (const bad of ['not json', '[1,2]', '{"kind":"stats","stats":[]}', '{"kind":"unknown"}', '{"kind":"callout","title":""}']) {
    assert.equal(parseRichCard(bad), null, `rejects: ${bad}`);
  }

  // Surface contract: the shared markdown renderer intercepts the fence, and
  // agent system prompts teach it.
  const root = path.resolve(__dirname, '..');
  const markdown = await fs.readFile(path.join(root, 'components/chat-markdown.tsx'), 'utf8');
  assert(markdown.includes('RICH_CARD_FENCE') && markdown.includes('parseRichCard'), 'ChatMarkdown renders shiba-card fences');
  const chatSkill = await fs.readFile(path.join(root, 'lib/chat-skill.ts'), 'utf8');
  assert(chatSkill.includes('RICH_CARD_PROMPT'), 'agent chat system prompt teaches the card fence');
  assert(RICH_CARD_PROMPT.includes(RICH_CARD_FENCE), 'prompt names the fence language');

  console.log('verify-rich-cards: OK');
}

main().catch((error) => {
  console.error('verify-rich-cards: FAILED');
  console.error(error);
  process.exit(1);
});
