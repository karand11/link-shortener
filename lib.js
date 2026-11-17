import { randomBytes, createHash, timingSafeEqual } from "node:crypto";

export const SLUG = /^[A-Za-z0-9_-]{3,32}$/;
export const RESERVED = new Set(["api", "stats"]); // path prefixes the app itself uses
export const MAX_URL = 2048;

// Only absolute http(s) URLs: blocks javascript:, data:, file: etc. Returns the normalised href or null.
export function validUrl(raw) {
  if (typeof raw !== "string" || raw.length > MAX_URL) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

const ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
// 62^7 ≈ 3.5e12 slugs. The modulo bias (256 % 62) is irrelevant for non-secret ids.
export const randomSlug = (n = 7) => Array.from(randomBytes(n), (b) => ALPHABET[b % 62]).join("");

// Manage tokens: the creator gets the token once, we only store its hash (a DB leak can't delete anyone's links).
export const newToken = () => randomBytes(24).toString("base64url");
export const hashToken = (t) => createHash("sha256").update(t).digest("hex");
export function tokenMatches(token, hash) {
  if (typeof token !== "string" || !hash) return false;
  const a = Buffer.from(hashToken(token));
  const b = Buffer.from(hash);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Fixed-window counter per key.
// shortcut: in-memory, per process, so limits reset on restart and are not shared across instances; use Redis INCR + EXPIRE to scale out.
export class RateLimiter {
  #hits = new Map();
  constructor(max, windowMs, now = Date.now) {
    Object.assign(this, { max, windowMs, now });
  }
  allow(key) {
    const t = this.now();
    if (this.#hits.size > 10000) {
      for (const [k, h] of this.#hits) if (t - h.start >= this.windowMs) this.#hits.delete(k);
    }
    const h = this.#hits.get(key);
    if (!h || t - h.start >= this.windowMs) {
      this.#hits.set(key, { start: t, count: 1 });
      return true;
    }
    return ++h.count <= this.max;
  }
}

// Least-recently-used cache. A link only changes by being deleted, and delete() evicts it, so entries never go stale.
export class Lru {
  #m = new Map();
  constructor(max) {
    this.max = max;
  }
  delete(k) {
    this.#m.delete(k);
  }
  get(k) {
    if (!this.#m.has(k)) return undefined;
    const v = this.#m.get(k);
    this.#m.delete(k);
    this.#m.set(k, v); // move to most-recent
    return v;
  }
  set(k, v) {
    this.#m.delete(k);
    this.#m.set(k, v);
    if (this.#m.size > this.max) this.#m.delete(this.#m.keys().next().value);
  }
}
