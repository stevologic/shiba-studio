/**
 * Generates 50 unique alien-themed SVG avatars into public/avatars/.
 * Run: npx tsx scripts/generate-alien-avatars.ts
 */

import * as fs from 'fs/promises';
import * as path from 'path';

const COUNT = 50;
const OUT_DIR = path.join(process.cwd(), 'public', 'avatars');

const SKINS = [
  '#7ee787', '#a371f7', '#58a6ff', '#f778ba', '#ffa657',
  '#79c0ff', '#d2a8ff', '#56d364', '#ff7b72', '#e3b341',
  '#39d353', '#bc8cff', '#6eb5ff', '#ff9bce', '#8b949e',
];

const BG = ['#0d1117', '#161b22', '#1c2128', '#0a0a0a', '#111318'];

function alienSvg(i: number): string {
  const skin = SKINS[i % SKINS.length];
  const bg = BG[Math.floor(i / 10) % BG.length];
  const eyeCount = (i % 4) + 1;
  const hasAntenna = i % 3 !== 0;
  const hasHelmet = i % 5 === 0;
  const tentacles = i % 7 === 0;
  const bigHead = i % 2 === 0;
  const cx = 32;
  const cy = bigHead ? 34 : 36;
  const rx = bigHead ? 18 : 15;
  const ry = bigHead ? 20 : 17;

  let extras = '';
  if (hasAntenna) {
    const ax1 = cx - 10 + (i % 3);
    const ax2 = cx + 10 - (i % 2);
    extras += `<line x1="${ax1}" y1="14" x2="${ax1 - 2}" y2="4" stroke="${skin}" stroke-width="2.5" stroke-linecap="round"/>`;
    extras += `<circle cx="${ax1 - 2}" cy="4" r="3" fill="${skin}"/>`;
    extras += `<line x1="${ax2}" y1="14" x2="${ax2 + 2}" y2="6" stroke="${skin}" stroke-width="2.5" stroke-linecap="round"/>`;
    extras += `<circle cx="${ax2 + 2}" cy="6" r="2.5" fill="#fff" opacity="0.8"/>`;
  }
  if (hasHelmet) {
    extras += `<ellipse cx="${cx}" cy="${cy - 4}" rx="${rx + 4}" ry="${ry + 2}" fill="none" stroke="#8b949e" stroke-width="2" opacity="0.7"/>`;
    extras += `<rect x="${cx - 8}" y="${cy - 2}" width="16" height="4" rx="1" fill="#58a6ff" opacity="0.5"/>`;
  }
  if (tentacles) {
    for (let t = 0; t < 3; t++) {
      const tx = cx - 8 + t * 8;
      extras += `<path d="M${tx} ${cy + ry - 2} Q${tx + (t - 1) * 4} ${cy + ry + 10} ${tx + (t - 1) * 6} ${cy + ry + 16}" stroke="${skin}" stroke-width="2.5" fill="none" stroke-linecap="round"/>`;
    }
  }

  let eyes = '';
  const eyeY = cy - 4;
  if (eyeCount === 1) {
    eyes = `<ellipse cx="${cx}" cy="${eyeY}" rx="7" ry="9" fill="#111"/><ellipse cx="${cx}" cy="${eyeY}" rx="3" ry="5" fill="#fff"/>`;
  } else if (eyeCount === 2) {
    eyes = `<ellipse cx="${cx - 7}" cy="${eyeY}" rx="5" ry="7" fill="#111"/><ellipse cx="${cx - 7}" cy="${eyeY}" rx="2" ry="4" fill="#fff"/>`;
    eyes += `<ellipse cx="${cx + 7}" cy="${eyeY}" rx="5" ry="7" fill="#111"/><ellipse cx="${cx + 7}" cy="${eyeY}" rx="2" ry="4" fill="#fff"/>`;
  } else if (eyeCount === 3) {
    [-10, 0, 10].forEach((ox) => {
      eyes += `<circle cx="${cx + ox}" cy="${eyeY}" r="4" fill="#111"/><circle cx="${cx + ox}" cy="${eyeY}" r="1.5" fill="#fff"/>`;
    });
  } else {
    [[-9, -3], [3, -3], [-9, 5], [3, 5]].forEach(([ox, oy]) => {
      eyes += `<circle cx="${cx + ox}" cy="${eyeY + oy}" r="3" fill="#111"/><circle cx="${cx + ox}" cy="${eyeY + oy}" r="1" fill="#fff"/>`;
    });
  }

  const mouth =
    i % 6 === 0
      ? `<ellipse cx="${cx}" cy="${cy + 10}" rx="5" ry="2" fill="#111"/>`
      : i % 6 === 1
        ? `<path d="M${cx - 5} ${cy + 8} Q${cx} ${cy + 14} ${cx + 5} ${cy + 8}" stroke="#111" stroke-width="2" fill="none"/>`
        : `<line x1="${cx - 4}" y1="${cy + 10}" x2="${cx + 4}" y2="${cy + 10}" stroke="#111" stroke-width="2" stroke-linecap="round"/>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none">
  <rect width="64" height="64" rx="10" fill="${bg}"/>
  <ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${skin}"/>
  ${extras}
  ${eyes}
  ${mouth}
</svg>`;
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  for (let i = 1; i <= COUNT; i++) {
    const id = String(i).padStart(2, '0');
    const file = path.join(OUT_DIR, `alien-${id}.svg`);
    await fs.writeFile(file, alienSvg(i - 1));
  }
  console.log(`Generated ${COUNT} alien avatars in ${OUT_DIR}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});