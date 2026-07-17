import { NextRequest, NextResponse } from 'next/server';
import { audit } from '@/lib/audit-log';
import { loadConfig, saveConfig } from '@/lib/persistence';
import { isMaskedSecret } from '@/lib/secret-mask';
import {
  clearSiteTrafficCache,
  getSiteTrafficSnapshot,
  installGoatCounterTracker,
  removeInstalledGoatCounterTracker,
  SiteTrafficServiceError,
  validateGoatCounterCredentials,
  withSiteTrafficMutationLock,
} from '@/lib/site-traffic';
import { SITE_TRAFFIC_PAGE_FILES, type TrackerPatchResult } from '@/lib/site-traffic-types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' };
const MAX_BODY_BYTES = 16_384;

function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: NO_STORE_HEADERS });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function publicError(error: unknown) {
  if (error instanceof SiteTrafficServiceError) {
    return json({ ok: false, error: error.message, code: error.code }, error.status);
  }
  if (error instanceof Error && error.message === 'days must be 7, 30, or 90.') {
    return json({ ok: false, error: error.message, code: 'INVALID_TRAFFIC_RANGE' }, 400);
  }
  console.error('[shiba-studio] Site traffic request failed', error);
  return json(
    {
      ok: false,
      error: 'The traffic monitor could not complete the request.',
      code: 'SITE_TRAFFIC_INTERNAL_ERROR',
    },
    500,
  );
}

async function requestBody(req: NextRequest): Promise<Record<string, unknown>> {
  const contentLength = Number(req.headers.get('content-length') || 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    throw new SiteTrafficServiceError(
      'Traffic settings request is too large.',
      413,
      'REQUEST_TOO_LARGE',
    );
  }

  const reader = req.body?.getReader();
  if (!reader) {
    throw new SiteTrafficServiceError(
      'A JSON object request body is required.',
      400,
      'INVALID_JSON_BODY',
    );
  }
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        throw new SiteTrafficServiceError(
          'Traffic settings request is too large.',
          413,
          'REQUEST_TOO_LARGE',
        );
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    if (error instanceof SiteTrafficServiceError) throw error;
    throw new SiteTrafficServiceError(
      'A JSON object request body is required.',
      400,
      'INVALID_JSON_BODY',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (!isRecord(parsed)) {
    throw new SiteTrafficServiceError(
      'A JSON object request body is required.',
      400,
      'INVALID_JSON_BODY',
    );
  }
  return parsed;
}

function missingGitHubResult(operation: 'install' | 'remove'): TrackerPatchResult {
  return {
    ok: false,
    partial: false,
    operation,
    files: SITE_TRAFFIC_PAGE_FILES.map((path) => ({
      path,
      ok: false,
      changed: false,
      status: 'error' as const,
      error: 'Connect GitHub with write access to the gh-pages branch.',
    })),
    ...(operation === 'remove' ? { trackerMayRemain: true } : {}),
  };
}

export async function GET(req: NextRequest) {
  try {
    const config = await loadConfig();
    const snapshot = await getSiteTrafficSnapshot({
      days: req.nextUrl.searchParams.get('days') || undefined,
      refresh: req.nextUrl.searchParams.get('refresh') === '1',
      goatcounter: config.integrations?.goatcounter,
      githubToken: config.integrations?.github?.token,
    });
    return json(snapshot);
  } catch (error) {
    return publicError(error);
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await requestBody(req);
    const action = typeof body.action === 'string' ? body.action : '';

    if (action === 'save') {
      return withSiteTrafficMutationLock(async () => {
        const config = await loadConfig();
        const storedToken = config.integrations?.goatcounter?.apiToken || '';
        const submittedToken = typeof body.apiToken === 'string' ? body.apiToken : '';
        const effectiveToken = isMaskedSecret(submittedToken) ? storedToken : submittedToken;
        const credentials = await validateGoatCounterCredentials(body.siteCode, effectiveToken);
        await saveConfig({ integrations: { goatcounter: credentials } });
        clearSiteTrafficCache();
        audit(
          'integration',
          'GoatCounter site analytics connected',
          `${credentials.siteCode}.goatcounter.com`,
        );
        return json({
          ok: true,
          audience: {
            configured: true,
            connected: true,
            siteCode: credentials.siteCode,
          },
        });
      });
    }

    if (action === 'install') {
      return withSiteTrafficMutationLock(async () => {
        const config = await loadConfig();
        const goatcounter = config.integrations?.goatcounter;
        if (!goatcounter?.siteCode || !goatcounter.apiToken) {
          throw new SiteTrafficServiceError(
            'Connect GoatCounter before installing the tracker.',
            409,
            'GOATCOUNTER_NOT_CONFIGURED',
          );
        }
        const githubToken = config.integrations?.github?.token;
        if (!githubToken) {
          return json(
            {
              ok: false,
              error: 'Connect GitHub with write access before installing the tracker.',
              code: 'GITHUB_NOT_CONFIGURED',
              result: missingGitHubResult('install'),
            },
            409,
          );
        }
        const result = await installGoatCounterTracker({
          siteCode: goatcounter.siteCode,
          githubToken,
        });
        clearSiteTrafficCache();
        if (!result.ok) {
          const changedFiles = result.files.filter((file) => file.changed);
          if (changedFiles.length > 0) {
            audit(
              'integration',
              'GitHub Pages traffic tracker partially installed',
              changedFiles.map((file) => `${file.path}: ${file.status}`).join(', '),
            );
          }
          return json(
            {
              ok: false,
              error: 'The tracker could not be installed on every GitHub Pages document.',
              code: 'TRACKER_INSTALL_INCOMPLETE',
              result,
            },
            409,
          );
        }
        audit(
          'integration',
          'GitHub Pages traffic tracker installed',
          result.files.map((file) => `${file.path}: ${file.status}`).join(', '),
        );
        return json({ ok: true, result });
      });
    }

    if (action === 'disconnect') {
      return withSiteTrafficMutationLock(async () => {
        const config = await loadConfig();
        const githubToken = config.integrations?.github?.token;
        if (!githubToken) {
          const result = missingGitHubResult('remove');
          return json(
            {
              ok: false,
              error: 'Connect GitHub with write access so the published tracker can be removed safely. GoatCounter remains connected.',
              code: 'GITHUB_NOT_CONFIGURED',
              trackerMayRemain: true,
              result,
            },
            409,
          );
        }
        const result = await removeInstalledGoatCounterTracker({ githubToken });
        clearSiteTrafficCache();
        if (!result.ok) {
          const changedFiles = result.files.filter((file) => file.changed);
          if (changedFiles.length > 0) {
            audit(
              'integration',
              'GitHub Pages traffic tracker partially removed',
              changedFiles.map((file) => `${file.path}: ${file.status}`).join(', '),
            );
          }
          return json(
            {
              ok: false,
              error: 'The published tracker could not be removed safely. GoatCounter remains connected so you can retry.',
              code: 'TRACKER_REMOVE_INCOMPLETE',
              trackerMayRemain: true,
              result,
            },
            409,
          );
        }
        await saveConfig({ integrations: { goatcounter: undefined } });
        clearSiteTrafficCache();
        audit(
          'integration',
          'GoatCounter site analytics disconnected',
          result.files.map((file) => `${file.path}: ${file.status}`).join(', '),
        );
        return json({ ok: true, result });
      });
    }

    if (action === 'forget') {
      return withSiteTrafficMutationLock(async () => {
        await saveConfig({ integrations: { goatcounter: undefined } });
        clearSiteTrafficCache();
        audit(
          'integration',
          'GoatCounter local credential forgotten',
          'The published GitHub Pages tracker was not changed.',
        );
        return json({
          ok: true,
          trackerMayRemain: true,
          warning: 'The local credential was removed. A published tracker, if present, was not changed.',
        });
      });
    }

    throw new SiteTrafficServiceError(
      `Unsupported traffic action "${action || '(missing)'}".`,
      400,
      'UNKNOWN_TRAFFIC_ACTION',
    );
  } catch (error) {
    return publicError(error);
  }
}
