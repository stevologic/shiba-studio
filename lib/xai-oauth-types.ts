/** Client-safe OAuth status shapes (no secrets). */

export type CloudAuthMode = 'api_key' | 'oauth';

export interface XaiOAuthPublicStatus {
  connected: boolean;
  expired: boolean;
  email?: string;
  displayName?: string;
  userId?: string;
  expiresAt?: string;
  connectedAt?: string;
  error?: string;
}

export interface CloudAuthFlags {
  hasKey: boolean;
  hasOAuth: boolean;
  hasCloudAuth: boolean;
  cloudAuthMode: CloudAuthMode;
  activeCloudSource: 'api_key' | 'oauth' | null;
}