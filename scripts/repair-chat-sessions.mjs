import fs from 'fs';

const path = process.env.HOME
  ? `${process.env.HOME}/.shiba-studio/data/chat-sessions.json`
  : `${process.env.USERPROFILE}\\.shiba-studio\\data\\chat-sessions.json`;

const raw = fs.readFileSync(path, 'utf8');

/** Extract first complete top-level JSON object from possibly-corrupted file. */
function firstJsonObject(text) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return text.slice(0, i + 1);
    }
  }
  return null;
}

let parsed;
try {
  parsed = JSON.parse(raw);
  console.log('File already valid JSON');
} catch {
  const first = firstJsonObject(raw);
  if (!first) {
    console.error('Could not recover any JSON object');
    process.exit(1);
  }
  parsed = JSON.parse(first);
  fs.writeFileSync(`${path}.corrupt-backup`, raw);
  console.log('Recovered first JSON object; backup at chat-sessions.json.corrupt-backup');
}

if (!Array.isArray(parsed.sessions)) {
  console.error('No sessions array');
  process.exit(1);
}

for (const s of parsed.sessions) {
  s.running = false;
  if (Array.isArray(s.messages)) {
    for (const m of s.messages) m.streaming = false;
  }
}

fs.writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`);
console.log(`Repaired ${parsed.sessions.length} session(s):`);
for (const s of parsed.sessions) {
  console.log(`  - ${s.id.slice(0, 8)}… ${s.title || 'untitled'} (${(s.messages || []).length} msgs)`);
}
