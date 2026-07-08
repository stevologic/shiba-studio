// Google Drive OAuth via the same popup + self-closing hand-back pattern as X.
// Google has no public client we can borrow, so the user provides their own
// OAuth client (created once in Google Cloud Console) — client id + secret are
// stored encrypted.
//
// Unlike X, Google uses a FIXED redirect on the app's own origin
// (`/api/google-oauth/callback`) rather than a random-port loopback. That URL
// works for BOTH Google client types: "Desktop app" (localhost is a permitted
// loopback) and "Web application" (the user registers this exact URL). A
// random port only works for Desktop clients and is the usual cause of
// "redirect_uri does not match".

import { loadConfig, saveConfig } from './persistence';

const DRIVE_SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/userinfo.email',
];

/** The redirect URI Google must send the user back to. Fixed per app origin. */
export function googleRedirectUri(appOrigin: string): string {
  return `${appOrigin.replace(/\/$/, '')}/api/google-oauth/callback`;
}

async function driveCreds() {
  const cfg = await loadConfig();
  return cfg.integrations?.googledrive || {};
}

/**
 * The OAuth client to use: a bundled default from the environment
 * (GOOGLE_OAUTH_CLIENT_ID/SECRET) if present — so users just sign in with zero
 * setup — otherwise the per-user client pasted in Advanced.
 */
export function bundledGoogleClient(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  if (clientId && clientSecret) return { clientId, clientSecret };
  return null;
}

async function resolveGoogleClient(): Promise<{ clientId: string; clientSecret: string } | null> {
  // A user's OWN client wins — their quota, their choice — so a bundled default
  // never hijacks a per-user client. The env default is only the fallback for
  // users who haven't set one.
  const creds = await driveCreds();
  const clientId = creds.clientId?.trim();
  const clientSecret = creds.clientSecret?.trim();
  if (clientId && clientSecret) return { clientId, clientSecret };
  return bundledGoogleClient();
}

/** Whether sign-in is available at all (bundled default or a per-user client). */
export async function isGoogleClientReady(): Promise<boolean> {
  return (await resolveGoogleClient()) !== null;
}

/** Persist a patch onto integrations.googledrive without disturbing the rest. */
async function patchDriveCreds(patch: Record<string, string | undefined>): Promise<void> {
  const cfg = await loadConfig();
  const integrations = { ...(cfg.integrations || {}) };
  integrations.googledrive = { ...(integrations.googledrive || {}), ...patch };
  await saveConfig({ integrations });
}

/** Begin sign-in: build Google's consent URL for the app-origin redirect. */
export async function startGoogleDriveOAuth(appOrigin: string): Promise<{ authorizeUrl: string; redirectUri: string }> {
  const client = await resolveGoogleClient();
  if (!client) {
    throw new Error('No Google OAuth client configured — set GOOGLE_OAUTH_CLIENT_ID/SECRET, or add a client under Advanced.');
  }
  const { clientId, clientSecret } = client;

  const { google } = await import('googleapis');
  const redirectUri = googleRedirectUri(appOrigin);
  const oauth2 = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  const authorizeUrl = oauth2.generateAuthUrl({
    access_type: 'offline',      // request a refresh token
    prompt: 'consent',           // force refresh_token even on repeat sign-ins
    scope: DRIVE_SCOPES,
    include_granted_scopes: true,
  });
  return { authorizeUrl, redirectUri };
}

/**
 * Exchange the authorization code (called by the callback route). The redirect
 * URI must byte-match the one used to start, so it is rebuilt from the same
 * origin. Returns the connected email on success.
 */
export async function exchangeGoogleDriveCode(code: string, appOrigin: string): Promise<{ email?: string }> {
  const client = await resolveGoogleClient();
  if (!client) throw new Error('Google OAuth client is not configured');
  const { clientId, clientSecret } = client;
  const creds = await driveCreds();

  const { google } = await import('googleapis');
  const redirectUri = googleRedirectUri(appOrigin);
  const oauth2 = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  const { tokens } = await oauth2.getToken(code);
  if (!tokens.access_token) throw new Error('Google returned no access token');
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
    refreshToken: tokens.refresh_token || creds.refreshToken,
    tokenExpiry: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : undefined,
    email,
  });
  return { email };
}

/** A valid Drive access token, refreshing via the refresh token if expired. */
export async function getValidDriveToken(): Promise<string | null> {
  const creds = await driveCreds();
  if (!creds.accessToken && !creds.refreshToken) return null;

  const notExpired = creds.tokenExpiry ? new Date(creds.tokenExpiry).getTime() - 60_000 > Date.now() : false;
  if (creds.accessToken && notExpired) return creds.accessToken;

  const client = await resolveGoogleClient();
  if (creds.refreshToken && client) {
    try {
      const { google } = await import('googleapis');
      const oauth2 = new google.auth.OAuth2(client.clientId, client.clientSecret);
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
