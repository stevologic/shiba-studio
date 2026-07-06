import path from 'path';

/** Project root — scoped for Next.js file tracing (avoids whole-repo NFT warnings). */
export function projectRoot(): string {
  return /* turbopackIgnore: true */ process.cwd();
}

/** App persistence directory under `data/`. */
export function dataDir(...segments: string[]): string {
  return path.join(/* turbopackIgnore: true */ process.cwd(), 'data', ...segments);
}