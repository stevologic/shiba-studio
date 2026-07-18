export const SITE_TRAFFIC_URL = 'https://shiba-studio.io';
export const SITE_TRAFFIC_REPOSITORY = 'stevologic/shiba-studio';

export interface TrafficDailyPoint {
  date: string;
  count: number;
  visits?: number;
  uniques?: number;
}

export interface TrafficCountRow {
  name?: string;
  label?: string;
  title?: string;
  path?: string;
  count: number;
  uniques?: number;
}

export interface RepositoryTrafficMetric {
  count: number;
  uniques: number;
  daily: TrafficDailyPoint[];
}

export interface TrafficSourceError {
  source: string;
  message: string;
}

export interface RepositoryTraffic {
  configured: boolean;
  connected: boolean;
  partial: boolean;
  scope: 'repository';
  repository: typeof SITE_TRAFFIC_REPOSITORY;
  rangeLabel: 'Rolling 14 days · UTC';
  views?: RepositoryTrafficMetric;
  clones?: RepositoryTrafficMetric;
  referrers: TrafficCountRow[];
  paths: TrafficCountRow[];
  errors: TrafficSourceError[];
  error?: string;
}

export interface SiteHealth {
  ok: boolean;
  url: typeof SITE_TRAFFIC_URL;
  status?: number;
  latencyMs: number;
  checkedAt: string;
  error?: string;
}

export interface PagesLatestBuild {
  status: string;
  updatedAt?: string;
  createdAt?: string;
  commit?: string;
  durationMs?: number;
  error?: string;
}

export interface PagesCertificate {
  state: string;
  description?: string;
  expiresAt?: string;
  domains: string[];
}

export interface PagesStatus {
  configured: boolean;
  connected: boolean;
  partial: boolean;
  status?: string;
  htmlUrl: string;
  cname?: string;
  httpsEnforced?: boolean;
  buildType?: string;
  source?: {
    branch?: string;
    path?: string;
  };
  latestBuild?: PagesLatestBuild;
  certificate?: PagesCertificate;
  errors: TrafficSourceError[];
  error?: string;
}

export interface SiteTrafficSnapshot {
  ok: true;
  siteUrl: typeof SITE_TRAFFIC_URL;
  repositoryName: typeof SITE_TRAFFIC_REPOSITORY;
  generatedAt: string;
  stale: boolean;
  repository: RepositoryTraffic;
  siteHealth: SiteHealth;
  pages: PagesStatus;
}
