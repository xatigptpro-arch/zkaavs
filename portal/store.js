import { readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';

export class StoreError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function addMonths(value, months) {
  const date = new Date(value);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, last));
  return date.toISOString();
}

export function createStore(path, legacyCredential, clock = Date.now) {
  let state;
  try { state = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    state = { version: 1, records: [], lastCheckedAt: null, syncError: null };
  }
  function persist() {
    const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}`;
    writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  }
  if (state.version === 1 && Array.isArray(state.records)) {
    const backup = `${path}.v1.backup`;
    if (existsSync(path) && !existsSync(backup)) {
      writeFileSync(backup, readFileSync(path), { mode: 0o600, flag: 'wx' });
    }
    const adminId = randomUUID();
    state.accounts = [{
      id: adminId, username: 'admin', name: 'Administrador', role: 'admin', enabled: true,
      credential: legacyCredential, credentialVersion: 1, createdAt: new Date(clock()).toISOString(), plan: null
    }];
    for (const record of state.records) record.ownerId = adminId;
    state.operations = [];
    state.version = 2;
    persist();
  }
  if (state.version !== 2 || !Array.isArray(state.accounts) || !Array.isArray(state.records)
      || !Array.isArray(state.operations) || !state.accounts.some(a => a.role === 'admin')) {
    throw new Error('Invalid portal state');
  }
  // A restarted process cannot know whether an interrupted send reached Canva.
  let interrupted = false;
  for (const operation of state.operations) {
    if (operation.status === 'sending') { operation.status = 'uncertain'; interrupted = true; }
  }
  if (interrupted) persist();

  const accounts = () => state.accounts;
  const account = id => accounts().find(a => a.id === id);
  const latestRecords = () => {
    const seen = new Set();
    return state.records.toReversed().filter(record => {
      if (seen.has(record.email)) return false;
      seen.add(record.email); return true;
    });
  };
  function usage(user) {
    if (user.role === 'admin') return { status: 'admin', allowed: user.enabled, limit: null, sent: 0, reserved: 0, remaining: null, start: null, end: null, expiresAt: null };
    const plan = user.plan;
    const now = clock();
    if (!plan) return { status: 'expired', allowed: false, limit: 0, sent: 0, reserved: 0, remaining: 0, start: null, end: null, expiresAt: null };
    const anchor = new Date(plan.startedAt);
    const today = new Date(now);
    let months = Math.max(0, (today.getUTCFullYear() - anchor.getUTCFullYear()) * 12 + today.getUTCMonth() - anchor.getUTCMonth());
    if (Date.parse(addMonths(plan.startedAt, months)) > now) months = Math.max(0, months - 1);
    const start = addMonths(plan.startedAt, months);
    const end = addMonths(plan.startedAt, months + 1);
    const inPeriod = value => value && Date.parse(value) >= Date.parse(start) && Date.parse(value) < Date.parse(end);
    const sent = state.records.filter(r => r.ownerId === user.id && inPeriod(r.invitedAt)).length;
    const reserved = state.operations.filter(o => o.ownerId === user.id && ['sending', 'uncertain'].includes(o.status) && inPeriod(o.createdAt)).length;
    const expired = now >= Date.parse(plan.expiresAt);
    return { status: !user.enabled ? 'suspended' : expired ? 'expired' : 'active', allowed: user.enabled && !expired,
      limit: plan.monthlyQuota, sent, reserved, remaining: Math.max(0, plan.monthlyQuota - sent - reserved),
      start, end, expiresAt: plan.expiresAt };
  }
  function publicAccount(user) {
    return { id: user.id, username: user.username, name: user.name, role: user.role, enabled: user.enabled,
      createdAt: user.createdAt, plan: user.plan, usage: usage(user) };
  }
  function createAccount({ username, name, credential, monthlyQuota, months }) {
    if (accounts().some(a => a.username === username)) throw new StoreError(409, 'Ese nombre de usuario ya existe.');
    const startedAt = new Date(clock()).toISOString();
    const user = { id: randomUUID(), username, name, role: 'operator', enabled: true, credential,
      credentialVersion: 1, createdAt: startedAt,
      plan: { startedAt, expiresAt: addMonths(startedAt, months), months, monthlyQuota } };
    state.accounts.push(user); persist(); return publicAccount(user);
  }
  function renew(user, monthlyQuota, months) {
    const now = new Date(clock()).toISOString();
    const active = user.plan && Date.parse(user.plan.expiresAt) > clock();
    user.plan = {
      startedAt: active ? user.plan.startedAt : now,
      expiresAt: addMonths(active ? user.plan.startedAt : now, (active ? user.plan.months : 0) + months),
      months: (active ? user.plan.months : 0) + months, monthlyQuota
    };
    persist(); return publicAccount(user);
  }
  function updateAccount(user, changes) { Object.assign(user, changes); persist(); return publicAccount(user); }
  function reserve(user, email, durationDays, requestId) {
    const existing = state.operations.find(o => o.requestId === requestId);
    if (existing) {
      if (existing.ownerId !== user.id || existing.email !== email || existing.durationDays !== durationDays) {
        throw new StoreError(409, 'Esta solicitud ya fue utilizada.');
      }
      return { operation: existing, reused: true };
    }
    const plan = usage(user);
    if (!plan.allowed) throw new StoreError(403, 'Tu plan no está activo. Puedes consultar tu historial.');
    if (plan.remaining === 0) throw new StoreError(429, 'Has agotado el cupo de invitaciones de este mes.');
    // Do not reveal who owns an existing invitation.
    if (latestRecords().some(r => r.email === email && ['pending', 'active'].includes(r.status))
        || state.operations.some(o => o.email === email && ['sending', 'uncertain'].includes(o.status))) {
      throw new StoreError(409, 'Este correo ya tiene acceso, una invitación pendiente o un envío por comprobar.');
    }
    const operation = { id: randomUUID(), requestId, ownerId: user.id, email, durationDays,
      createdAt: new Date(clock()).toISOString(), status: 'sending' };
    state.operations.push(operation); persist(); return { operation, reused: false };
  }
  function finish(operation, status) {
    if (['confirmed', 'failed'].includes(operation.status)) return;
    if (status === 'confirmed') {
      const invitedAt = operation.createdAt;
      state.records.push({ id: randomUUID(), ownerId: operation.ownerId, email: operation.email,
        invitedAt, durationDays: operation.durationDays,
        expiresAt: new Date(Date.parse(invitedAt) + operation.durationDays * 86_400_000).toISOString(),
        status: 'pending', activeSince: null, lastCheckedAt: null, revokedAt: null, revokeError: null, imported: false });
    }
    operation.status = status; persist();
  }
  function dashboard(user, syncing = false) {
    const visible = r => user.role === 'admin' || r.ownerId === user.id;
    const latest = latestRecords().filter(visible);
    const decorate = r => user.role === 'admin' ? { ...r, owner: account(r.ownerId)?.username ?? '—' } : r;
    return {
      me: publicAccount(user), invitations: state.records.toReversed().filter(visible).map(decorate),
      users: latest.filter(r => r.status === 'active').map(decorate),
      operations: state.operations.filter(o => visible(o) && ['sending', 'uncertain'].includes(o.status))
        .map(o => ({ id: o.id, email: o.email, createdAt: o.createdAt, status: o.status,
          ...(user.role === 'admin' ? { owner: account(o.ownerId)?.username ?? '—' } : {}) })),
      summary: { sent: state.records.filter(visible).length, users: latest.filter(r => r.status === 'active').length,
        pending: latest.filter(r => r.status === 'pending').length },
      ...(user.role === 'admin' ? { accounts: accounts().filter(a => a.role !== 'admin').map(publicAccount) } : {}),
      lastCheckedAt: state.lastCheckedAt, syncError: state.syncError, syncing
    };
  }
  return { account, accounts, publicAccount, usage, latestRecords, createAccount, renew, updateAccount, reserve, finish,
    operations: () => state.operations, dashboard,
    updateRecord(record, changes) { Object.assign(record, changes); persist(); },
    updateSync(changes) { Object.assign(state, changes); persist(); } };
}
