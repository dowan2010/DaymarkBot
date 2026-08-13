import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { getUser } from './data.js';

const DATA_DIR = dirname(fileURLToPath(import.meta.url + '/..'));
const KEYS_FILE = join(DATA_DIR, 'keys.json');

let keysCache = null;

export const ADMIN_IDS = new Set(
  (process.env.ADMIN_USER_IDS ?? '').split(',').map(s => s.trim()).filter(Boolean)
);

export function isAdmin(userId) {
  return ADMIN_IDS.has(userId);
}

export function loadKeys() {
  keysCache = existsSync(KEYS_FILE)
    ? JSON.parse(readFileSync(KEYS_FILE, 'utf-8'))
    : { available: [], activated: {}, suspended: [], expiry: {}, boundTo: {}, userPlan: {}, userExpiry: {}, warned: [] };
  if (!keysCache.suspended) keysCache.suspended = [];
  if (!keysCache.expiry) keysCache.expiry = {};
  if (!keysCache.boundTo) keysCache.boundTo = {};
  if (!keysCache.userPlan) keysCache.userPlan = {};
  if (!keysCache.userExpiry) keysCache.userExpiry = {};
  if (!keysCache.warned) keysCache.warned = [];
  if (!keysCache.keyPlan) keysCache.keyPlan = {};
  return keysCache;
}

export function saveKeys() {
  writeFileSync(KEYS_FILE, JSON.stringify(keysCache, null, 2));
}

export function isStealthUser(userId) {
  const keys = loadKeys();
  const userKey = keys.activated[userId];
  return userKey ? !!(keys.stealth?.[userKey]) : false;
}

export function isSuspended(userId) {
  if (isAdmin(userId)) return false;
  const keys = loadKeys();
  const userKey = keys.activated[userId];
  if (!userKey) return false;
  return keys.suspended.includes(userKey);
}

export function isActivated(userId) {
  if (isAdmin(userId)) return true;
  const keys = loadKeys();
  if (!keys.activated[userId]) return false;
  if (keys.suspended.includes(keys.activated[userId])) return false;
  if (isStealthUser(userId)) return true;
  if (keys.userExpiry[userId] && keys.userExpiry[userId] < Date.now()) return false;
  return true;
}

export function isProOrAbove(userId) {
  if (ADMIN_IDS.has(userId)) return true;
  return !!getUser(userId);
}

export function isPremiumUser(userId) {
  if (ADMIN_IDS.has(userId)) return true;
  return !!getUser(userId);
}

export function purgeExpiredKeys() {
  const keys = loadKeys();
  const now = Date.now();
  const expired = keys.available.filter(k => keys.expiry[k] && keys.expiry[k] < now);
  if (expired.length === 0) return 0;
  keys.available = keys.available.filter(k => !(keys.expiry[k] && keys.expiry[k] < now));
  for (const k of expired) delete keys.expiry[k];
  saveKeys();
  return expired.length;
}

export function keyRemainingStr(key) {
  const keys = loadKeys();
  if (!keys.expiry[key]) return null;
  const ms = keys.expiry[key] - Date.now();
  if (ms <= 0) return '만료됨';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return h > 0 ? `${h}시간 ${m}분 남음` : `${m}분 남음`;
}

export function generateKey() {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghjkmnpqrstuvwxyz';
  const digits = '23456789';
  const symbols = '!@#$%^&*';
  const all = upper + lower + digits + symbols;
  const chars = [
    upper[Math.floor(Math.random() * upper.length)],
    lower[Math.floor(Math.random() * lower.length)],
    digits[Math.floor(Math.random() * digits.length)],
    symbols[Math.floor(Math.random() * symbols.length)],
  ];
  for (let i = 0; i < 3; i++) chars.push(all[Math.floor(Math.random() * all.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

export function activateUserDirect(userId, plan, durationDays) {
  const keys = loadKeys();
  let key = keys.activated[userId];
  if (!key || keys.suspended.includes(key)) {
    do { key = generateKey(); } while (keys.available.includes(key) || Object.values(keys.activated).includes(key));
    if (keys.activated[userId] && keys.suspended.includes(keys.activated[userId])) {
      keys.suspended = keys.suspended.filter(k => k !== keys.activated[userId]);
    }
    keys.activated[userId] = key;
  }
  keys.userPlan[userId] = plan;
  keys.userExpiry[userId] = Date.now() + durationDays * 24 * 60 * 60 * 1000;
  keys.warned = (keys.warned || []).filter(id => id !== userId);
  saveKeys();
  return key;
}

export function revokeUser(userId) {
  const keys = loadKeys();
  const key = keys.activated[userId];
  if (!key) return false;
  delete keys.activated[userId];
  delete keys.userPlan[userId];
  delete keys.userExpiry[userId];
  keys.warned = (keys.warned || []).filter(id => id !== userId);
  saveKeys();
  return true;
}

export function activateUser(userId, key) {
  const keys = loadKeys();
  const suspendedUser = keys.activated[userId] && keys.suspended.includes(keys.activated[userId]);
  if (keys.activated[userId] && !suspendedUser) return 'already';
  if (keys.boundTo[key] && keys.boundTo[key] !== userId) return 'taken';
  const idx = keys.available.indexOf(key);
  if (idx === -1) return false;
  if (keys.expiry[key] && keys.expiry[key] < Date.now()) {
    keys.available.splice(idx, 1);
    delete keys.expiry[key];
    saveKeys();
    return 'expired';
  }
  if (suspendedUser) {
    const oldKey = keys.activated[userId];
    keys.suspended = keys.suspended.filter(k => k !== oldKey);
  }
  keys.available.splice(idx, 1);
  delete keys.expiry[key];
  keys.activated[userId] = key;
  keys.boundTo[key] = userId;
  if (keys.keyPlan?.[key]) {
    keys.userPlan[userId] = keys.keyPlan[key];
    delete keys.keyPlan[key];
  }
  if (keys.keyDays?.[key]) {
    keys.userExpiry[userId] = Date.now() + keys.keyDays[key] * 24 * 60 * 60 * 1000;
    delete keys.keyDays[key];
  }
  saveKeys();
  return true;
}
