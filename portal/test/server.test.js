import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { hashPassword } from '../auth.js';
import { createStore } from '../store.js';

const password = 'Test-password-only-12345';
test('HTTP tenant isolation, quota, renewal, session revocation, concurrent requests and uncertain sends', { timeout: 30000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'portal-http-'));
  const members = new Map(); const calls = [];
  const mock = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const data = JSON.parse(Buffer.concat(chunks).toString()); calls.push({ route: req.url, ...data });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/invite') {
      await new Promise(resolve => setTimeout(resolve, 80));
      if (data.email.startsWith('failed')) { res.writeHead(409); return res.end(JSON.stringify({ message: 'Busy' })); }
      if (!data.email.startsWith('absent')) members.set(data.email, 'pending');
      if (data.email.startsWith('uncertain') || data.email.startsWith('absent')) { res.writeHead(424); return res.end('{}'); }
      return res.end(JSON.stringify({ message: 'Confirmed' }));
    }
    if (req.url === '/revoke') { members.delete(data.email); return res.end(JSON.stringify({ revoked: true })); }
    if (req.url === '/members') return res.end(JSON.stringify({ members: data.emails.map(email => ({ email, status: members.get(email) ?? 'absent' })) }));
    res.writeHead(404); res.end('{}');
  });
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  const credential = await hashPassword(password);
  const secret = join(dir, 'secret.json'); const state = join(dir, 'state.json');
  writeFileSync(secret, JSON.stringify(credential));
  const fixture = createStore(state, credential, () => Date.parse('2025-01-01T00:00:00Z'));
  fixture.createAccount({ username: 'expired', name: 'Expired', credential, monthlyQuota: 1, months: 1 });
  const child = spawn(process.execPath, ['server.js'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, PORT: '0', PORTAL_HOSTNAME: 'portal.test', PORTAL_PASSWORD_FILE: secret,
      PORTAL_STATE_FILE: state, PORTAL_BROWSER_URL: `http://127.0.0.1:${mock.address().port}`, PORTAL_DISABLE_SYNC: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = ''; child.stderr.on('data', d => { output += d; });
  try {
    const port = await new Promise((resolve, reject) => {
      child.stdout.on('data', d => { const match = d.toString().match(/Portal listening on (\d+)/); if (match) resolve(Number(match[1])); });
      child.on('exit', code => reject(new Error(`Portal exited ${code}: ${output}`)));
    });
    async function request(path, { token, method = 'GET', body, origin = 'https://portal.test', raw } = {}) {
      return new Promise((resolve, reject) => {
        const req = httpRequest({ hostname: '127.0.0.1', port, path, method,
          headers: { host: 'portal.test', ...(token ? { cookie: token } : {}),
            ...(method === 'POST' ? { origin, 'content-type': raw !== undefined ? 'application/x-www-form-urlencoded' : 'application/json' } : {}) }
        }, response => {
          const chunks = [];
          response.on('data', chunk => chunks.push(chunk));
          response.on('end', () => {
            const text = Buffer.concat(chunks).toString();
            resolve({ status: response.statusCode, cookie: response.headers['set-cookie']?.[0]?.split(';')[0],
              body: response.headers['content-type']?.includes('json') ? JSON.parse(text) : text });
          });
        });
        req.on('error', reject);
        req.end(method === 'POST' ? raw ?? JSON.stringify(body ?? {}) : undefined);
      });
    }
    async function login(username, pass = password) {
      const result = await request('/login', { method: 'POST', raw: new URLSearchParams({ username, password: pass }).toString() });
      assert.equal(result.status, 303); return result.cookie;
    }
    async function dashboard(token) { const r = await request('/api/dashboard', { token }); assert.equal(r.status, 200); return r.body; }
    async function create(username, quota) {
      const r = await request('/api/admin/accounts', { token: admin, method: 'POST', body: { username, name: username, password, months: 1, monthlyQuota: quota } });
      assert.equal(r.status, 200); return r.body.account.id;
    }
    function invite(token, email, requestId = randomUUID(), extras = {}) {
      return request('/invite', { token, method: 'POST', body: { email, durationDays: 13, requestId, ...extras } });
    }
    assert.equal((await request('/api/dashboard')).status, 401);
    const admin = await login('admin');
    const alphaId = await create('alpha', 1); const betaId = await create('beta', 2); await create('gamma', 1);
    const alpha = await login('alpha'); const beta = await login('beta'); const gamma = await login('gamma');
    assert.equal((await dashboard(admin)).me.role, 'admin'); // Logging in others must not close admin's session.
    assert.equal((await request('/api/admin/account', { token: alpha, method: 'POST', body: { id: betaId, action: 'suspend' } })).status, 403);
    assert.equal((await invite(alpha, 'csrf@example.test', randomUUID(), { ownerId: betaId })).status, 200);
    let d = await dashboard(alpha); const alphaRecord = d.invitations[0];
    assert.equal(alphaRecord.ownerId, alphaId); // Spoofed ownerId is ignored.
    assert.equal(d.me.usage.remaining, 0);
    assert.equal((await dashboard(beta)).invitations.length, 0);
    assert.ok(!JSON.stringify(d).includes('credential'));
    assert.equal((await invite(alpha, 'over@example.test')).status, 429);
    const before = calls.length;
    assert.equal((await request('/api/revoke', { token: beta, method: 'POST', body: { id: alphaRecord.id } })).status, 404);
    assert.equal(calls.length, before); // Foreign IDs must never reach Canva.
    assert.equal((await request('/api/revoke', { token: alpha, method: 'POST', body: { id: alphaRecord.id } })).status, 200);
    assert.equal((await dashboard(alpha)).me.usage.remaining, 0);
    assert.equal((await request('/api/admin/account', { token: admin, method: 'POST', body: { id: alphaId, action: 'renew', months: 1, monthlyQuota: 1 } })).status, 200);
    assert.equal((await dashboard(alpha)).me.usage.sent, 1);
    assert.equal((await dashboard(alpha)).me.usage.remaining, 0);
    assert.equal((await request('/invite', { token: alpha, method: 'POST', origin: 'https://evil.test', body: { email: 'evil@example.test', durationDays: 1, requestId: randomUUID() } })).status, 403);
    const expired = await login('expired');
    assert.equal((await dashboard(expired)).me.usage.allowed, false);
    assert.equal((await invite(expired, 'expired@example.test')).status, 403);
    const concurrent = await Promise.all([invite(gamma, 'one@example.test'), invite(gamma, 'two@example.test')]);
    assert.deepEqual(concurrent.map(r => r.status).sort(), [200, 409]);
    assert.equal((await dashboard(gamma)).me.usage.sent, 1);
    assert.equal((await invite(beta, 'uncertain@example.test')).status, 424);
    assert.equal((await dashboard(beta)).me.usage.reserved, 1);
    assert.equal((await invite(beta, 'failed@example.test')).status, 409);
    assert.equal((await dashboard(beta)).me.usage.remaining, 1);
    const retryId = randomUUID();
    assert.equal((await invite(beta, 'ok@example.test', retryId)).status, 200);
    const sentCalls = calls.filter(c => c.route === '/invite').length;
    assert.equal((await invite(beta, 'ok@example.test', retryId)).status, 200);
    assert.equal(calls.filter(c => c.route === '/invite').length, sentCalls);
    assert.equal((await invite(beta, 'over-beta@example.test')).status, 429);
    const operation = (await dashboard(beta)).operations[0];
    assert.equal((await request('/api/admin/resolve', { token: beta, method: 'POST', body: { id: operation.id, sent: true } })).status, 403);
    assert.equal((await request('/api/admin/resolve', { token: admin, method: 'POST', body: { id: operation.id, sent: true } })).status, 200);
    assert.equal((await dashboard(beta)).me.usage.sent, 2);
    assert.equal((await dashboard(beta)).me.usage.reserved, 0);
    assert.equal((await request('/api/admin/account', { token: admin, method: 'POST', body: { id: alphaId, action: 'suspend' } })).status, 200);
    assert.equal((await request('/api/dashboard', { token: alpha })).status, 401);
    assert.equal((await request('/login', { method: 'POST', raw: new URLSearchParams({ username: 'alpha', password }).toString() })).status, 401);
    await request('/api/admin/account', { token: admin, method: 'POST', body: { id: alphaId, action: 'activate' } });
    const alpha2 = await login('alpha');
    await request('/api/admin/account', { token: admin, method: 'POST', body: { id: alphaId, action: 'password', password: `${password}-reset` } });
    assert.equal((await request('/api/dashboard', { token: alpha2 })).status, 401);
    await login('alpha', `${password}-reset`);
    const admin2 = await login('admin');
    assert.equal((await request('/api/password', { token: admin2, method: 'POST', body: { currentPassword: password, password: `${password}-changed` } })).status, 200);
    assert.equal((await request('/api/dashboard', { token: admin })).status, 401);
    assert.equal((await dashboard(admin2)).me.role, 'admin');
  } finally {
    child.kill('SIGTERM');
    await new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve); });
    await new Promise(resolve => mock.close(resolve));
    rmSync(dir, { recursive: true });
  }
});
