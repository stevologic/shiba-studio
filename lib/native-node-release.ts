import { createHash, createPublicKey, verify } from 'node:crypto';
import { NativeNodeError, NATIVE_NODE_PROTOCOL_VERSION } from './native-nodes';

const RELEASE_PUBLIC_JWK = {
  kty: 'RSA',
  n: 'gqsQqqDEpMuHiE1MBNysssZ3cHgV6Hrztkxfr35ekDu17avH_9y-1um0qbDwWgESlwulxoS1SnwNNFQ1wm-wyYvAf4gauZ36-YXvoxUg8k4-DbPylXycH6UFi_XupMX6r_ubC1rmDXO0rN7EGxESWJlTWYQP3WJqGwQEBmhk_8tCV2cVhz7itfRzyFdQDyY9To-pTyV8_70Lql6L0WlqG-kQtEtiIpXCKh2QQmyRHt_QEbT25-efNlPn4TNc1aNfnTwUyqJzRl_gwdDc9F4xdpqtwN43e8U9kdU_8sPs4iYZ6eDg3UKsvgV4v4IOtlHgdEEMkjplxEJu1O71AgvnkYKX3c_CaTBnf8rs9kIqSEeJan4wgVDEB6u9pw70hYZmta74ckII9LLYtNC2r-axCUnna8EBJdy-dKrF-3JBx_DPyLh3tPdtrrVsiKlURxStNNj1dF2pb69SZWZBwZvATh4crK9fu8kv3XWQuFUsMj18ADxGAJSPxOCRk7i8DXYd',
  e: 'AQAB',
} as const;

export const NATIVE_NODE_RELEASE_FILES = [
  'shiba-node-helper.ps1',
  'shiba-node-helper-core.ps1',
  'release-manifest.json',
  'release-manifest.sig',
  'release-public.json',
] as const;

interface SignedReleaseManifest {
  releaseId?: unknown;
  protocolVersion?: unknown;
  platforms?: unknown;
  files?: Record<string, { sha256?: unknown; bytes?: unknown }>;
}

export function verifyNativeNodeRelease(payloadBase64: string, signatureBase64: string): {
  releaseId: string;
  digest: string;
} {
  let payload: Buffer;
  let signature: Buffer;
  try {
    payload = Buffer.from(String(payloadBase64 || ''), 'base64');
    signature = Buffer.from(String(signatureBase64 || ''), 'base64');
  } catch { throw new NativeNodeError('Malformed native helper release proof', 401); }
  if (!payload.length || payload.length > 32_000 || signature.length < 256) {
    throw new NativeNodeError('Malformed native helper release proof', 401);
  }
  const key = createPublicKey({ key: RELEASE_PUBLIC_JWK, format: 'jwk' });
  if (!verify('RSA-SHA256', payload, key, signature)) {
    throw new NativeNodeError('Native helper release signature is invalid', 401);
  }
  let manifest: SignedReleaseManifest;
  try { manifest = JSON.parse(payload.toString('utf8')) as SignedReleaseManifest; }
  catch { throw new NativeNodeError('Native helper release manifest is invalid', 401); }
  if (
    manifest.releaseId !== 'shiba-native-windows-1.0.0'
    || manifest.protocolVersion !== NATIVE_NODE_PROTOCOL_VERSION
    || !Array.isArray(manifest.platforms)
    || !manifest.platforms.includes('windows')
  ) throw new NativeNodeError('Native helper release is not supported', 409);
  for (const name of ['shiba-node-helper.ps1', 'shiba-node-helper-core.ps1']) {
    const entry = manifest.files?.[name];
    if (!entry || !/^[a-f0-9]{64}$/.test(String(entry.sha256)) || !Number.isSafeInteger(entry.bytes) || Number(entry.bytes) < 100) {
      throw new NativeNodeError('Native helper release manifest is incomplete', 401);
    }
  }
  return {
    releaseId: manifest.releaseId,
    digest: createHash('sha256').update(payload).digest('hex'),
  };
}
