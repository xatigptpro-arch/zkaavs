import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';

const path = '/data/state.json';
let state;
try {
  state = JSON.parse(readFileSync(path, 'utf8'));
  if (state.version !== 1 || !Array.isArray(state.records)) throw new Error('Invalid state');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  state = { version: 1, records: [], lastCheckedAt: null, syncError: null };
}

function persist() {
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}`;
  writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

export function records() {
  return state.records;
}

export function latestRecords() {
  const seen = new Set();
  return state.records.toReversed().filter(record => {
    if (seen.has(record.email)) return false;
    seen.add(record.email);
    return true;
  });
}

export function addInvitation(email, durationDays) {
  const invitedAt = new Date().toISOString();
  const record = {
    id: randomUUID(), email, invitedAt, durationDays,
    expiresAt: new Date(Date.parse(invitedAt) + durationDays * 86_400_000).toISOString(),
    status: 'pending', activeSince: null, lastCheckedAt: null, revokedAt: null,
    revokeError: null, imported: false
  };
  state.records.push(record);
  persist();
  return record;
}

export function updateRecord(record, changes) {
  Object.assign(record, changes);
  persist();
}

export function updateSync(changes) {
  Object.assign(state, changes);
  persist();
}

export function dashboard(syncing = false) {
  const latest = latestRecords();
  return {
    invitations: state.records.toReversed(),
    users: latest.filter(record => record.status === 'active'),
    summary: {
      sent: state.records.length,
      users: latest.filter(record => record.status === 'active').length,
      pending: latest.filter(record => record.status === 'pending').length
    },
    lastCheckedAt: state.lastCheckedAt,
    syncError: state.syncError,
    syncing
  };
}
