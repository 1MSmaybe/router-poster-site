# Router Poster server

Node server for TikTok login and confirmed video publishing. No dependencies. Needs Node 18+.

## Setup

```bash
cd server
export TIKTOK_CLIENT_KEY=sbawr474of4ne2fxkv        # from TikTok Developers, Client key
export TIKTOK_CLIENT_SECRET= TtLKJQrRB1bMid4T4k3lIzk6zd04HcHU    # from TikTok Developers, Client secret
export ADMIN_KEY=dhru273hdtbxuk830932jd73   # any long random string, keep it secret
node index.js
```

Optional: `PORT`, `TIKTOK_REDIRECT_URI` (default is the callback.html on GitHub Pages).

Never commit the secrets. Tokens are stored in `server/data/tokens.json`, which is git-ignored.

## Authorize the account (once)

1. Open `http://localhost:3000/login?key=ADMIN_KEY` in a browser.
2. Log in as neiro.lab5 and allow access.
3. TikTok opens callback.html, which shows a code. Copy it.
4. Send it to the server:

```bash
curl -X POST http://localhost:3000/exchange \
  -H "x-admin-key: $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"code":"PASTE_CODE"}'
```

The code works once and only for a few minutes.

## Publish a video (two steps, you confirm)

Videos are pulled from an https URL on a verified domain. Put the file on GitHub Pages or another verified host.

```bash
# 1. Create a draft. Nothing is sent to TikTok yet.
curl -X POST http://localhost:3000/publish/prepare \
  -H "x-admin-key: $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"videoUrl":"https://1msmaybe.github.io/router-poster-site/videos/clip.mp4","title":"My clip"}'

# 2. Review the draft, then confirm it with its draft_id.
curl -X POST http://localhost:3000/publish/confirm \
  -H "x-admin-key: $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"draft_id":"DRAFT_ID"}'

# 3. Check the status with the publish_id from step 2.
curl "http://localhost:3000/publish/status?publish_id=PUBLISH_ID" -H "x-admin-key: $ADMIN_KEY"
```

Drafts expire after 15 minutes. Posts are always `SELF_ONLY` (visible to the account only), which is the only option for unaudited apps.
