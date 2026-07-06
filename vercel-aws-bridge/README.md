# Vercel Cron → AWS Lambda Bridge

Example showing how to trigger an AWS Lambda from a Vercel Cron job using IAM-signed requests for security.

## Files
- `api/cron-bridge.ts` — Vercel serverless function (cron handler)
- `lambda/handler.js` — Example AWS Lambda
- `scripts/invoke-lambda.js` — Local test helper (Node)

## Setup
1. Deploy Lambda with IAM role allowing invocation from Vercel (or use API Gateway + sigv4).
2. Add `VERCEL_CRON_SECRET` and AWS creds to Vercel env.
3. Add to `vercel.json`:
   ```json
   {
     "crons": [{ "path": "/api/cron-bridge", "schedule": "0 * * * *" }]
   }
   ```
4. Lambda receives `{ source: "vercel-cron", timestamp }` payload.