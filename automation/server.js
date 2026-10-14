import express from 'express';
import { chromium } from 'playwright';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));

let context;
let page;
let ready = false;
let inviting = false;
let lastInvitation = null;
let managing = false;
let peoplePage;
const emailPattern = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

async function startBrowser() {
  if (process.env.BROWSER_MODE === 'cdp') {
    let browser;
    for (let attempt = 0; attempt < 80; attempt++) {
      try {
        browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
        break;
      } catch {
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    }
    if (!browser) throw new Error('Chrome debugging endpoint did not start');
    browser.on('disconnected', () => {
      ready = false;
      console.error('Chrome disconnected');
      process.exit(1);
    });
    context = browser.contexts()[0];
    page = context.pages().find(candidate => candidate.url().startsWith('https://www.canva.com/templates'))
      ?? context.pages().find(candidate => candidate.url().includes('canva.com'))
      ?? context.pages()[0] ?? await context.newPage();
  } else {
    context = await chromium.launchPersistentContext('/profile/chrome-stable', {
      executablePath: '/usr/bin/google-chrome',
      headless: false,
      viewport: { width: 1440, height: 900 },
      args: ['--no-sandbox', '--disable-dev-shm-usage']
    });
    page = context.pages()[0] ?? await context.newPage();
  }
  if (page.url() === 'about:blank') await page.goto('https://www.canva.com/');
  ready = true;
  console.log('Canva browser ready for manual sign-in via VNC');
}

app.get('/health', (_request, response) => {
  response.json({ ok: ready });
});

app.post('/invite', async (request, response) => {
  const email = typeof request.body?.email === 'string'
    ? request.body.email.trim().toLowerCase() : '';
  if (!emailPattern.test(email) || email.length > 254) {
    return response.status(400).json({ message: 'Correo inválido.' });
  }
  if (!ready) return response.status(424).json({ message: 'La sesión de Canva no está disponible.' });
  if (inviting || managing) return response.status(409).json({ message: 'Hay otra operación de Canva en curso.' });
  if (lastInvitation?.email === email && Date.now() - lastInvitation.at < 60_000) {
    return response.status(409).json({ message: 'Ya se solicitó esta invitación hace menos de un minuto.' });
  }
  inviting = true;
  try {
    const canvaPage = page;
    if (!canvaPage) throw new Error('Canva tab is missing');
    const blocked = await canvaPage.title();
    if (blocked === 'Just a moment...') {
      return response.status(424).json({ message: 'Canva está solicitando una verificación manual.' });
    }
    let dialog = canvaPage.getByRole('dialog').filter({
      hasText: 'Invita personas a tu equipo escolar'
    });
    if (await dialog.count() === 0) {
      await canvaPage.getByRole('button', { name: 'Invitar a mis estudiantes' }).click();
      await dialog.waitFor({ state: 'visible', timeout: 10_000 });
    }
    const input = dialog.getByRole('textbox', {
      name: 'Escribir el correo electrónico de la persona 1'
    });
    const role = dialog.getByRole('combobox', { name: 'Asignarle un rol a la persona 1' });
    if (await role.count() !== 1 || (await role.innerText()).trim() !== 'Estudiante') {
      throw new Error('Student role is not selected');
    }
    await input.fill(email);
    const submit = dialog.getByRole('button', { name: 'Enviar invitaciones' });
    await submit.waitFor({ state: 'visible', timeout: 5_000 });
    if (!await submit.isEnabled()) throw new Error('Invite button is disabled');
    await submit.click();
    lastInvitation = { email, at: Date.now() };

    // Require Canva's confirmation for this address; a closed dialog alone
    // does not prove delivery.
    await canvaPage.waitForFunction(address => {
      const visible = document.body?.innerText ?? '';
      return visible.includes(address)
        && /se envi[oó] una invitaci[oó]n a/i.test(visible);
    }, email, { timeout: 15_000 });
    return response.json({ message: 'Canva confirmó el envío de la invitación.' });
  } catch (error) {
    console.error('Canva invitation failed:', error.message);
    return response.status(424).json({ message: 'No pude confirmar el envío en Canva. Revísalo allí antes de volver a intentar.' });
  } finally {
    inviting = false;
  }
});

async function loadPeople() {
  if (!ready) throw new Error('Canva browser is unavailable');
  if (!peoplePage || peoplePage.isClosed()) {
    peoplePage = context.pages().find(candidate => candidate.url().includes('/settings/people'))
      ?? await context.newPage();
  }
  if (!peoplePage.url().includes('/settings/people')) {
    await peoplePage.goto('https://www.canva.com/settings/people', {
      waitUntil: 'domcontentloaded', timeout: 25_000
    });
  } else {
    await peoplePage.reload({ waitUntil: 'domcontentloaded', timeout: 25_000 });
  }
  if ((await peoplePage.title()) === 'Just a moment...') {
    throw new Error('Canva requires manual verification');
  }
  await peoplePage.getByRole('heading', { name: /^Personas/ }).waitFor({ timeout: 45_000 });
  await peoplePage.getByRole('row').nth(1).waitFor({ timeout: 10_000 });
  await peoplePage.waitForTimeout(1500);
  return peoplePage;
}

async function personRow(canvaPage, email) {
  const row = canvaPage.getByRole('row').filter({
    has: canvaPage.getByText(email, { exact: true })
  });
  const count = await row.count();
  if (count > 1) throw new Error('Ambiguous Canva member row');
  return count ? row : null;
}

app.post('/members', async (request, response) => {
  const emails = request.body?.emails;
  if (!Array.isArray(emails) || emails.length > 200
      || emails.some(email => typeof email !== 'string' || !emailPattern.test(email))) {
    return response.status(400).json({ message: 'Correos inválidos.' });
  }
  if (inviting || managing) return response.status(409).json({ message: 'Canva está ocupado.' });
  managing = true;
  try {
    const canvaPage = await loadPeople();
    const members = [];
    for (const email of [...new Set(emails)]) {
      const row = await personRow(canvaPage, email);
      const status = !row ? 'absent'
        : await row.getByText('Invitación enviada', { exact: true }).count() ? 'pending' : 'active';
      members.push({ email, status });
    }
    return response.json({ members });
  } catch (error) {
    console.error('Canva member lookup failed:', error.message);
    return response.status(424).json({ message: 'No se pudo consultar la lista de Canva.' });
  } finally {
    managing = false;
  }
});

async function confirmRemoval(canvaPage, pending, allowDesignDeletion) {
  for (let step = 0; step < 3; step++) {
    const modal = canvaPage.getByRole('alertdialog').last();
    const dialog = await modal.isVisible().catch(() => false)
      ? modal : canvaPage.getByRole('dialog').last();
    if (!await dialog.isVisible().catch(() => false)) return;
    const text = await dialog.innerText();
    if (/eliminar.*diseñ|delete.*design/i.test(text)) {
      const safe = dialog.getByRole('radio', { name: /solo.*quitar|remove.*only/i });
      if (await safe.count() === 1) {
        await safe.check();
      } else if (!allowDesignDeletion) {
        throw new Error('Canva requires explicit approval to delete designs');
      }
    }
    const names = pending
      ? [/^Cancelar invitación$/, /^Confirmar$/]
      : [/^Continuar$/, /^Quitar de la escuela$/, /^Quitar$/];
    let button;
    for (const name of names) {
      const candidate = dialog.getByRole('button', { name });
      if (await candidate.count() === 1) { button = candidate; break; }
    }
    if (!button) throw new Error('Unrecognized Canva removal confirmation');
    await button.click();
    await canvaPage.waitForTimeout(400);
  }
}

app.post('/revoke', async (request, response) => {
  const email = typeof request.body?.email === 'string'
    ? request.body.email.trim().toLowerCase() : '';
  if (!emailPattern.test(email) || email.length > 254) {
    return response.status(400).json({ message: 'Correo inválido.' });
  }
  const allowDesignDeletion = request.body?.allowDesignDeletion === true;
  if (inviting || managing) return response.status(409).json({ message: 'Canva está ocupado.' });
  managing = true;
  try {
    const canvaPage = await loadPeople();
    const row = await personRow(canvaPage, email);
    if (!row) return response.json({ revoked: true, message: 'La persona ya no figura en Canva.' });
    const pending = await row.getByText('Invitación enviada', { exact: true }).count() > 0;
    if (!pending && !allowDesignDeletion) {
      return response.status(409).json({ message: 'Canva exige autorización para borrar los diseños de esta persona.' });
    }
    const role = row.getByRole('button', { name: 'Estudiante', exact: true });
    if (await role.count() !== 1) throw new Error('Canva role changed from Student');
    await role.click();
    const action = pending ? 'Cancelar invitación' : 'Quitar de la escuela';
    await canvaPage.getByRole('menuitem', { name: action, exact: true }).last().click();
    await canvaPage.waitForTimeout(400);
    await confirmRemoval(canvaPage, pending, allowDesignDeletion);
    await canvaPage.reload({ waitUntil: 'domcontentloaded', timeout: 20_000 });
    await canvaPage.getByRole('heading', { name: /^Personas/ }).waitFor({ timeout: 45_000 });
    await canvaPage.waitForTimeout(1500);
    if (await personRow(canvaPage, email)) throw new Error('Canva did not confirm removal');
    return response.json({ revoked: true, message: 'Canva confirmó la revocación.' });
  } catch (error) {
    console.error('Canva member removal failed:', error.message);
    return response.status(424).json({ message: 'No se pudo confirmar la revocación en Canva. Revísalo allí.' });
  } finally {
    managing = false;
  }
});

app.use((_request, response) => response.status(404).json({ ok: false }));
app.listen(3500, '0.0.0.0', () => console.log('Automation controller listening on 3500'));
if (process.env.BROWSER_MODE !== 'manual') {
  startBrowser().catch(error => { console.error('Browser startup failed:', error.message); process.exit(1); });
}
