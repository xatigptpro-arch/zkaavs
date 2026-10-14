import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const hostname = 'canva.zkaavs.app';
const origin = `https://${hostname}`;
const port = Number(process.env.PORT ?? 3600);
const { salt, hash } = JSON.parse(readFileSync('/run/secrets/portal-password', 'utf8'));
const passwordSalt = Buffer.from(salt, 'base64');
const passwordHash = Buffer.from(hash, 'base64');
if (passwordSalt.length !== 32 || passwordHash.length !== 32) {
  throw new Error('Invalid portal password hash');
}

const loginHtml = readFileSync(new URL('./public/login.html', import.meta.url));
const panelHtml = readFileSync(new URL('./public/panel.html', import.meta.url));
const stylesheet = readFileSync(new URL('./public/style.css', import.meta.url));
const panelScript = readFileSync(new URL('./public/panel.js', import.meta.url));
const sessions = new Map();
const failures = new Map();
const invitationTimes = [];

function headers(response, type = 'text/html; charset=utf-8') {
  response.setHeader('Content-Type', type);
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'same-origin');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Strict-Transport-Security', 'max-age=31536000');
  response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
}

function send(response, status, body, type) {
  headers(response, type);
  response.writeHead(status);
  response.end(body);
}

function json(response, status, message) {
  send(response, status, JSON.stringify({ message }), 'application/json; charset=utf-8');
}

function redirect(response, location, cookie) {
  headers(response);
  response.setHeader('Location', location);
  if (cookie) response.setHeader('Set-Cookie', cookie);
  response.writeHead(303);
  response.end();
}

function session(request) {
  const raw = request.headers.cookie?.split(';').map(part => part.trim())
    .find(part => part.startsWith('__Host-zkaavs='))?.slice('__Host-zkaavs='.length);
  if (!raw) return null;
  const expires = sessions.get(raw);
  if (!expires) return null;
  if (expires < Date.now()) {
    sessions.delete(raw);
    return null;
  }
  return raw;
}

function clientKey(request) {
  return request.headers['cf-connecting-ip'] || request.socket.remoteAddress || 'unknown';
}

async function body(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 2048) throw new Error('body_too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function sameOrigin(request) {
  return request.headers.origin === origin;
}

const server = createServer(async (request, response) => {
  try {
    if (request.url === '/health' && request.method === 'GET') {
      return json(response, 200, 'ok');
    }
    if (request.headers.host !== hostname) return send(response, 421, 'Misdirected Request');
    if (request.headers['x-forwarded-proto'] === 'http') {
      return redirect(response, `${origin}${request.url}`);
    }
    if (request.url === '/style.css' && request.method === 'GET') {
      return send(response, 200, stylesheet, 'text/css; charset=utf-8');
    }
    if (request.url === '/panel.js' && request.method === 'GET') {
      if (!session(request)) return send(response, 403, 'Forbidden');
      return send(response, 200, panelScript, 'text/javascript; charset=utf-8');
    }
    if (request.url === '/login' && request.method === 'GET') {
      if (session(request)) return redirect(response, '/');
      return send(response, 200, loginHtml);
    }
    if (request.url === '/' && request.method === 'GET') {
      if (!session(request)) return redirect(response, '/login');
      return send(response, 200, panelHtml);
    }
    if (request.url === '/login' && request.method === 'POST') {
      if (!sameOrigin(request)) return send(response, 403, 'Forbidden');
      if (!request.headers['content-type']?.startsWith('application/x-www-form-urlencoded')) {
        return send(response, 415, 'Unsupported Media Type');
      }
      const key = clientKey(request);
      const recent = (failures.get(key) ?? []).filter(at => Date.now() - at < 15 * 60_000);
      if (recent.length >= 5) return send(response, 429, 'Demasiados intentos. Intenta en 15 minutos.');
      const password = new URLSearchParams(await body(request)).get('password') ?? '';
      if (password.length > 256) return send(response, 400, 'Contraseña inválida.');
      const candidate = scryptSync(password, passwordSalt, passwordHash.length);
      if (!timingSafeEqual(candidate, passwordHash)) {
        recent.push(Date.now());
        failures.set(key, recent);
        return send(response, 401, 'Contraseña incorrecta. <a href="/login">Volver</a>');
      }
      failures.delete(key);
      sessions.clear();
      const token = randomBytes(32).toString('base64url');
      sessions.set(token, Date.now() + 4 * 60 * 60_000);
      return redirect(response, '/', `__Host-zkaavs=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=14400`);
    }
    if (request.url === '/logout' && request.method === 'POST') {
      if (!sameOrigin(request)) return send(response, 403, 'Forbidden');
      const token = session(request);
      if (token) sessions.delete(token);
      return redirect(response, '/login', '__Host-zkaavs=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0');
    }
    if (request.url === '/invite' && request.method === 'POST') {
      if (!session(request)) return json(response, 401, 'Inicia sesión de nuevo.');
      if (!sameOrigin(request)) return json(response, 403, 'Solicitud no autorizada.');
      if (!request.headers['content-type']?.startsWith('application/json')) {
        return json(response, 415, 'Formato inválido.');
      }
      const data = JSON.parse(await body(request));
      const email = typeof data.email === 'string' ? data.email.trim().toLowerCase() : '';
      if (email.length > 254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) || data.confirmed !== true) {
        return json(response, 400, 'Comprueba el correo y la autorización de la persona.');
      }
      while (invitationTimes.length && Date.now() - invitationTimes[0] > 60 * 60_000) {
        invitationTimes.shift();
      }
      if (invitationTimes.length >= 30) return json(response, 429, 'Límite de 30 invitaciones por hora.');
      invitationTimes.push(Date.now());
      try {
        const upstream = await fetch('http://canva-browser:3500/invite', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email }),
          signal: AbortSignal.timeout(30_000)
        });
        const result = await upstream.json();
        return json(response, upstream.status, result.message ?? 'Canva no pudo confirmar la invitación.');
      } catch {
        return json(response, 503, 'El navegador de Canva no está disponible.');
      }
    }
    return send(response, 404, 'Not Found');
  } catch (error) {
    if (error.message === 'body_too_large') return send(response, 413, 'Solicitud demasiado grande.');
    return send(response, 400, 'Solicitud inválida.');
  }
});

server.requestTimeout = 35_000;
server.listen(port, '0.0.0.0', () => console.log(`Portal listening on ${port}`));
