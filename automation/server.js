import express from 'express';
import { chromium } from 'playwright';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2kb' }));

let context;
let page;
let ready = false;
let inviting = false;
let lastInvitation = null;
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
    page = context.pages().find(candidate => candidate.url().includes('canva.com'))
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
  if (inviting) return response.status(409).json({ message: 'Hay otra invitación en curso.' });
  if (lastInvitation?.email === email && Date.now() - lastInvitation.at < 60_000) {
    return response.status(409).json({ message: 'Ya se solicitó esta invitación hace menos de un minuto.' });
  }
  inviting = true;
  try {
    const canvaPage = context.pages().find(candidate =>
      candidate.url().startsWith('https://www.canva.com/'));
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

app.use((_request, response) => response.status(404).json({ ok: false }));
app.listen(3500, '0.0.0.0', () => console.log('Automation controller listening on 3500'));
if (process.env.BROWSER_MODE !== 'manual') {
  startBrowser().catch(error => { console.error('Browser startup failed:', error.message); process.exit(1); });
}
