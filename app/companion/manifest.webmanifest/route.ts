const manifest = {
  id: '/companion',
  name: 'Shiba Companion',
  short_name: 'Shiba',
  description: 'Scoped remote supervision for Shiba Studio.',
  start_url: '/companion',
  scope: '/companion',
  display: 'standalone',
  background_color: '#0e0e0c',
  theme_color: '#171613',
  icons: [
    { src: '/shiba-logo.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
    { src: '/shiba-logo.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
  ],
};

export function GET() {
  return Response.json(manifest, {
    headers: {
      'Content-Type': 'application/manifest+json',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
