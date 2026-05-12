# BCR Server Migration to Supabase — Design

**Date**: 2026-05-11
**Status**: Approved (pending user review)
**Owner**: joe

## 1. Background

The current production auth/prediction server at `http://bcra.store` (Spring Boot, in `C:\Users\GME\IdeaProjects\bcrServer`) has expired. The newbcr Tauri client (`C:\Users\GME\IdeaProjects\newbcr`) depends on it for login, session validation (duplicate-login detection), prediction, and version check.

This design replaces it with a free-tier Supabase deployment. ML prediction is **not** required — the client accepts random/stub responses for `/api/v2/predict*`. Only authentication, duplicate-login prevention, and a working predict stub are required.

User base is currently <10 with possible growth. Free-tier headroom and a clean Pro upgrade path ($25/month → 50k MAU + 2M function invocations) are explicit non-goals to engineer-around.

## 2. Goals & Non-Goals

### Goals
- Replace bcra.store with Supabase (Postgres + Edge Functions) preserving the existing HTTP API contract so the Tauri client only changes its base URL.
- Maintain duplicate-login detection semantics (one active session per user, new login kicks the old one).
- Preserve subscription-time (정액 시간) accounting: `users.expiry_at` determines remaining seconds.
- Stub prediction endpoints (`/api/v2/predict`, `/v2/predict/best-room`, `/v2/result`, `/v2/shoe-change`) with random but client-parseable responses.
- Operate under Supabase free tier for current load; have a clear scale-up path.

### Non-Goals
- Self-service registration UI in the client (will be added later if needed).
- Admin web UI for user management. Users are added/extended via Supabase dashboard SQL.
- Real ML prediction. Random Banker/Player/skip is acceptable.
- Migration of existing user accounts. Fresh-start; admin re-inserts the <10 known users by hand.
- Migration of historical `prediction_log_new` data.

## 3. Architecture

```
┌──────────────────────────────────────────────────────────────┐
│ newbcr (Tauri/Rust + React)                                  │
│   prediction_api.rs — base URL is the only required change.  │
│   API request/response shapes remain identical to bcra.store.│
└──────────────────┬───────────────────────────────────────────┘
                   │ HTTPS
                   ▼
┌──────────────────────────────────────────────────────────────┐
│ Supabase Edge Function "api" (Deno/TypeScript)               │
│   Single function with internal router for:                  │
│     POST  /login                                             │
│     GET   /validate-token                                    │
│     POST  /v2/predict                                        │
│     POST  /v2/predict/best-room                              │
│     POST  /v2/result                                         │
│     POST  /v2/shoe-change                                    │
│     POST  /version/check                                     │
│   Libraries: djwt (HS256), bcrypt, @supabase/supabase-js     │
│   Secret:    JWT_SECRET (Supabase secrets)                   │
└──────────────────┬───────────────────────────────────────────┘
                   │ SQL (service_role key)
                   ▼
┌──────────────────────────────────────────────────────────────┐
│ Supabase Postgres                                            │
│   users, active_sessions, notices, app_versions              │
└──────────────────────────────────────────────────────────────┘
```

The Edge Function is deployed as a **single function named `api`** so clients can call `<host>/functions/v1/api/login`, `<host>/functions/v1/api/v2/predict`, etc. This makes the existing path conventions (`/login`, `/v2/predict`) work unchanged with only a base-URL substitution on the client.

## 4. Database Schema

```sql
-- 사용자 마스터
CREATE TABLE users (
  id              BIGSERIAL PRIMARY KEY,
  username        VARCHAR(50) NOT NULL UNIQUE,
  password_hash   VARCHAR(100) NOT NULL,        -- bcrypt
  expiry_at       TIMESTAMPTZ NOT NULL,         -- 정액 시간 만료 시각
  role            VARCHAR(20) NOT NULL DEFAULT 'USER',
  active          BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_users_username ON users(username);

-- 활성 세션 (한 사용자당 1개 = 중복로그인 방지의 기반)
CREATE TABLE active_sessions (
  jti               UUID PRIMARY KEY,           -- JWT의 jti 클레임
  user_id           BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  issued_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at        TIMESTAMPTZ NOT NULL,
  last_validated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_active_sessions_user ON active_sessions(user_id);

-- 공지 (로그인 후 NoticePopup용)
CREATE TABLE notices (
  id          BIGSERIAL PRIMARY KEY,
  title       TEXT NOT NULL,
  content     TEXT NOT NULL,
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 클라이언트 강제 업데이트
CREATE TABLE app_versions (
  platform         VARCHAR(20) PRIMARY KEY,    -- 현재 'desktop' 단일값
  required_version VARCHAR(20) NOT NULL,
  download_url     TEXT,
  file_name        TEXT,
  message          TEXT,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 시드 (배포 직후 1행 필요)
INSERT INTO app_versions (platform, required_version) VALUES ('desktop', '0.1.0');
```

### Dropped from original `User` entity (can re-add via ALTER TABLE later)
`referral`, `remain_count`, `service_count`, `depth`, `ip_address`, `email`, `carrier`.

### Dropped from login response (verified unused in client)
`file`, `urlList` — declared in `LoginApiResponse` struct (`prediction_api.rs:1122-1124`) but never read elsewhere.

## 5. API Contracts

All responses use `camelCase` to match the Rust client's `#[serde(rename_all = "camelCase")]` directive.

### `POST /login`

**Request**
```json
{ "username": "joe", "password": "..." }
```

**Logic**
1. `SELECT id, password_hash, expiry_at, active FROM users WHERE username = $1`
2. If user not found, `active=false`, or `bcrypt.compare` fails → `401 { success: false, message: "아이디 또는 비밀번호가 올바르지 않습니다" }`
3. If `expiry_at < now()` → `401 { success: false, message: "이용권이 만료되었습니다" }`
4. `seconds = floor((expiry_at - now) / 1000)`
5. `jti = crypto.randomUUID()`
6. `DELETE FROM active_sessions WHERE user_id = $1` (kicks any existing session anywhere)
7. `INSERT INTO active_sessions (jti, user_id, expires_at)`
8. `token = jwt.sign({ sub: user.id, jti, username, exp: expiry_at_epoch }, JWT_SECRET)`
9. Fetch latest active notice: `SELECT ... FROM notices WHERE active=true ORDER BY created_at DESC LIMIT 1`

**Response**
```json
{
  "success": true,
  "token": "<JWT>",
  "userId": "1",
  "username": "joe",
  "seconds": 86400,
  "notice": { "id": 1, "title": "...", "content": "...", "regDate": "2026-05-11T..." } | null,
  "message": null
}
```

### `GET /validate-token`

Header: `Authorization: Bearer <token>`

**Logic**
1. `jwt.verify(token, JWT_SECRET)`
   - JWT `exp` past → `200 { valid: false, expired: true, remainingSeconds: 0 }`
   - Malformed/bad signature → `401`
2. Decode `{ sub, jti }`
3. `SELECT user_id, expires_at FROM active_sessions WHERE jti = $1`
   - Not found → `200 { valid: false, expired: false }` (**duplicate-login signal**)
4. `SELECT expiry_at FROM users WHERE id = $1`
   - `expiry_at <= now` → `DELETE active_sessions WHERE jti=$1` and return `{ valid: false, expired: true, remainingSeconds: 0 }`
5. `remainingSeconds = floor((expiry_at - now) / 1000)`
6. `UPDATE active_sessions SET last_validated_at = now() WHERE jti = $1`
7. Return `{ valid: true, expired: false, remainingSeconds }`

**Critical**: the three-state response is what `session_monitor.rs:178-184` uses to distinguish expiry from duplicate-login. Must be preserved exactly.

### `POST /v2/predict`

Header: `Authorization: Bearer <token>` (verify signature only; ignore expiry — `/validate-token` handles that out-of-band)

**Response**
```json
{
  "prediction": "Banker" | "Player" | "skip",
  "confidence": 60-94,
  "isSkip": boolean,
  "skipReason": "데이터 부족 (stub)" | null,
  "reasoning": "랜덤 stub (서버 마이그레이션)" | null,
  "responseTimeMs": 5,
  "algorithmVersion": "stub-1.0",
  "roomId": "<echo>"
}
```

Distribution: 45% Banker, 45% Player, 10% skip. Tie is intentionally excluded — the client's domain mapper (`prediction_api.rs:499-504`) drops Tie to `None`, which would surface as confusing no-op predictions.

### `POST /v2/predict/best-room`

**Request**
```json
{ "candidates": [{ "roomId": "...", "roomName": "...", "history": [...] }, ...] }
```

**Response** — pick a random candidate
```json
{
  "bestRoomId": "<candidate.roomId>",
  "bestRoomName": "<candidate.roomName>",
  "results": [],
  "evaluated": <candidates.length>,
  "skipped": 0,
  "responseTimeMs": 10,
  "reason": "랜덤 stub"
}
```

### `POST /v2/result?actualResult=Banker|Player|Tie`

**Response**
```json
{ "success": true, "message": null, "roomId": "<echo>", "result": "<echo>", "error": null }
```

### `POST /v2/shoe-change`

**Response**
```json
{ "success": true, "message": null, "roomId": "<echo>", "shoeId": "<echo>", "error": null }
```

### `POST /version/check`

**Request**
```json
{ "clientVersion": "1.2.3", "platform": "desktop" }
```

**Logic**
1. `SELECT required_version, download_url, file_name, message FROM app_versions WHERE platform = $1`
2. `compatible = semverGte(clientVersion, required_version)`

**Response**
```json
{
  "requiredVersion": "1.2.0",
  "compatible": true,
  "message": null | "업데이트가 필요합니다",
  "downloadUrl": "https://..." | null,
  "fileName": "newbcr-1.2.0-setup.exe" | null
}
```

## 6. Client Changes (newbcr)

Total estimated change surface: ~3 lines.

### 6.1 Base URL
**File**: `src-tauri/src/data/datasources/prediction_api.rs` (around line 30 in `PredictionApiConfig::default`)

Change the hardcoded `http://bcra.store` to read from an env var at compile or run time:
```rust
base_url: option_env!("BCR_API_BASE_URL")
    .unwrap_or("https://<project-ref>.supabase.co/functions/v1/api")
    .to_string()
```

The path segments after the base (e.g. `/login`, `/v2/predict`) remain unchanged in all 7 call sites because the function uses internal routing.

### 6.2 Validation polling interval (optional, recommended)
**File**: `src-tauri/src/domain/services/session_manager.rs` — `SessionManagerConfig::default`
```rust
validation_interval_secs: 30  →  60
```

Doubles the duplicate-login detection ceiling from 30s to 60s and halves the function-invocation cost.

### 6.3 No changes
- `LoginApiResponse` struct keeps `file`/`url_list` with `#[serde(default)]` — the server simply never emits them.
- `LoginScreen.tsx`, `NoticePopup.tsx`, `useSession.ts`, `auth_commands.rs` — unchanged.

## 7. Edge Function Implementation

Single function at `supabase/functions/api/index.ts` with an internal router:

```ts
import { serve } from "https://deno.land/std/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { create, verify, getNumericDate } from "https://deno.land/x/djwt/mod.ts";
import bcrypt from "https://esm.sh/bcryptjs@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);
const JWT_SECRET = Deno.env.get("JWT_SECRET")!;
const KEY = await crypto.subtle.importKey(
  "raw", new TextEncoder().encode(JWT_SECRET),
  { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]
);

serve(async (req) => {
  const url = new URL(req.url);
  // url.pathname is e.g. "/api/login" → strip prefix
  const path = url.pathname.replace(/^\/api/, "");

  switch (`${req.method} ${path}`) {
    case "POST /login":              return handleLogin(req);
    case "GET /validate-token":      return handleValidateToken(req);
    case "POST /v2/predict":         return handlePredict(req);
    case "POST /v2/predict/best-room": return handleBestRoom(req);
    case "POST /v2/result":          return handleResult(req);
    case "POST /v2/shoe-change":     return handleShoeChange(req);
    case "POST /version/check":      return handleVersionCheck(req);
    default: return new Response("Not found", { status: 404 });
  }
});
```

CORS headers (`Access-Control-Allow-Origin: *`, allow `Authorization`/`Content-Type` headers, expose for OPTIONS preflight) are wrapped around all responses since the Tauri webview origin is `tauri://localhost` (Windows) which is treated as cross-origin by default.

## 8. Deployment & Operations

### One-time setup
1. Create Supabase project (free plan, region `ap-northeast-2`).
2. `npm i -g supabase && supabase login && supabase init && supabase link --project-ref <ref>`.
3. Write `supabase/migrations/001_initial.sql` (schemas from §4) and `supabase db push`.
4. `supabase functions new api`, paste implementation from §7.
5. `JWT_SECRET=$(openssl rand -hex 32) && supabase secrets set JWT_SECRET=$JWT_SECRET`.
6. `supabase functions deploy api --no-verify-jwt` (we sign our own JWTs; bypass Supabase's anon-key gate).

### Adding a user (Supabase dashboard → SQL Editor)
```sql
-- Generate hash locally: node -e "console.log(require('bcryptjs').hashSync('비번', 10))"
INSERT INTO users (username, password_hash, expiry_at, role, active)
VALUES ('joe', '$2a$10$...', now() + interval '30 days', 'USER', true);
```

### Common operations
| Task | SQL |
|---|---|
| Extend subscription | `UPDATE users SET expiry_at = greatest(expiry_at, now()) + interval '30 days' WHERE username = 'joe';` |
| Deactivate user | `UPDATE users SET active = false WHERE username = 'joe';` |
| Force logout | `DELETE FROM active_sessions WHERE user_id = (SELECT id FROM users WHERE username = 'joe');` |
| Post notice | `UPDATE notices SET active=false; INSERT INTO notices (title, content) VALUES ('...', '...');` |
| Bump version | `UPDATE app_versions SET required_version='1.2.0', download_url='...', file_name='...' WHERE platform='desktop';` |
| View online users | `SELECT u.username, s.issued_at, s.last_validated_at FROM active_sessions s JOIN users u ON u.id=s.user_id;` |

### Rollout
The old bcra.store is already dead, so a clean cutover is appropriate:
1. Deploy Supabase project + schema + function.
2. Smoke-test `/login` → `/validate-token` with curl/Postman.
3. Build newbcr with the new base URL, log in, verify NoticePopup + stub predictions render.
4. Insert real users.
5. Ship the new client build.

## 9. Free-Tier Budget

| Resource | Free quota | Expected (10 users) | Notes |
|---|---|---|---|
| Edge Function invocations | 500k/mo | ~430k (60s polling) | 30s polling = ~860k → over. **Polling change in §6.2 is the gate.** |
| Postgres storage | 500 MB | <10 MB | Plenty |
| DB egress | 5 GB/mo | <100 MB | Plenty |
| Bandwidth | 5 GB/mo | <500 MB | Plenty |
| Auth MAU | 50k | 0 | Custom JWT, Supabase Auth unused |

**Scale-up path**: Supabase Pro at $25/mo includes 2M function invocations + $2 per additional 1M. Comfortably handles 100+ users with 30s polling.

## 10. Security

- `JWT_SECRET` lives only in Supabase secrets; never committed.
- Edge Function uses `SUPABASE_SERVICE_ROLE_KEY` (server-side only). RLS policies are not added because all DB access is mediated by the function.
- Passwords stored as bcrypt hashes (cost factor 10).
- Tauri client uses HTTPS exclusively (Supabase default).
- Predict/result/shoe-change endpoints verify JWT signature on every request to prevent unauthenticated stub abuse.
- Logs avoid printing token bodies or password fields.

## 11. Open Items / Future Work

- **Self-service registration** — currently out of scope. If added later: new `POST /register` endpoint, new `LoginScreen` tab, optional `/idCheck` endpoint.
- **Admin web UI** — could ship as Vercel-hosted React if user count grows past hand-management threshold.
- **Real prediction logic** — when the pragmatic-native-betting work (`docs/superpowers/specs/2026-04-25-pragmatic-native-betting-design.md`) is complete, the client-side ML may obviate even the stub. Until then, stub stands.
- **Re-adding tracking columns** — `remain_count`, `service_count`, `ip_address`, `email`, `carrier` can be `ALTER TABLE` ed back when business logic demands.

## 12. Acceptance Criteria

- [ ] Logging in with valid credentials returns a token + remaining seconds + optional notice.
- [ ] Second login from another device kicks the first; the first device's next `/validate-token` returns `{valid:false, expired:false}` and the client surfaces "중복 로그인".
- [ ] Letting `expiry_at` pass causes `/validate-token` to return `{valid:false, expired:true}` and the client surfaces the expiry warning.
- [ ] `/v2/predict` consistently returns parseable Banker/Player/skip and the NewBCR UI renders them without errors.
- [ ] `/version/check` returns `compatible=false` and triggers `download_client_update` when `required_version` is bumped beyond the client's `CARGO_PKG_VERSION`.
- [ ] All operations work under the Supabase free tier for at least 10 users with the recommended 60s polling interval.
