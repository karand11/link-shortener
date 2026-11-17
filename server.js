import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { SLUG, RESERVED, validUrl, randomSlug, newToken, hashToken, tokenMatches, RateLimiter, Lru } from "./lib.js";

// Whitelist instead of path joining: no way to traverse out of public/.
const FILES = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
};
const HEADERS = {
  "X-Content-Type-Options": "nosniff",
  // Google Fonts is the only third-party origin the pages load (stylesheet + font files).
  "Content-Security-Policy": "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; frame-ancestors 'none'",
};
const RANGES = [7, 14, 30]; // selectable stats windows, in days
const DEFAULT_RANGE = 14;
const DAY = 86400000;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const send = (res, status, obj) => {
  res.writeHead(status, { ...HEADERS, "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
};

// shortcut: an oversized body is drained (not buffered) before the 413, so a huge upload still costs bandwidth; put a proxy size limit in front for real traffic.
function readBody(req, max = 4096) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size <= max) chunks.push(c);
    });
    req.on("end", () => (size > max ? reject(new HttpError(413, "body too large")) : resolve(Buffer.concat(chunks).toString())));
    req.on("error", reject);
  });
}

// Hostname only: we never store full referrer URLs (they can contain tokens or personal data).
function refHost(ref) {
  try {
    return new URL(ref).hostname.slice(0, 100) || null;
  } catch {
    return null;
  }
}

// `now` is injectable so tests can move the clock to check expiry.
export function createApp({ dbPath = ":memory:", createLimit = 10, trustProxy = false, now = Date.now } = {}) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS links (slug TEXT PRIMARY KEY, url TEXT NOT NULL, created_at INTEGER NOT NULL, token_hash TEXT, expires_at INTEGER);
    CREATE TABLE IF NOT EXISTS clicks (slug TEXT NOT NULL REFERENCES links(slug), ts INTEGER NOT NULL, referrer TEXT);
    CREATE INDEX IF NOT EXISTS clicks_slug_ts ON clicks(slug, ts);
  `);
  // 1.0 databases lack the 2.0 columns; their links stay working but have no manage token, so they can't be deleted.
  const have = db.prepare("PRAGMA table_info(links)").all().map((c) => c.name);
  for (const col of ["token_hash TEXT", "expires_at INTEGER"]) {
    if (!have.includes(col.split(" ")[0])) db.exec(`ALTER TABLE links ADD COLUMN ${col}`);
  }

  const insertLink = db.prepare("INSERT INTO links (slug, url, created_at, token_hash, expires_at) VALUES (?, ?, ?, ?, ?)");
  const getLink = db.prepare("SELECT url, expires_at, token_hash FROM links WHERE slug = ?");
  const deleteLink = db.prepare("DELETE FROM links WHERE slug = ?");
  const deleteClicks = db.prepare("DELETE FROM clicks WHERE slug = ?");
  const insertClick = db.prepare("INSERT INTO clicks (slug, ts, referrer) VALUES (?, ?, ?)");
  const totalClicks = db.prepare("SELECT COUNT(*) AS n FROM clicks WHERE slug = ?");
  const clicksByDay = db.prepare(
    "SELECT strftime('%Y-%m-%d', ts / 1000, 'unixepoch') AS d, COUNT(*) AS n FROM clicks WHERE slug = ? AND ts >= ? GROUP BY d"
  );
  const topReferrers = db.prepare(
    "SELECT COALESCE(referrer, 'direct') AS name, COUNT(*) AS n FROM clicks WHERE slug = ? GROUP BY name ORDER BY n DESC, name LIMIT 5"
  );

  const cache = new Lru(1000); // slug -> { url, expires_at }
  const limiter = new RateLimiter(createLimit, 60_000);

  // Behind a proxy the socket address is the proxy's; the rightmost X-Forwarded-For entry is the one the proxy itself saw (earlier ones are client-controlled).
  const clientIp = (req) =>
    (trustProxy && req.headers["x-forwarded-for"]?.split(",").pop().trim()) || req.socket.remoteAddress;

  async function create(req, res) {
    if (!limiter.allow(clientIp(req))) throw new HttpError(429, "too many links created, try again in a minute");
    let input;
    try {
      input = JSON.parse(await readBody(req));
    } catch (e) {
      throw e.status ? e : new HttpError(400, "body must be JSON");
    }
    const url = validUrl(input?.url);
    if (!url) throw new HttpError(400, "url must be an http(s) URL up to 2048 characters");
    // A link to ourselves would redirect in a loop (or chain through another short link).
    if (new URL(url).host === req.headers.host) throw new HttpError(400, "that already points at this service");
    const custom = input.slug;
    if (custom != null && (typeof custom !== "string" || !SLUG.test(custom) || RESERVED.has(custom))) {
      throw new HttpError(400, "slug must be 3-32 characters of A-Z a-z 0-9 _ - and not reserved");
    }
    const days = input.days ?? null;
    if (days !== null && !(Number.isInteger(days) && days >= 1 && days <= 365)) {
      throw new HttpError(400, "days must be a whole number from 1 to 365");
    }
    const expiresAt = days === null ? null : now() + days * DAY;
    const token = newToken();
    for (let i = 0; i < 5; i++) {
      const slug = custom ?? randomSlug();
      try {
        insertLink.run(slug, url, now(), hashToken(token), expiresAt);
        cache.set(slug, { url, expires_at: expiresAt });
        return send(res, 201, { slug, url, token, expiresAt });
      } catch (e) {
        if (!/UNIQUE/.test(e.message)) throw e;
        if (custom) throw new HttpError(409, "that slug is already taken");
      }
    }
    throw new HttpError(503, "could not allocate a slug, try again");
  }

  function remove(req, res, slug) {
    const link = getLink.get(slug);
    if (!link) throw new HttpError(404, "not found");
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
    if (!bearer || !tokenMatches(bearer[1], link.token_hash)) throw new HttpError(403, "invalid manage token");
    db.exec("BEGIN");
    try {
      deleteClicks.run(slug);
      deleteLink.run(slug);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    cache.delete(slug);
    res.writeHead(204, HEADERS);
    res.end();
  }

  function stats(res, slug, params) {
    const link = getLink.get(slug);
    if (!link) throw new HttpError(404, "not found");
    const asked = Number(params.get("days"));
    const range = RANGES.includes(asked) ? asked : DEFAULT_RANGE;
    // Last `range` UTC days, zero-filled so the client can chart the rows as they come.
    const days = Array.from({ length: range }, (_, i) => new Date(now() - (range - 1 - i) * DAY).toISOString().slice(0, 10));
    const counts = new Map(clicksByDay.all(slug, Date.parse(days[0])).map((r) => [r.d, r.n]));
    send(res, 200, {
      slug,
      url: link.url,
      expiresAt: link.expires_at,
      total: totalClicks.get(slug).n,
      range,
      days: days.map((date) => ({ date, clicks: counts.get(date) ?? 0 })),
      referrers: topReferrers.all(slug).map((r) => ({ name: r.name, clicks: r.n })),
    });
  }

  function redirect(req, res, slug) {
    const link = cache.get(slug) ?? getLink.get(slug);
    if (!link) return send(res, 404, { error: "not found" });
    cache.set(slug, { url: link.url, expires_at: link.expires_at });
    // Checked on every hit, so a cached entry can't outlive its expiry. 410 = it existed, it is gone.
    if (link.expires_at !== null && link.expires_at <= now()) return send(res, 410, { error: "this link has expired" });
    // shortcut: every click is a row and referrer spam can grow the table; add retention or daily roll-ups before real traffic.
    if (req.method === "GET") insertClick.run(slug, now(), refHost(req.headers.referer));
    // 302, not 301: a cached 301 would skip us and the click would never be counted.
    res.writeHead(302, { ...HEADERS, Location: link.url });
    res.end();
  }

  async function serveFile(res, [name, type]) {
    const body = await readFile(fileURLToPath(new URL(`./public/${name}`, import.meta.url)));
    res.writeHead(200, { ...HEADERS, "Content-Type": type });
    res.end(body);
  }

  const server = createServer(async (req, res) => {
    try {
      const { pathname, searchParams } = new URL(req.url, "http://x");
      if (req.method === "POST" && pathname === "/api/links") return await create(req, res);
      const del = pathname.match(/^\/api\/links\/([^/]+)$/);
      if (req.method === "DELETE" && del) return remove(req, res, del[1]);
      const st = pathname.match(/^\/api\/links\/([^/]+)\/stats$/);
      if (req.method === "GET" && st) return stats(res, st[1], searchParams);
      if (req.method === "GET" || req.method === "HEAD") {
        // /stats/<slug> serves the same page; the client reads the slug from the path.
        const f = FILES[pathname.startsWith("/stats/") ? "/" : pathname];
        if (f) return await serveFile(res, f);
        const slug = pathname.slice(1);
        if (SLUG.test(slug) && !RESERVED.has(slug)) return redirect(req, res, slug);
      }
      throw new HttpError(404, "not found");
    } catch (e) {
      if (e.status) return send(res, e.status, { error: e.message });
      console.error(e);
      send(res, 500, { error: "server error" });
    }
  });

  return {
    server,
    close: () => {
      server.closeAllConnections();
      return new Promise((r) => server.close(() => (db.close(), r())));
    },
  };
}

// Only listen when run directly, so tests can import createApp and bind their own port.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { server } = createApp({ dbPath: process.env.DB_PATH || "links.db", trustProxy: !!process.env.TRUST_PROXY });
  const port = process.env.PORT || 3000;
  server.listen(port, () => console.log(`http://localhost:${port}`));
}
