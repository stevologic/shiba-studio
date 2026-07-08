// Google Drive OAuth via the same popup + 127.0.0.1 loopback pattern as X.
// Google has no public client we can borrow, so the user provides their own
// OAuth client (created once in Google Cloud Console) — client id + secret are
// stored encrypted. Sign-in then opens a popup to Google's consent screen,
// captures the code on a disposable loopback listener, exchanges it for
// access + refresh tokens, stores them, and closes the popup.

import { loadConfig, saveConfig } from './persistence';
import { startOAuthLoopback } from './oauth-loopback';

const DRIVE_SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/userinfo.email',
];

interface PendingGoogle {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  createdAt: number;
}

// Kept in module memory only for the ~seconds between authorize and callback.
let pendingGoogle: PendingGoogle | null = null;

async function driveCreds() {
  const cfg = await loadConfig();
  return cfg.integrations?.googledrive || {};
}

/** Persist a patch onto integrations.googledrive without disturbing the rest. */
async function patchDriveCreds(patch: Record<string, string | undefined>): Promise<void> {
  const cfg = await loadConfig();
  const integrations = { ...(cfg.integrations || {}) };
  integrations.googledrive = { ...(integrations.googledrive || {}), ...patch };
  await saveConfig({ integrations });
}

/** Begin sign-in: bind a loopback listener and build Google's consent URL. */
export async function startGoogleDriveOAuth(appOrigin: string): Promise<{ authorizeUrl: string }> {
  const creds = await driveCreds();
  const clientId = creds.clientId?.trim();
  const clientSecret = creds.clientSecret?.trim();
  if (!clientId || !clientSecret) {
    throw new Error('Add your Google OAuth Client ID and Secret first (create one in Google Cloud Console → Credentials → OAuth client → Desktop app).');
  }

  const { google } = await import('googleapis');

  const { redirectUri } = await startOAuthLoopback(appOrigin, async ({ code, error, errorDescription }) => {
    if (error) return { ok: false, message: errorDescription || error };
    if (!code) return { ok: false, message: 'Missing authorization code' };
    if (!pendingGoogle) return { ok: false, message: 'Sign-in expired — start again' };
    try {
      const oauth2 = new google.auth.OAuth2(pendingGoogle.clientId, pendingGoogle.clientSecret, pendingGoogle.redirectUri);
      const { tokens } = await oauth2.getToken(code);
      if (!tokens.access_token) return { ok: false, message: 'Google returned no access token' };
      oauth2.setCredentials(tokens);

      let email: string | undefined;
      try {
        const oauth2Api = google.oauth2({ version: 'v2', auth: oauth2 });
        const info = await oauth2Api.userinfo.get();
        email = info.data.email || undefined;
      } catch { /* email is best-effort */ }

      await patchDriveCreds({
        accessToken: tokens.access_token,
        // Google only returns refresh_token on the first consent (prompt=consent
        // forces it); keep any existing one if this response omits it.
        refreshToken: tokens.refresh_token || (await driveCreds()).refreshToken,
        tokenExpiry: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : undefined,
        email,
      });
      pendingGoogle = null;
      return { ok: true };
    } catch (e: unknown) {
      return { ok: false, message: e instanceof Error ? e.message : 'Google token exchange failed' };
    }
  }, 'shiba-drive');

  pendingGoogle = { clientId, clientSecret, redirectUri, createdAt: Date.now() };

  const oauth2 = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  const authorizeUrl = oauth2.generateAuthUrl({
    access_type: 'offline',      // request a refresh token
    prompt: 'consent',           // force refresh_token even on repeat sign-ins
    scope: DRIVE_SCOPES,
  });
  return { authorizeUrl };
}

/** A valid Drive access token, refreshing via the refresh token if expired. */
export async function getValidDriveToken(): Promise<string | null> {
  const creds = await driveCreds();
  if (!creds.accessToken && !creds.refreshToken) return null;

  const notExpired = creds.tokenExpiry ? new Date(creds.tokenExpiry).getTime() - 60_000 > Date.now() : false;
  if (creds.accessToken && notExpired) return creds.accessToken;

  if (creds.refreshToken && creds.clientId && creds.clientSecret) {
    try {
      const { google } = await import('googleapis');
      const oauth2 = new google.auth.OAuth2(creds.clientId, creds.clientSecret);
      oauth2.setCredentials({ refresh_token: creds.refreshToken });
      const { credentials } = await oauth2.refreshAccessToken();
      if (credentials.access_token) {
        await patchDriveCreds({
          accessToken: credentials.access_token,
          tokenExpiry: credentials.expiry_date ? new Date(credentials.expiry_date).toISOString() : undefined,
        });
        return credentials.access_token;
      }
    } catch {
      /* fall through — stale access token is the last resort */
    }
  }
  return creds.accessToken || null;
}

/** Disconnect: drop the captured tokens (client id/secret are kept for re-auth). */
export async function disconnectGoogleDrive(): Promise<void> {
  await patchDriveCreds({ accessToken: undefined, refreshToken: undefined, tokenExpiry: undefined, email: undefined });
}
