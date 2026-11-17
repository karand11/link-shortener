import { test } from "node:test";
import assert from "node:assert/strict";
import { validUrl, randomSlug, RateLimiter, Lru, SLUG } from "./lib.js";
import { createApp } from "./server.js";

test("validUrl accepts http(s) and rejects everything else", () => {
  assert.equal(validUrl("https://example.com/a?b=1"), "https://example.com/a?b=1");
  assert.equal(validUrl("HTTP://Example.com"), "http://example.com/");
  for (const bad of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "example.com", "", null, 5, "https://" + "a".repeat(2100)]) {
    assert.equal(validUrl(bad), null, String(bad));
  }
});

test("randomSlug is url-safe and valid", () => {
  for (let i = 0; i < 50; i++) assert.match(randomSlug(), SLUG);
});

test("RateLimiter allows max per window then resets", () => {
  let t = 0;
  const rl = new RateLimiter(2, 1000, () => t);
  assert.ok(rl.allow("a") && rl.allow("a"));
  assert.ok(!rl.allow("a"));
  assert.ok(rl.allow("b")); // other keys unaffected
  t = 1000;
  assert.ok(rl.allow("a"));
});

test("Lru evicts the least recently used", () => {
  const c = new Lru(2);
  c.set("a", 1); c.set("b", 2);
  c.get("a"); // a is now most recent
  c.set("c", 3);
  assert.equal(c.get("b"), undefined);
  assert.equal(c.get("a"), 1);
  assert.equal(c.get("c"), 3);
});

// Real HTTP against the real server, in-memory database.
async function withApp(opts, fn) {
  const app = createApp(opts);
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://localhost:${app.server.address().port}`;
  const post = (body, raw) =>
    fetch(`${base}/api/links`, { method: "POST", headers: { "Content-Type": "application/json" }, body: raw ?? JSON.stringify(body) });
  try {
    await fn({ base, post });
  } finally {
    await app.close();
  }
}

test("create, redirect, and stats", () =>
  withApp({}, async ({ base, post }) => {
    const res = await post({ url: "https://example.com/long" });
    assert.equal(res.status, 201);
    const { slug } = await res.json();

    const r = await fetch(`${base}/${slug}`, { redirect: "manual", headers: { Referer: "https://news.example.org/post/1?token=secret" } });
    assert.equal(r.status, 302);
    assert.equal(r.headers.get("location"), "https://example.com/long");
    await fetch(`${base}/${slug}`, { redirect: "manual" }); // direct visit

    const s = await (await fetch(`${base}/api/links/${slug}/stats`)).json();
    assert.equal(s.total, 2);
    assert.equal(s.days.length, 14);
    assert.equal(s.days.at(-1).clicks, 2); // today
    assert.deepEqual(s.referrers.map((x) => x.name).sort(), ["direct", "news.example.org"]); // hostname only, no path or token
  }));

test("custom slug: taken, reserved, invalid", () =>
  withApp({}, async ({ post }) => {
    assert.equal((await post({ url: "https://a.com", slug: "my-link" })).status, 201);
    assert.equal((await post({ url: "https://b.com", slug: "my-link" })).status, 409);
    assert.equal((await post({ url: "https://b.com", slug: "api" })).status, 400);
    assert.equal((await post({ url: "https://b.com", slug: "a b" })).status, 400);
  }));

test("bad input is rejected", () =>
  withApp({}, async ({ base, post }) => {
    assert.equal((await post({ url: "javascript:alert(1)" })).status, 400);
    assert.equal((await post({})).status, 400);
    assert.equal((await post(null, "not json")).status, 400);
    assert.equal((await post(null, JSON.stringify({ url: "https://a.com/" + "x".repeat(5000) }))).status, 413);
    assert.equal((await fetch(`${base}/nope123`, { redirect: "manual" })).status, 404);
    assert.equal((await fetch(`${base}/api/links/nope123/stats`)).status, 404);
  }));

test("creation is rate limited", () =>
  withApp({ createLimit: 2 }, async ({ post }) => {
    assert.equal((await post({ url: "https://a.com" })).status, 201);
    assert.equal((await post({ url: "https://a.com" })).status, 201);
    assert.equal((await post({ url: "https://a.com" })).status, 429);
  }));

test("static files and path traversal", () =>
  withApp({}, async ({ base }) => {
    assert.equal((await fetch(`${base}/`)).status, 200);
    assert.equal((await fetch(`${base}/stats/anything`)).status, 200); // SPA page
    assert.equal((await fetch(`${base}/app.js`)).status, 200);
    assert.equal((await fetch(`${base}/..%2fserver.js`)).status, 404);
  }));

test("expiry: redirects until the deadline, then 410; stats survive", () => {
  let t = Date.now();
  return withApp({ now: () => t }, async ({ base, post }) => {
    const res = await post({ url: "https://example.com", days: 1 });
    const { slug, expiresAt } = await res.json();
    assert.equal(expiresAt, t + 86400000);
    assert.equal((await fetch(`${base}/${slug}`, { redirect: "manual" })).status, 302);
    t += 2 * 86400000;
    assert.equal((await fetch(`${base}/${slug}`, { redirect: "manual" })).status, 410);
    const s = await (await fetch(`${base}/api/links/${slug}/stats`)).json();
    assert.equal(s.total, 1); // the click before expiry is kept, the 410 was not counted
    assert.equal(s.expiresAt, expiresAt);
  });
});

test("days must be a whole number from 1 to 365", () =>
  withApp({}, async ({ post }) => {
    for (const days of [0, 1.5, 366, "7", -1]) assert.equal((await post({ url: "https://a.com", days })).status, 400, String(days));
    assert.equal((await post({ url: "https://a.com", days: 365 })).status, 201);
  }));

test("delete needs the manage token, then removes the link, clicks and cache entry", () =>
  withApp({}, async ({ base, post }) => {
    const { slug, token } = await (await post({ url: "https://example.com" })).json();
    await fetch(`${base}/${slug}`, { redirect: "manual" }); // warms the cache
    const del = (auth) => fetch(`${base}/api/links/${slug}`, { method: "DELETE", headers: auth ? { Authorization: auth } : {} });
    assert.equal((await del()).status, 403);
    assert.equal((await del("Bearer wrong")).status, 403);
    assert.equal((await del(`Bearer ${token}`)).status, 204);
    assert.equal((await fetch(`${base}/${slug}`, { redirect: "manual" })).status, 404); // cache was evicted too
    assert.equal((await fetch(`${base}/api/links/${slug}/stats`)).status, 404);
    assert.equal((await del(`Bearer ${token}`)).status, 404);
  }));

test("one link's token cannot delete another link", () =>
  withApp({}, async ({ base, post }) => {
    const a = await (await post({ url: "https://a.com" })).json();
    const b = await (await post({ url: "https://b.com" })).json();
    const res = await fetch(`${base}/api/links/${b.slug}`, { method: "DELETE", headers: { Authorization: `Bearer ${a.token}` } });
    assert.equal(res.status, 403);
  }));

test("links back to this service are refused", () =>
  withApp({}, async ({ base, post }) => {
    const { slug } = await (await post({ url: "https://example.com" })).json();
    assert.equal((await post({ url: `${base}/${slug}` })).status, 400);
  }));

test("stats range is selectable and falls back to 14", () =>
  withApp({}, async ({ base, post }) => {
    const { slug } = await (await post({ url: "https://example.com" })).json();
    const days = async (q) => (await (await fetch(`${base}/api/links/${slug}/stats${q}`)).json()).days.length;
    assert.equal(await days(""), 14);
    assert.equal(await days("?days=7"), 7);
    assert.equal(await days("?days=30"), 30);
    assert.equal(await days("?days=999"), 14);
  }));

test("a 1.0 database is migrated and its links keep working", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "snip-"));
  const dbPath = join(dir, "old.db");
  const old = new DatabaseSync(dbPath);
  old.exec(`CREATE TABLE links (slug TEXT PRIMARY KEY, url TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE clicks (slug TEXT NOT NULL, ts INTEGER NOT NULL, referrer TEXT);
    INSERT INTO links VALUES ('legacy', 'https://example.com/old', 0);`);
  old.close();
  try {
    await withApp({ dbPath }, async ({ base }) => {
      const r = await fetch(`${base}/legacy`, { redirect: "manual" });
      assert.equal(r.status, 302);
      assert.equal(r.headers.get("location"), "https://example.com/old");
      // No token was ever issued for it, so nobody can delete it.
      const del = await fetch(`${base}/api/links/legacy`, { method: "DELETE", headers: { Authorization: "Bearer x" } });
      assert.equal(del.status, 403);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
