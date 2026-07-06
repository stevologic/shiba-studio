/**
 * Centralized SpaceX / X / Grok-xAI visual identity tokens.
 * Importable for unit tests; mirrored to :root CSS variables in globals.css.
 */

export const RETIRED_ACCENT_HEX = ['#3b82f6', '#8b5cf6', '#22d3ee'] as const;

export const THEME_COLORS = {
  bg: '#000000',
  bgElev: '#0a0a0a',
  bgCard: '#111111',
  bgHover: '#1a1a1a',
  border: '#262626',
  borderLight: '#404040',
  text: '#f5f5f5',
  textMuted: '#a3a3a3',
  textDim: '#737373',
  accent: '#ffffff',
  accentHover: '#e5e5e5',
  accent2: '#d4d4d4',
  accent3: '#a3a3a3',
  success: '#22c55e',
  warning: '#eab308',
  error: '#ef4444',
  funOrange: '#f97316',
} as const;

export const THEME_IDENTITY = {
  logoPath: '/shiba-logo.svg',
  logoAlt: 'Shiba Inu logo',
  brandName: 'GrokDesk',
  sidebarTagline: "Powered by El0n's AI",
  footerPoweredBy: 'Grok / xAI',
  heroEyebrow: 'MISSION CONTROL — GROK × xAI',
  heroTitle: 'Aerospace-minimal agent studio.',
  heroSubtitle:
    'Orchestrate Grok agents with SpaceX-grade focus — code, browser control, integrations, and scheduling. Powered exclusively by xAI.',
  metadataTitle: 'GrokDesk • xAI Grok Agent Platform',
  metadataDescription:
    'SpaceX-inspired localhost Grok agent studio. Build, orchestrate, and schedule xAI-powered agents with full computer use.',
} as const;

/** Relative luminance (sRGB); values < 0.15 indicate near-black UI surfaces. */
export function hexLuminance(hex: string): number {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function isNearBlack(hex: string, maxLuminance = 0.15): boolean {
  return hexLuminance(hex) <= maxLuminance;
}

export function usesRetiredAccent(hex: string): boolean {
  return RETIRED_ACCENT_HEX.includes(hex.toLowerCase() as (typeof RETIRED_ACCENT_HEX)[number]);
}

/** CSS custom-property map for injection into :root */
export function themeToCssVars(): Record<string, string> {
  return {
    '--bg': THEME_COLORS.bg,
    '--bg-elev': THEME_COLORS.bgElev,
    '--bg-card': THEME_COLORS.bgCard,
    '--bg-hover': THEME_COLORS.bgHover,
    '--border': THEME_COLORS.border,
    '--border-light': THEME_COLORS.borderLight,
    '--text': THEME_COLORS.text,
    '--text-muted': THEME_COLORS.textMuted,
    '--text-dim': THEME_COLORS.textDim,
    '--accent': THEME_COLORS.accent,
    '--accent-hover': THEME_COLORS.accentHover,
    '--accent-2': THEME_COLORS.accent2,
    '--accent-3': THEME_COLORS.accent3,
    '--success': THEME_COLORS.success,
    '--warning': THEME_COLORS.warning,
    '--error': THEME_COLORS.error,
    '--fun-orange': THEME_COLORS.funOrange,
  };
}