# Snip: URL shortener with click analytics

Shorten a link, share it, and see how many people click it, per day and by referrer.
Built with **zero dependencies**: Node's built-in `http` and `sqlite` modules.

## Features
- Short links with random 7-character slugs, or your own custom slug
- Click analytics page per link: total, clicks per day (7, 14 or 30 days), top referrers, plus an accessible table view
- SQLite storage, with an LRU cache in front of redirect lookups
- Rate limiting on link creation (10 per minute per IP)
- Input validation: only `http(s)` URLs (no `javascript:` / `data:`), length limits, reserved slugs, request body size cap
- Privacy-minded: only the referrer *hostname* is stored, never IPs, full URLs or user agents
- Security headers (CSP, `nosniff`), and all server-supplied text rendered with `textContent`

### New in 2.0
- **Link expiry**: choose 1 to 365 days; after that the link answers `410 Gone`, and its stats stay available
- **Delete your own links without accounts**: creating a link returns a secret *manage token*. Only its SHA-256 hash is stored, it is compared in constant time, and the browser that created the link keeps it and shows a Delete button (two-step confirm). Deleting also removes the link's click history
- **Selectable stats range** (7 / 14 / 30 days)
- **No self-links**: a URL pointing back at this service is refused, so nobody can build redirect loops
- **Automatic migration**: a 1.0 database is upgraded in place, and its links keep working (they have no token, so they can't be deleted)

## Run
```bash
npm start        # http://localhost:3000  (PORT, DB_PATH, TRUST_PROXY env vars)
npm test         # unit tests + HTTP tests against the real server
```
Requires Node 22.13 or newer (for `node:sqlite`).

## API
| Method | Path | Description |
|---|---|---|
| `POST` | `/api/links` | Body `{ "url": "https://…", "slug": "optional", "days": 7 }` → `201 { slug, url, token, expiresAt }`. **The token is shown once; keep it.** |
| `GET` | `/:slug` | `302` redirect to the target URL and records the click. `410` if expired |
| `DELETE` | `/api/links/:slug` | Header `Authorization: Bearer <token>` → `204`; `403` if the token is wrong |
| `GET` | `/api/links/:slug/stats?days=7\|14\|30` | `{ total, expiresAt, range, days: [{date, clicks}], referrers: [{name, clicks}] }` |
| `GET` | `/stats/:slug` | The analytics page |

Errors: `400` invalid input, `403` bad manage token, `404` unknown link, `409` slug taken, `410` expired, `413` body too large, `429` rate limited.

## Design notes
- **302, not 301.** A browser caches a 301 and would skip the server, so those clicks would never be counted.
- **Expiry is checked on every hit**, including cache hits, so a cached link can't outlive its deadline. Deleting evicts the cache entry.
- **Rate limiter and cache are in-process.** Fine for one instance; see limits below.
- **Rate limiting behind a proxy.** With `TRUST_PROXY=1` the client IP is the rightmost `X-Forwarded-For` entry (the one the proxy itself saw), because earlier entries are client-controlled.
- **Testable time.** `createApp({ now })` takes a clock, so the expiry tests move time forward instead of sleeping.

## Deploy (Render)
Push to GitHub, then **New → Blueprint** on Render and pick the repo (`render.yaml` is included).
The free plan has an **ephemeral disk**: links and clicks are lost on every redeploy or restart. For persistence, use a paid plan with a disk mounted at `/data` and set `DB_PATH=/data/links.db`.

## Known limits / next steps
- Anyone can create links and anyone with a slug can view its stats. The manage token only protects deleting. Shorteners can be abused for phishing: add abuse reporting or URL scanning before real traffic.
- A lost token means a link can't be deleted from another browser or after clearing site data (no accounts, no recovery).
- Rate limiter is per process; use Redis (`INCR` + `EXPIRE`) to share it across instances.
- Every click is a row, and referrer spam can grow the table; add retention or daily roll-ups. Expired links are never purged.
- No QR codes, no editing a link's target.
