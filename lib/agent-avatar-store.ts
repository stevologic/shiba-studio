import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { imagineAvatarRef, parseImagineAvatarId } from './agent-avatars';
import { dataDir } from './data-paths';

const AVATAR_DIR = () => dataDir('agent-avatars');
const MAX_BYTES = 4 * 1024 * 1024;

function avatarPath(fileId: string): string {
  return path.join(AVATAR_DIR(), `${fileId}.jpg`);
}

export function imagineAvatarFilePath(avatarId: string): string | null {
  const fileId = parseImagineAvatarId(avatarId);
  return fileId ? avatarPath(fileId) : null;
}

export async function saveImagineAvatar(bytes: Buffer, mimeType?: string): Promise<{
  avatarId: string;
  fileId: string;
  url: string;
}> {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    throw new Error('Generated avatar was empty');
  }
  if (bytes.length > MAX_BYTES) {
    throw new Error('Generated avatar is too large');
  }
  const mime = String(mimeType || '').toLowerCase();
  if (mime && !mime.includes('jpeg') && !mime.includes('jpg') && !mime.includes('png') && !mime.includes('webp')) {
    throw new Error('Generated avatar must be an image');
  }
  const fileId = randomUUID();
  const dir = AVATAR_DIR();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(avatarPath(fileId), bytes);
  const avatarId = imagineAvatarRef(fileId);
  return { avatarId, fileId, url: `/api/agent-avatars/${fileId}` };
}

export async function readImagineAvatar(fileId: string): Promise<{
  absPath: string;
  bytes: Buffer;
  name: string;
} | null> {
  const parsed = parseImagineAvatarId(`imagine:${fileId}`);
  if (!parsed) return null;
  const absPath = avatarPath(parsed);
  const bytes = await fs.readFile(absPath).catch(() => null);
  if (!bytes) return null;
  return { absPath, bytes, name: `${parsed}.jpg` };
}
