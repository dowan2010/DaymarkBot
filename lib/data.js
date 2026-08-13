import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const DATA_DIR = dirname(fileURLToPath(import.meta.url + '/..'));
const STATE_FILE = join(DATA_DIR, 'local-state.json');

let stateCache = null;

function loadState() {
  if (stateCache) return stateCache;
  stateCache = existsSync(STATE_FILE)
    ? JSON.parse(readFileSync(STATE_FILE, 'utf-8'))
    : { submissionHistory: [], recentTopics: [] };
  return stateCache;
}

function saveState() {
  writeFileSync(STATE_FILE, JSON.stringify(stateCache, null, 2));
}

export function getSubmissionHistory() {
  return loadState().submissionHistory;
}

export function addSubmissionHistory(date, topic = null, content = null) {
  const state = loadState();
  const alreadyExists = state.submissionHistory.some(e => (typeof e === 'string' ? e : e.date) === date);
  if (!alreadyExists) {
    state.submissionHistory.unshift(topic ? { date, topic, content } : date);
    saveState();
  }
}

export function hasSubmittedFor(date) {
  return getSubmissionHistory().some(e => (typeof e === 'string' ? e : e.date) === date);
}

export function removeSubmissionHistory(date) {
  const state = loadState();
  state.submissionHistory = state.submissionHistory.filter(e => (typeof e === 'string' ? e : e.date) !== date);
  saveState();
}

export function getRecentTopics() {
  return loadState().recentTopics;
}

export function addRecentTopic(topic) {
  const state = loadState();
  state.recentTopics.unshift(topic);
  state.recentTopics = state.recentTopics.slice(0, 10);
  saveState();
}
