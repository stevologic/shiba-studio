import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const TSX = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

function run(source: string, overrides: Record<string, string> = {}) {
  const env = { ...process.env, ...overrides };
  delete env.SHIBA_SECRET_KEY;
  delete env.GROKDESK_SECRET_KEY;
  delete env.SHIBA_SECRET_KEY_FILE;
  Object.assign(env, overrides);
  return spawnSync(process.execPath, [TSX, '--eval', source], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    shell: false,
  });
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shiba-secure-store-'));
  try {
    const invalidEnv = run(
      "import { encryptSecret } from './lib/secure-store.ts'; encryptSecret('secret');",
      { SHIBA_SECRET_KEY: 'not-a-valid-key' },
    );
    assert.notEqual(invalidEnv.status, 0, 'malformed environment keys fail closed');
    assert.match(`${invalidEnv.stdout}\n${invalidEnv.stderr}`, /64 hexadecimal characters/);

    const malformedFile = path.join(root, 'malformed.key');
    await fs.writeFile(malformedFile, 'invalid-key-material');
    const invalidFile = run(
      "import { encryptSecret } from './lib/secure-store.ts'; encryptSecret('secret');",
      { SHIBA_SECRET_KEY_FILE: malformedFile },
    );
    assert.notEqual(invalidFile.status, 0, 'malformed key files fail closed');
    assert.equal(await fs.readFile(malformedFile, 'utf8'), 'invalid-key-material', 'malformed key file is never overwritten');

    const generatedFile = path.join(root, 'new.key');
    const generated = run(
      "import { encryptSecret } from './lib/secure-store.ts'; console.log(encryptSecret('secret'));",
      { SHIBA_SECRET_KEY_FILE: generatedFile },
    );
    assert.equal(generated.status, 0, generated.stderr);
    assert.match((await fs.readFile(generatedFile, 'utf8')).trim(), /^[0-9a-f]{64}$/);

    const badCiphertext = run(
      "import { decryptSecret } from './lib/secure-store.ts'; decryptSecret('enc:v1:not-base64');",
      { SHIBA_SECRET_KEY: 'ab'.repeat(32) },
    );
    assert.notEqual(badCiphertext.status, 0, 'invalid ciphertext fails closed');
    assert.match(`${badCiphertext.stdout}\n${badCiphertext.stderr}`, /could not be decrypted/);

    const roundTrip = run(
      "import { encryptSecret, decryptSecret } from './lib/secure-store.ts'; const sealed = encryptSecret('secret'); if (decryptSecret(sealed) !== 'secret') process.exit(2);",
      { SHIBA_SECRET_KEY: 'cd'.repeat(32) },
    );
    assert.equal(roundTrip.status, 0, roundTrip.stderr);
    console.log('secure-store: 7 passed, 0 failed');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('secure-store: failed', error);
  process.exit(1);
});
