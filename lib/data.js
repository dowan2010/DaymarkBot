import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const DATA_DIR = dirname(fileURLToPath(import.meta.url + '/..'));
const USERS_FILE = join(DATA_DIR, 'users.json');

let usersCache = null;

export function loadUsers() {
  if (usersCache) return usersCache;
  usersCache = existsSync(USERS_FILE)
    ? JSON.parse(readFileSync(USERS_FILE, 'utf-8'))
    : {};
  return usersCache;
}

function _save(users) {
  usersCache = users;
  writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

export function saveUser(userId, email, password) {
  const users = loadUsers();
  users[userId] = { ...users[userId], email, password };
  _save(users);
}

export function saveThankConfig(userId, thankConfig) {
  const users = loadUsers();
  if (!users[userId]) return;
  users[userId] = { ...users[userId], thankConfig };
  _save(users);
}

export function getThankConfig(userId) {
  return loadUsers()[userId]?.thankConfig ?? null;
}

export function savePremiumSettings(userId, patch) {
  const users = loadUsers();
  if (!users[userId]) return;
  users[userId] = { ...users[userId], premiumSettings: { ...users[userId].premiumSettings, ...patch } };
  _save(users);
}

export function getPremiumSettings(userId) {
  return loadUsers()[userId]?.premiumSettings ?? {};
}

export function deleteUser(userId) {
  const users = loadUsers();
  delete users[userId];
  _save(users);
}

export function getUser(userId) {
  const users = loadUsers();
  const user = users[userId];
  if (user) return { email: user.email, password: user.password };
  if (process.env.NEWRROW_EMAIL && process.env.NEWRROW_PASSWORD) {
    return { email: process.env.NEWRROW_EMAIL, password: process.env.NEWRROW_PASSWORD };
  }
  return null;
}

export function getSubmissionHistory(userId) {
  return loadUsers()[userId]?.submissionHistory ?? [];
}

export function addSubmissionHistory(userId, date, topic = null, content = null) {
  const users = loadUsers();
  if (!users[userId]) return;
  const history = users[userId].submissionHistory ?? [];
  const alreadyExists = history.some(e => (typeof e === 'string' ? e : e.date) === date);
  if (!alreadyExists) {
    history.unshift(topic ? { date, topic, content } : date);
    users[userId].submissionHistory = history;
    _save(users);
  }
}

export function hasSubmittedFor(userId, date) {
  return getSubmissionHistory(userId).some(e => (typeof e === 'string' ? e : e.date) === date);
}

export function removeSubmissionHistory(userId, date) {
  const users = loadUsers();
  if (!users[userId]) return;
  const history = users[userId].submissionHistory ?? [];
  users[userId].submissionHistory = history.filter(e => (typeof e === 'string' ? e : e.date) !== date);
  _save(users);
}

export function getStreak(userId) {
  const history = getSubmissionHistory(userId);
  if (!history.length) return 0;
  const dateSet = new Set(history.map(e => typeof e === 'string' ? e : e.date));
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const todayStr = now.toISOString().split('T')[0];
  let streak = 0;
  let cursor = dateSet.has(todayStr) ? now : new Date(now.getTime() - 86400000);
  while (true) {
    const d = cursor.toISOString().split('T')[0];
    if (!dateSet.has(d)) break;
    streak++;
    cursor = new Date(cursor.getTime() - 86400000);
  }
  return streak;
}

export function updateBestStreak(userId) {
  const users = loadUsers();
  if (!users[userId]) return;
  const current = getStreak(userId);
  if (current > (users[userId].bestStreak ?? 0)) {
    users[userId].bestStreak = current;
    _save(users);
  }
}

export function getRecentTopics(userId) {
  return loadUsers()[userId]?.recentTopics ?? [];
}

export function addRecentTopic(userId, topic) {
  const users = loadUsers();
  if (!users[userId]) return;
  const recent = users[userId].recentTopics ?? [];
  recent.unshift(topic);
  users[userId].recentTopics = recent.slice(0, 10);
  _save(users);
}

export function trackApi(userId, type) {
  const users = loadUsers();
  if (!users[userId]) return;
  const s = users[userId].apiStats ?? { topic: 0, reflection: 0 };
  s[type] = (s[type] ?? 0) + 1;
  users[userId].apiStats = s;
  _save(users);
}

export function getApiStats() {
  const users = loadUsers();
  return Object.entries(users)
    .filter(([, u]) => u.apiStats)
    .map(([id, u]) => ({ id, ...u.apiStats }));
}
