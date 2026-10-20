'use strict';

/**
 * Vercel KV / Upstash Redis helper.
 * Automatically detects Vercel KV or Upstash Redis environment variables:
 * - KV_REST_API_URL / KV_REST_API_TOKEN (Vercel KV)
 * - UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN (Upstash Marketplace on Vercel)
 *
 * If credentials are not present, KV is disabled and local storage is used.
 */

const env = process.env;
const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL || '';
const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN || '';

const isEnabled = Boolean(url && token);

async function command(...args) {
  if (!isEnabled) return null;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(args),
    });
    if (!res.ok) {
      console.warn(`[kv] Request failed with HTTP ${res.status}`);
      return null;
    }
    const data = await res.json();
    return data && data.result !== undefined ? data.result : null;
  } catch (err) {
    console.warn('[kv] Command error:', err.message);
    return null;
  }
}

async function get(key) {
  const raw = await command('GET', key);
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return raw;
  }
}

async function set(key, value) {
  const payload = typeof value === 'string' ? value : JSON.stringify(value);
  return command('SET', key, payload);
}

async function del(key) {
  return command('DEL', key);
}

module.exports = {
  isEnabled,
  get,
  set,
  del,
};
