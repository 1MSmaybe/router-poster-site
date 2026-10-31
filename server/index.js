'use strict';

// Router Poster server: TikTok OAuth code exchange and confirmed video publishing.
// No dependencies, needs Node 18+ (global fetch).
//
// Required env:
//   TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET, ADMIN_KEY
// Optional env:
//   PORT (default 3000), TIKTOK_REDIRECT_URI, PENDING_TTL_MS (default 15 min)

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY;
const CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET;
const ADMIN_KEY = process.env.ADMIN_KEY;
const PORT = Number(process.env.PORT || 3000);
const REDIRECT_URI =
  process.env.TIKTOK_REDIRECT_URI ||
  'https://1msmaybe.github.io/router-poster-site/callback.html';
const PENDING_TTL_MS = Number(process.env.PENDING_TTL_MS || 15 * 60 * 1000);

const SCOPES = 'user.info.basic,video.upload,video.publish';
const TIKTOK_AUTH_URL = 'https://www.tiktok.com/v2/auth/authorize/';
const TIKTOK_TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';
const TIKTOK_INIT_URL = 'https://open.tiktokapis.com/v2/post/publish/video/init/';
const TIKTOK_STATUS_URL = 'https://open.tiktokapis.com/v2/post/publish/status/fetch/';

const DATA_DIR = path.join(__dirname, 'data');
const TOKEN_FILE = path.join(DATA_DIR, 'tokens.json');

if (!CLIENT_KEY || !CLIENT_SECRET || !ADMIN_KEY) {
  console.error('Set TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET and ADMIN_KEY first.');
  process.exit(1);
}

// In-memory state: OAuth states and pending (not yet sent) publish drafts.
const oauthStates = new Map();
const pendingPosts = new Map();

function loadTokens() {
  try {
    return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function saveTokens(tokens) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 64 * 1024) {
        reject(new Error('Body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function isAuthorized(url, req) {
  return safeEqual(req.headers['x-admin-key'], ADMIN_KEY) || safeEqual(url.searchParams.get('key'), ADMIN_KEY);
}

async function tiktokTokenRequest(params) {
  const body = new URLSearchParams({ client_key: CLIENT_KEY, client_secret: CLIENT_SECRET, ...params });
  const r = await fetch(TIKTOK_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await r.json();
  if (!r.ok || data.error) {
    throw new Error(`TikTok token error: ${data.error || r.status} ${data.error_description || ''}`.trim());
  }
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    open_id: data.open_id,
    scope: data.scope,
    expires_at: Date.now() + data.expires_in * 1000,
    refresh_expires_at: Date.now() + data.refresh_expires_in * 1000,
  };
}

async function getAccessToken() {
  const tokens = loadTokens();
  if (!tokens) throw new Error('Not authorized yet. Open /login first.');
  if (tokens.expires_at - Date.now() > 60 * 1000) return tokens.access_token;
  if (tokens.refresh_expires_at <= Date.now()) throw new Error('Refresh token expired. Authorize again via /login.');
  const fresh = await tiktokTokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
  saveTokens(fresh);
  return fresh.access_token;
}

async function tiktokPost(url, payload, accessToken) {
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8',
    },
    body: JSON.stringify(payload),
  });
  const data = await r.json();
  if (!r.ok || (data.error && data.error.code !== 'ok')) {
    throw new Error(`TikTok API error: ${JSON.stringify(data.error || data)}`);
  }
  return data.data;
}

function cleanupPending() {
  const now = Date.now();
  for (const [id, draft] of pendingPosts) {
    if (now - draft.created_at > PENDING_TTL_MS) pendingPosts.delete(id);
  }
}

function isValidVideoUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:';
  } catch {
    return false;
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      return send(res, 200, { ok: true });
    }

    if (!isAuthorized(url, req)) {
      return send(res, 401, { error: 'Unauthorized' });
    }

    // Start OAuth: open this URL in a browser. TikTok then redirects to callback.html,
    // which shows the code to copy into POST /exchange.
    if (req.method === 'GET' && url.pathname === '/login') {
      const state = crypto.randomBytes(16).toString('hex');
      oauthStates.set(state, Date.now());
      const authUrl = new URL(TIKTOK_AUTH_URL);
      authUrl.search = new URLSearchParams({
        client_key: CLIENT_KEY,
        scope: SCOPES,
        response_type: 'code',
        redirect_uri: REDIRECT_URI,
        state,
      }).toString();
      res.writeHead(302, { Location: authUrl.toString() });
      return res.end();
    }

    // Exchange the one-time code from callback.html for tokens.
    if (req.method === 'POST' && url.pathname === '/exchange') {
      const { code } = await readJson(req);
      if (!code || typeof code !== 'string') return send(res, 400, { error: 'code is required' });
      const tokens = await tiktokTokenRequest({
        code,
        grant_type: 'authorization_code',
        redirect_uri: REDIRECT_URI,
      });
      saveTokens(tokens);
      return send(res, 200, { ok: true, open_id: tokens.open_id, scope: tokens.scope });
    }

    // Step 1: create a draft. Nothing is sent to TikTok here.
    if (req.method === 'POST' && url.pathname === '/publish/prepare') {
      cleanupPending();
      const { videoUrl, title } = await readJson(req);
      if (!isValidVideoUrl(videoUrl)) return send(res, 400, { error: 'videoUrl must be an https URL' });
      if (!title || typeof title !== 'string' || title.length > 2200) {
        return send(res, 400, { error: 'title is required (max 2200 chars)' });
      }
      const id = crypto.randomBytes(12).toString('hex');
      // Sandbox/unaudited apps may only publish as SELF_ONLY.
      const draft = { videoUrl, title, privacy_level: 'SELF_ONLY', created_at: Date.now() };
      pendingPosts.set(id, draft);
      return send(res, 200, { draft_id: id, videoUrl, title, privacy_level: draft.privacy_level, expires_in_s: PENDING_TTL_MS / 1000 });
    }

    // Step 2: send the confirmed draft to TikTok.
    if (req.method === 'POST' && url.pathname === '/publish/confirm') {
      cleanupPending();
      const { draft_id } = await readJson(req);
      const draft = pendingPosts.get(draft_id);
      if (!draft) return send(res, 404, { error: 'Draft not found or expired. Prepare it again.' });
      pendingPosts.delete(draft_id);
      const accessToken = await getAccessToken();
      const data = await tiktokPost(
        TIKTOK_INIT_URL,
        {
          post_info: {
            title: draft.title,
            privacy_level: draft.privacy_level,
            disable_duet: false,
            disable_comment: false,
            disable_stitch: false,
          },
          source_info: { source: 'PULL_FROM_URL', video_url: draft.videoUrl },
        },
        accessToken,
      );
      return send(res, 200, { publish_id: data.publish_id });
    }

    // Check publishing status.
    if (req.method === 'GET' && url.pathname === '/publish/status') {
      const publishId = url.searchParams.get('publish_id');
      if (!publishId) return send(res, 400, { error: 'publish_id is required' });
      const accessToken = await getAccessToken();
      const data = await tiktokPost(TIKTOK_STATUS_URL, { publish_id: publishId }, accessToken);
      return send(res, 200, data);
    }

    return send(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error(err);
    return send(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`Router Poster server on port ${PORT}`);
});
