import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { addMonths, createStore } from '../store.js';
const credential = { salt: Buffer.alloc(32).toString('base64'), hash: Buffer.alloc(32).toString('base64') };

test('migration preserves history, backs up v1, and assigns legacy invitations to admin', () => {
  const dir = mkdtempSync(join(tmpdir(), 'portal-migration-'));
  try {
    const path = join(dir, 'state.json');
    const old = { version: 1, records: [{ id: 'old', email: 'old@example.test', invitedAt: null, status: 'revoked' }] };
    writeFileSync(path, JSON.stringify(old));
    const store = createStore(path, credential);
    const admin = store.accounts()[0];
    assert.equal(admin.username, 'admin');
    assert.deepEqual(JSON.parse(readFileSync(`${path}.v1.backup`)), old);
    assert.equal(store.dashboard(admin).invitations[0].ownerId, admin.id);
    assert.equal(JSON.parse(readFileSync(path)).version, 2);
    assert.equal(createStore(path, credential).accounts().length, 1);
  } finally { rmSync(dir, { recursive: true }); }
});

test('monthly anniversary, revocation keeps consumption, renewals do not reset active quota', () => {
  const dir = mkdtempSync(join(tmpdir(), 'portal-plans-'));
  let now = Date.parse('2026-01-31T10:00:00.000Z');
  try {
    const store = createStore(join(dir, 'state.json'), credential, () => now);
    const user = store.account(store.createAccount({ username: 'alice', name: 'Alice', credential, monthlyQuota: 1, months: 1 }).id);
    const other = store.account(store.createAccount({ username: 'bob', name: 'Bob', credential, monthlyQuota: 1, months: 1 }).id);
    const requestId = randomUUID();
    const { operation } = store.reserve(user, 'client@example.test', 9, requestId);
    assert.equal(store.usage(user).reserved, 1);
    assert.throws(() => store.reserve(user, 'another@example.test', 9, randomUUID()), /agotado/);
    store.finish(operation, 'confirmed');
    assert.equal(store.usage(user).sent, 1);
    assert.equal(store.usage(user).reserved, 0);
    store.updateRecord(store.latestRecords()[0], { status: 'revoked' });
    assert.equal(store.usage(user).remaining, 0);
    assert.equal(store.dashboard(other).invitations.length, 0);
    assert.equal(store.dashboard(user).invitations.length, 1);
    assert.equal(store.reserve(user, operation.email, 9, requestId).reused, true);
    assert.throws(() => store.reserve(other, operation.email, 9, requestId), /utilizada/);
    store.renew(user, 1, 1);
    assert.equal(user.plan.expiresAt, '2026-03-31T10:00:00.000Z');
    assert.equal(store.usage(user).sent, 1);
    now = Date.parse('2026-02-28T09:59:59.999Z');
    assert.equal(store.usage(user).sent, 1);
    now = Date.parse('2026-02-28T10:00:00.000Z');
    assert.equal(store.usage(user).remaining, 1);
    assert.equal(store.usage(user).end, '2026-03-31T10:00:00.000Z');
    now = Date.parse('2026-03-31T10:00:00.000Z');
    assert.equal(store.usage(user).allowed, false);
    assert.throws(() => store.reserve(user, 'new@example.test', 1, randomUUID()), /no está activo/);
    store.renew(user, 2, 1);
    assert.equal(store.usage(user).allowed, true);
    assert.equal(store.usage(user).remaining, 2);
    assert.equal(user.plan.startedAt, new Date(now).toISOString());
  } finally { rmSync(dir, { recursive: true }); }
});

test('interrupted requests reserve quota across restart; explicit failed result frees quota', () => {
  const dir = mkdtempSync(join(tmpdir(), 'portal-reservations-'));
  try {
    const path = join(dir, 'state.json');
    let store = createStore(path, credential);
    const id = store.createAccount({ username: 'alice', name: 'Alice', credential, monthlyQuota: 1, months: 1 }).id;
    store.reserve(store.account(id), 'uncertain@example.test', 3, randomUUID());
    store = createStore(path, credential);
    assert.equal(store.operations()[0].status, 'uncertain');
    assert.equal(store.usage(store.account(id)).remaining, 0);
    store.finish(store.operations()[0], 'failed');
    assert.equal(store.usage(store.account(id)).remaining, 1);
    assert.ok(!JSON.stringify(store.dashboard(store.account(id))).includes('credential'));
  } finally { rmSync(dir, { recursive: true }); }
});

test('month arithmetic handles leap years and preserves time', () => {
  assert.equal(addMonths('2024-01-31T17:45:00.000Z', 1), '2024-02-29T17:45:00.000Z');
  assert.equal(addMonths('2026-01-31T17:45:00.000Z', 1), '2026-02-28T17:45:00.000Z');
  assert.equal(addMonths('2026-12-31T17:45:00.000Z', 2), '2027-02-28T17:45:00.000Z');
});
