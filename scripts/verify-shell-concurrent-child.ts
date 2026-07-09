/**
 * Child entry for verify-shell-state concurrent write check.
 * Requires SHIBA_DATA_DIR to be set before import of chat-sessions.
 */
import * as fs from 'fs';
import * as path from 'path';

async function main() {
  const dir = process.env.SHIBA_DATA_DIR;
  if (!dir) throw new Error('SHIBA_DATA_DIR required');
  const { createChatSession, updateChatSession, listChatSessions } = await import('../lib/chat-sessions');
  const s = await createChatSession({ title: 'Concurrent Base' });
  await Promise.all([
    updateChatSession(s.id, { title: 'A' }),
    updateChatSession(s.id, { running: true }),
    updateChatSession(s.id, { running: false }),
    updateChatSession(s.id, { title: 'Concurrent OK' }),
  ]);
  const list = await listChatSessions();
  const raw = fs.readFileSync(path.join(dir, 'chat-sessions.json'), 'utf8');
  JSON.parse(raw);
  if (!list.length) throw new Error('empty list');
  console.log(`CONCURRENT_OK count=${list.length} title=${list[0].title}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
