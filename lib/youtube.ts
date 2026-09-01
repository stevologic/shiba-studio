/** YouTube id / URL / privacy helpers. API calls live in integrations.ts. */

const VIDEO_ID_RE = /^[a-zA-Z0-9_-]{11}$/;
const PLAYLIST_ID_RE = /^[a-zA-Z0-9_-]{10,64}$/;

export type YoutubePrivacy = 'private' | 'unlisted' | 'public';

export function parseYoutubeVideoId(raw: string): string {
  const value = String(raw || '').trim();
  if (VIDEO_ID_RE.test(value)) return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Invalid YouTube video id');
  }
  const host = url.hostname.replace(/^www\./, '');
  if (host === 'youtu.be') {
    const id = url.pathname.split('/').filter(Boolean)[0] || '';
    if (VIDEO_ID_RE.test(id)) return id;
  }
  const fromQuery = url.searchParams.get('v') || '';
  if (VIDEO_ID_RE.test(fromQuery)) return fromQuery;
  const parts = url.pathname.split('/').filter(Boolean);
  for (let i = 0; i < parts.length - 1; i++) {
    if ((parts[i] === 'shorts' || parts[i] === 'embed' || parts[i] === 'live') && VIDEO_ID_RE.test(parts[i + 1])) {
      return parts[i + 1];
    }
  }
  throw new Error('Invalid YouTube video id');
}

export function assertYoutubePlaylistId(raw: string): string {
  const value = String(raw || '').trim();
  if (!PLAYLIST_ID_RE.test(value)) throw new Error('Invalid YouTube playlist id');
  return value;
}

export function parseYoutubePrivacy(raw: unknown, fallback: YoutubePrivacy = 'unlisted'): YoutubePrivacy {
  const value = String(raw || '').trim().toLowerCase();
  if (value === 'private' || value === 'unlisted' || value === 'public') return value;
  return fallback;
}

const VIDEO_EXT = new Set(['.mp4', '.mov', '.webm', '.avi', '.mkv', '.m4v', '.mpeg', '.mpg']);

export function assertYoutubeUploadPath(filePath: string): string {
  const value = String(filePath || '').trim();
  if (!value || value.includes('\0')) throw new Error('A video file path is required');
  const dot = value.lastIndexOf('.');
  const ext = dot >= 0 ? value.slice(dot).toLowerCase() : '';
  if (!VIDEO_EXT.has(ext)) throw new Error('YouTube upload requires a video file (mp4, mov, webm, mkv, …)');
  return value;
}

export function youtubeWatchUrl(id: string): string {
  return `https://www.youtube.com/watch?v=${id}`;
}
