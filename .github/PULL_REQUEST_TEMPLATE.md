## What does this PR do?

<!-- One or two sentences. Link the issue it closes, if any. -->

## How was it verified?

- [ ] `npx tsc --noEmit` clean
- [ ] `npm run lint` — no **new** errors
- [ ] `npm test` passes (isolated — won't touch your live data)
- [ ] `npm run build` succeeds
- [ ] Exercised the affected flow in the running app

## Checklist

- [ ] Docs updated (`docs/`, README) if behavior changed
- [ ] No plaintext secrets written or logged
- [ ] No weakening of localhost binding / origin checks (see SECURITY.md)
- [ ] Cross-platform: no Windows/macOS/Linux-only code without a fallback
