# Shiba Reddit Devvit bridge

This server-only Devvit app lets a local Shiba Studio instance read posts and
submit text or link posts in the subreddit where the app is installed. Reddit
handles the Reddit API credentials; Shiba calls the three narrowly scoped
`/external/shiba/*` routes with a managed Devvit app token.

Important limits:

- Reddit currently gates External Endpoints behind limited access. Request
  access before expecting this bridge to accept external traffic.
- Managed-token requests run as the Devvit app account, not as your personal
  Reddit account.
- Every operation is restricted to the subreddit installation represented by
  the endpoint hostname. This is not a home-feed or arbitrary-subreddit proxy.
- A managed token is global across the app's installations. Keep the app and
  token personal to this Shiba installation; never ship or share the token.

## Set up

1. Create a Devvit app at <https://developers.reddit.com/new> and request
   External Endpoints access from the link in Reddit's External Endpoints docs.
2. Replace `name` in `devvit.json` with the app slug Reddit assigned if it is
   different.
3. Run `npm install`, `npm run login`, and `npm run dev` to playtest in a small
   subreddit you moderate.
4. Run `npm run deploy`, then install the uploaded app in the community Shiba
   should access. Publish/review it if Reddit requires that for the target
   community.
5. In the app's Developer Settings, create a managed App Token. Copy it once.
6. In Shiba's Reddit integration card, enter the installation's external
   origin, for example
   `https://your-app-abc123-external.devvit.net`, plus the `devvit_at_...`
   managed token. Save and test the connection.

Do not commit a token or paste it into `devvit.json`. Shiba encrypts the token
in its local credential store and sends it only in the Authorization header to
the configured `*-external.devvit.net` origin.

## Verify locally

Run `npm ci` and `npm run verify` from this directory. Verification type-checks
the bridge, exercises the HTTP handlers with an in-memory Devvit client, and
produces the same server bundle uploaded by the deploy command.

Official references:

- <https://developers.reddit.com/docs/capabilities/server/external-endpoints>
- <https://developers.reddit.com/docs/capabilities/server/reddit-api>
- <https://developers.reddit.com/docs/capabilities/devvit-web/devvit_web_overview>
