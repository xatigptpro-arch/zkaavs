import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createStore, StoreError } from './store.js';
import { hashPassword, verifyPassword } from './auth.js';

const hostname = process.env.PORTAL_HOSTNAME ?? 'canva.zkaavs.app';
const origin = `https://${hostname}`;
const port = Number(process.env.PORT ?? 3600);
const credential = JSON.parse(readFileSync(process.env.PORTAL_PASSWORD_FILE ?? '/run/secrets/portal-password', 'utf8'));
await verifyPassword('', credential); // Validate the bootstrap credential before migrating.
const store = createStore(process.env.PORTAL_STATE_FILE ?? '/data/state.json', credential);
const browserBase = process.env.PORTAL_BROWSER_URL ?? 'http://canva-browser:3500';
const publicFile = file => readFileSync(new URL(`./public/${file}`, import.meta.url));
const loginHtml = publicFile('login.html').toString();
const panelHtml = publicFile('panel.html');
const stylesheet = publicFile('style.css');
const panelScript = publicFile('panel.js');
const sessions = new Map();
const failures = new Map();
const invitationTimes = [];
let browserBusy = false;
let syncPromise = null;

async function browserRequest(route, payload, timeout = 30_000) {
  const response = await fetch(`${browserBase}${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeout)
  });
  return { status: response.status, result: await response.json() };
}

function startSync() {
  if (syncPromise) return syncPromise;
  if (browserBusy) return Promise.resolve();
  browserBusy = true;
  syncPromise = (async () => {
    const current = store.latestRecords().filter(r => !['revoked', 'expired'].includes(r.status));
    const observed = new Map();
    for (let offset = 0; offset < current.length; offset += 200) {
      const { status, result } = await browserRequest('/members', {
        emails: current.slice(offset, offset + 200).map(r => r.email)
      }, 70_000);
      if (status !== 200 || !Array.isArray(result.members)) throw new Error('Canva member lookup failed');
      for (const member of result.members) observed.set(member.email, member.status);
    }
    const checkedAt = new Date().toISOString();
    for (const record of current) {
      const memberStatus = observed.get(record.email);
      if (!['active', 'pending', 'absent'].includes(memberStatus)) continue;
      const expired = record.expiresAt && Date.parse(record.expiresAt) <= Date.now();
      const changes = { lastCheckedAt: checkedAt, revokeError: null,
        status: memberStatus === 'absent' ? expired ? 'expired' : 'absent' : memberStatus };
      if (memberStatus === 'active' && !record.activeSince) changes.activeSince = checkedAt;
      store.updateRecord(record, changes);
      if (!expired || memberStatus === 'absent') continue;
      if (memberStatus === 'active') {
        store.updateRecord(record, { revokeError: 'Canva exige borrar los diseños para quitar el acceso. Confirma la retirada manualmente.' });
        continue;
      }
      try {
        const revoked = await browserRequest('/revoke', { email: record.email }, 70_000);
        if (revoked.status !== 200 || revoked.result.revoked !== true) throw new Error('Revocation not confirmed');
        store.updateRecord(record, { status: 'expired', revokedAt: new Date().toISOString(), revokeError: null });
      } catch {
        store.updateRecord(record, { revokeError: 'No se pudo retirar el acceso. Se intentará de nuevo.' });
      }
    }
    store.updateSync({ lastCheckedAt: checkedAt, syncError: null });
  })().catch(error => {
    console.error('Canva status sync failed:', error.message);
    store.updateSync({ syncError: 'No se pudieron actualizar los estados de Canva.' });
  }).finally(() => { browserBusy = false; syncPromise = null; });
  return syncPromise;
}

function headers(response, type = 'text/html; charset=utf-8') {
  response.setHeader('Content-Type', type);
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'same-origin');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Strict-Transport-Security', 'max-age=31536000');
  response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
}
function send(response, status, content, type) { headers(response, type); response.writeHead(status); response.end(content); }
function json(response, status, message) { send(response, status, JSON.stringify({ message }), 'application/json; charset=utf-8'); }
function dataResponse(response, data) { send(response, 200, JSON.stringify(data), 'application/json; charset=utf-8'); }
function redirect(response, location, cookie) {
  headers(response); response.setHeader('Location', location);
  if (cookie) response.setHeader('Set-Cookie', cookie);
  response.writeHead(303); response.end();
}
const cookie = token => `__Host-zkaavs=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=14400`;
function tokenFrom(request) {
  return request.headers.cookie?.split(';').map(p => p.trim()).find(p => p.startsWith('__Host-zkaavs='))?.slice('__Host-zkaavs='.length);
}
function sessionUser(request) {
  const token = tokenFrom(request);
  const session = sessions.get(token);
  if (!session) return null;
  const user = store.account(session.userId);
  if (!user?.enabled || session.expires < Date.now() || session.version !== user.credentialVersion) {
    sessions.delete(token); return null;
  }
  return user;
}
async function body(request) {
  let size = 0; const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 8192) throw new StoreError(413, 'Solicitud demasiado grande.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
function validPassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 128) {
    throw new StoreError(400, 'La contraseña debe tener entre 12 y 128 caracteres.');
  }
}
function validPlan(data) {
  if (!Number.isInteger(data.monthlyQuota) || data.monthlyQuota < 1 || data.monthlyQuota > 10000
      || !Number.isInteger(data.months) || data.months < 1 || data.months > 36) {
    throw new StoreError(400, 'Elige un cupo de 1 a 10000 y un plazo de 1 a 36 meses.');
  }
}
function requirePlan(user) {
  if (!store.usage(user).allowed) throw new StoreError(403, 'Tu plan no está activo. Puedes consultar tu historial.');
}
function loginPage(response, status = 200, message = '') {
  send(response, status, loginHtml.replace('__LOGIN_ERROR__', message));
}

const server = createServer(async (request, response) => {
  try {
    if (request.url === '/health' && request.method === 'GET') return json(response, 200, 'ok');
    if (request.headers.host !== hostname) return send(response, 421, 'Misdirected Request');
    if (request.headers['x-forwarded-proto'] === 'http') return redirect(response, `${origin}${request.url}`);
    const user = sessionUser(request);
    if (request.url === '/style.css' && request.method === 'GET') return send(response, 200, stylesheet, 'text/css; charset=utf-8');
    if (request.url === '/login' && request.method === 'GET') return user ? redirect(response, '/') : loginPage(response);
    if (request.url === '/login' && request.method === 'POST') {
      if (request.headers.origin !== origin) return send(response, 403, 'Forbidden');
      if (!request.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) return send(response, 415, 'Unsupported Media Type');
      const params = new URLSearchParams(await body(request));
      const username = (params.get('username') ?? '').trim().toLowerCase();
      const password = params.get('password') ?? '';
      const ip = request.headers['cf-connecting-ip'] || request.socket.remoteAddress || 'unknown';
      const keys = [`ip:${ip}`, `user:${username}`];
      if (username.length > 64 || password.length > 256) return loginPage(response, 401, 'Usuario o contraseña incorrectos.');
      for (const key of keys) {
        const recent = (failures.get(key) ?? []).filter(at => Date.now() - at < 15 * 60_000);
        if (recent.length >= 10) return loginPage(response, 429, 'Demasiados intentos. Intenta en 15 minutos.');
        recent.push(Date.now()); failures.set(key, recent);
      }
      const candidate = store.accounts().find(a => a.username === username);
      const valid = await verifyPassword(password, candidate?.credential ?? credential);
      if (!candidate?.enabled || !valid) return loginPage(response, 401, 'Usuario o contraseña incorrectos.');
      for (const key of keys) failures.delete(key);
      const token = randomBytes(32).toString('base64url');
      const existing = [...sessions.entries()].filter(([, s]) => s.userId === candidate.id);
      if (existing.length >= 5) sessions.delete(existing[0][0]);
      sessions.set(token, { userId: candidate.id, version: candidate.credentialVersion, expires: Date.now() + 4 * 60 * 60_000 });
      return redirect(response, '/', cookie(token));
    }
    if (request.url === '/' && request.method === 'GET') return user ? send(response, 200, panelHtml) : redirect(response, '/login');
    if (request.url === '/panel.js' && request.method === 'GET') return user ? send(response, 200, panelScript, 'text/javascript; charset=utf-8') : send(response, 403, 'Forbidden');
    if (request.url === '/logout' && request.method === 'POST') {
      if (request.headers.origin !== origin) return send(response, 403, 'Forbidden');
      sessions.delete(tokenFrom(request)); return redirect(response, '/login', '__Host-zkaavs=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0');
    }
    if (request.url.startsWith('/api/') || request.url === '/invite') {
      if (!user) return json(response, 401, 'Inicia sesión de nuevo.');
      if (request.method === 'POST') {
        if (request.headers.origin !== origin) return json(response, 403, 'Solicitud no autorizada.');
        if (!request.headers['content-type']?.startsWith('application/json')) return json(response, 415, 'Formato inválido.');
      }
    }
    if (request.url === '/api/dashboard' && request.method === 'GET') return dataResponse(response, store.dashboard(user, Boolean(syncPromise)));
    if (request.url === '/api/password' && request.method === 'POST') {
      const data = JSON.parse(await body(request)); validPassword(data.password);
      if (typeof data.currentPassword !== 'string' || data.currentPassword.length > 256
          || !await verifyPassword(data.currentPassword, user.credential)) return json(response, 403, 'La contraseña actual es incorrecta.');
      const next = await hashPassword(data.password);
      store.updateAccount(user, { credential: next, credentialVersion: user.credentialVersion + 1 });
      sessions.get(tokenFrom(request)).version = user.credentialVersion;
      return json(response, 200, 'Contraseña actualizada. Las demás sesiones se cerraron.');
    }
    if (request.url.startsWith('/api/admin/')) {
      if (user.role !== 'admin') return json(response, 403, 'Acceso exclusivo de administración.');
      if (request.url === '/api/admin/accounts' && request.method === 'POST') {
        const data = JSON.parse(await body(request)); validPlan(data); validPassword(data.password);
        const username = typeof data.username === 'string' ? data.username.trim().toLowerCase() : '';
        const name = typeof data.name === 'string' ? data.name.trim() : '';
        if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(username) || name.length < 1 || name.length > 80) return json(response, 400, 'Elige un usuario de 3 a 64 caracteres y un nombre de hasta 80.');
        if (store.accounts().length >= 1000) return json(response, 409, 'Se alcanzó el máximo de cuentas.');
        const created = store.createAccount({ username, name, credential: await hashPassword(data.password), monthlyQuota: data.monthlyQuota, months: data.months });
        return dataResponse(response, { message: 'Cuenta creada.', account: created });
      }
      if (request.url === '/api/admin/account' && request.method === 'POST') {
        const data = JSON.parse(await body(request));
        const target = store.account(data.id);
        if (!target || target.role !== 'operator') return json(response, 404, 'Cuenta no encontrada.');
        if (data.action === 'renew') {
          validPlan(data); store.renew(target, data.monthlyQuota, data.months);
          return json(response, 200, 'Plan renovado. El saldo del período activo se conserva.');
        }
        if (data.action === 'suspend' || data.action === 'activate') {
          store.updateAccount(target, { enabled: data.action === 'activate', credentialVersion: target.credentialVersion + 1 });
          return json(response, 200, data.action === 'activate' ? 'Cuenta habilitada.' : 'Cuenta suspendida. Sus sesiones se cerraron.');
        }
        if (data.action === 'password') {
          validPassword(data.password);
          store.updateAccount(target, { credential: await hashPassword(data.password), credentialVersion: target.credentialVersion + 1 });
          return json(response, 200, 'Contraseña restablecida. Las sesiones anteriores se cerraron.');
        }
        return json(response, 400, 'Acción inválida.');
      }
      if (request.url === '/api/admin/resolve' && request.method === 'POST') {
        const data = JSON.parse(await body(request));
        const operation = store.operations().find(o => o.id === data.id && o.status === 'uncertain');
        if (!operation || typeof data.sent !== 'boolean') return json(response, 404, 'Envío por comprobar no encontrado.');
        if (browserBusy) return json(response, 409, 'Hay otra operación en curso. Intenta en unos segundos.');
        browserBusy = true;
        try {
          const check = await browserRequest('/members', { emails: [operation.email] }, 70_000);
          const observed = check.result.members?.find(m => m.email === operation.email)?.status;
          if (check.status !== 200 || !['active', 'pending', 'absent'].includes(observed)) return json(response, 424, 'No se pudo comprobar el envío en Canva.');
          if (data.sent !== (observed !== 'absent')) return json(response, 409, 'El estado de Canva no coincide. Revisa la invitación antes de resolverla.');
          store.finish(operation, data.sent ? 'confirmed' : 'failed');
          if (data.sent && observed === 'active') {
            const record = store.latestRecords().find(r => r.email === operation.email);
            store.updateRecord(record, { status: 'active', activeSince: new Date().toISOString(), lastCheckedAt: new Date().toISOString() });
          }
          return json(response, 200, data.sent ? 'Envío confirmado y contabilizado.' : 'Canva no muestra la invitación. Cupo liberado.');
        } finally { browserBusy = false; }
      }
    }
    if (request.url === '/invite' && request.method === 'POST') {
      requirePlan(user);
      const data = JSON.parse(await body(request));
      const email = typeof data.email === 'string' ? data.email.trim().toLowerCase() : '';
      if (email.length > 254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) return json(response, 400, 'Comprueba el correo electrónico.');
      if (!Number.isInteger(data.durationDays) || data.durationDays < 1 || data.durationDays > 3650) return json(response, 400, 'Elige una duración de 1 a 3650 días.');
      if (typeof data.requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(data.requestId)) return json(response, 400, 'Recarga el formulario e intenta de nuevo.');
      if (browserBusy) return json(response, 409, 'Hay otra operación en curso. Intenta en unos segundos.');
      while (invitationTimes.length && Date.now() - invitationTimes[0] > 60 * 60_000) invitationTimes.shift();
      if (invitationTimes.length >= 30) return json(response, 429, 'Se alcanzó el límite temporal de envíos. Intenta más tarde.');
      const { operation, reused } = store.reserve(user, email, data.durationDays, data.requestId);
      if (reused) return json(response, operation.status === 'confirmed' ? 200 : 409,
        operation.status === 'confirmed' ? 'Esta invitación ya fue confirmada.' : 'Esta solicitud ya fue procesada. Revisa los envíos por comprobar.');
      invitationTimes.push(Date.now()); browserBusy = true;
      try {
        const upstream = await browserRequest('/invite', { email });
        if (upstream.status === 200) {
          store.finish(operation, 'confirmed');
          return json(response, 200, 'Canva confirmó el envío de la invitación.');
        }
        const uncertain = ![400, 409, 429].includes(upstream.status);
        store.finish(operation, uncertain ? 'uncertain' : 'failed');
        return json(response, uncertain ? 424 : upstream.status, uncertain
          ? 'No se confirmó el envío. Se reservó un cupo hasta que administración compruebe el resultado.'
          : upstream.result.message ?? 'No se pudo enviar la invitación.');
      } catch (error) {
        console.error('Invitation failed:', error.message);
        store.finish(operation, 'uncertain');
        return json(response, 424, 'No se confirmó el envío. Se reservó un cupo hasta que administración compruebe el resultado.');
      } finally { browserBusy = false; }
    }
    if (request.url === '/api/sync' && request.method === 'POST') {
      if (browserBusy) return json(response, 409, 'Hay otra operación en curso. Intenta en unos segundos.');
      startSync(); return json(response, 202, 'Actualizando estados.');
    }
    if (request.url === '/api/revoke' && request.method === 'POST') {
      requirePlan(user);
      const data = JSON.parse(await body(request));
      const record = store.latestRecords().find(r => r.id === data.id && (user.role === 'admin' || r.ownerId === user.id));
      if (!record || !['active', 'pending'].includes(record.status)) return json(response, 404, 'Esta invitación no está activa.');
      const allowDesignDeletion = data.allowDesignDeletion === true;
      if (record.status === 'active' && !allowDesignDeletion) return json(response, 409, 'Canva puede borrar los diseños de esta persona. Confirma la retirada desde el panel.');
      if (browserBusy) return json(response, 409, 'Hay otra operación en curso. Intenta en unos segundos.');
      browserBusy = true;
      try {
        const revoked = await browserRequest('/revoke', { email: record.email, allowDesignDeletion }, 70_000);
        if (revoked.status !== 200 || revoked.result.revoked !== true) return json(response, 424, revoked.result.message ?? 'Canva no confirmó la revocación.');
        store.updateRecord(record, { status: 'revoked', revokedAt: new Date().toISOString(), revokeError: null });
        return json(response, 200, 'Canva confirmó la revocación.');
      } catch (error) {
        console.error('Manual revocation failed:', error.message);
        return json(response, 424, 'No se pudo confirmar la revocación en Canva.');
      } finally { browserBusy = false; }
    }
    return send(response, 404, 'Not Found');
  } catch (error) {
    if (error instanceof StoreError) return json(response, error.status, error.message);
    console.error('Portal request failed:', error.name);
    return json(response, 400, 'Solicitud inválida.');
  }
});
server.requestTimeout = 90_000;
server.listen(port, '0.0.0.0', () => console.log(`Portal listening on ${server.address().port}`));
if (process.env.PORTAL_DISABLE_SYNC !== '1') {
  setTimeout(startSync, 30_000).unref();
  setInterval(startSync, 15 * 60_000).unref();
}
setInterval(() => {
  for (const [token, session] of sessions) if (session.expires <= Date.now()) sessions.delete(token);
  for (const [key, attempts] of failures) if (attempts.every(at => Date.now() - at >= 15 * 60_000)) failures.delete(key);
}, 60_000).unref();
