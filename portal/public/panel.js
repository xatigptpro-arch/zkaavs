const form = document.querySelector('#invite-form');
const submit = document.querySelector('#submit');
const feedback = document.querySelector('#feedback');
const duration = document.querySelector('#duration');
const customDurationWrap = document.querySelector('#custom-duration-wrap');
const customDuration = document.querySelector('#custom-duration');
const syncStatus = document.querySelector('#sync-status');
const refresh = document.querySelector('#refresh');
const usersBody = document.querySelector('#users-body');
const invitationsBody = document.querySelector('#invitations-body');
let dashboard;
let inviteBusy = false;
let currentView = ['invites', 'admin', 'account'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'invites';

function updateCustomDuration() {
  const custom = duration.value === 'custom';
  customDurationWrap.hidden = !custom;
  customDuration.required = custom;
  customDuration.disabled = !custom || dashboard?.me?.usage.allowed === false;
}

duration.addEventListener('change', updateCustomDuration);

function dateText(value) {
  return value ? new Date(value).toLocaleDateString('es', { dateStyle: 'medium' }) : 'Anterior al registro';
}

function daysActive(value) {
  return value ? Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 86_400_000)) : '—';
}

function statusText(record) {
  if (record.revokeError) return 'Revocación pendiente';
  return {
    active: 'Activo', pending: 'Invitación pendiente', absent: 'No encontrado en Canva',
    revoked: 'Revocado', expired: 'Plazo terminado'
  }[record.status] ?? 'Sin comprobar';
}

function cell(row, value) {
  const td = document.createElement('td');
  td.textContent = String(value);
  row.append(td);
  return td;
}

function actionButton(row, label, id) {
  const td = document.createElement('td');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'danger-button';
  button.textContent = label;
  button.dataset.revoke = id;
  td.append(button);
  row.append(td);
}

function render(data) {
  dashboard = data;
  renderAccount(data);
  document.querySelector('#sent-count').textContent = data.summary.sent;
  document.querySelector('#user-count').textContent = data.summary.users;
  document.querySelector('#pending-count').textContent = data.summary.pending;
  syncStatus.textContent = data.syncing ? 'Actualizando estados…'
    : data.syncError ? data.syncError
      : data.lastCheckedAt ? `Estados comprobados: ${new Date(data.lastCheckedAt).toLocaleString('es')}`
        : 'Los estados se comprobarán en breve.';
  refresh.disabled = data.syncing;

  usersBody.replaceChildren();
  for (const record of data.users) {
    const row = document.createElement('tr');
    cell(row, record.email);
    if (data.me.role === 'admin') cell(row, record.owner);
    cell(row, daysActive(record.activeSince));
    cell(row, record.expiresAt ? dateText(record.expiresAt) : 'Sin plazo');
    if (data.me.usage.allowed) actionButton(row, 'Revocar acceso', record.id);
    else cell(row, 'Plan vencido · consulta');
    usersBody.append(row);
  }
  document.querySelector('#users-empty').hidden = data.users.length > 0;

  invitationsBody.replaceChildren();
  for (const record of data.invitations) {
    const row = document.createElement('tr');
    cell(row, record.email);
    if (data.me.role === 'admin') cell(row, record.owner);
    cell(row, dateText(record.invitedAt));
    cell(row, record.durationDays ? `${record.durationDays} días` : 'Sin plazo');
    const status = cell(row, statusText(record));
    if (record.revokeError) status.title = record.revokeError;
    if (record.status === 'pending' && data.me.usage.allowed) actionButton(row, 'Cancelar', record.id);
    else cell(row, '—');
    invitationsBody.append(row);
  }
  document.querySelector('#invitations-empty').hidden = data.invitations.length > 0;
}

async function api(path, options) {
  const response = await fetch(path, options);
  if (response.status === 401) {
    location.assign('/login');
    throw new Error('Sesión terminada.');
  }
  if (!response.headers.get('content-type')?.includes('application/json')) {
    throw new Error('Respuesta inesperada. Revisa en Canva antes de volver a intentar.');
  }
  const result = await response.json();
  if (!response.ok) throw new Error(result.message ?? 'No se pudo completar la solicitud.');
  return result;
}

async function loadDashboard() {
  try {
    render(await api('/api/dashboard'));
  } catch (error) {
    syncStatus.textContent = error.message;
  }
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (inviteBusy) return;
  inviteBusy = true;
  submit.disabled = true;
  submit.textContent = 'Enviando…';
  feedback.textContent = '';
  try {
    const result = await api('/invite', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: document.querySelector('#email').value.trim(),
        requestId: crypto.randomUUID(),
        durationDays: duration.value === 'custom'
          ? Number(customDuration.value) : Number(duration.value)
      })
    });
    feedback.textContent = result.message;
    feedback.className = 'success';
    form.reset();
    updateCustomDuration();
    await loadDashboard();
  } catch (error) {
    feedback.textContent = error.message || 'No se pudo conectar. Revisa en Canva antes de volver a intentar.';
    feedback.className = 'error';
  } finally {
    inviteBusy = false;
    await loadDashboard();
    submit.disabled = dashboard?.me.usage.allowed === false || dashboard?.me.usage.remaining === 0;
    submit.textContent = 'Enviar invitación';
  }
});

refresh.addEventListener('click', async () => {
  refresh.disabled = true;
  try {
    await api('/api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    for (let attempt = 0; attempt < 30; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 2_000));
      await loadDashboard();
      if (!dashboard?.syncing) break;
    }
  } catch (error) {
    syncStatus.textContent = error.message;
  } finally {
    refresh.disabled = false;
  }
});

async function revoke(event) {
  const button = event.target.closest('button[data-revoke]');
  if (!button) return;
  const record = dashboard?.invitations.find(item => item.id === button.dataset.revoke);
  if (!record) return;
  const verb = record.status === 'pending' ? 'cancelar la invitación' : 'revocar el acceso';
  if (!confirm(`¿Quieres ${verb} de ${record.email}?`)) return;
  const allowDesignDeletion = record.status === 'active' && confirm(
    `Canva advierte que al quitar a ${record.email} también eliminará todos sus diseños guardados, incluidos los privados. ¿Confirmas que continúe?`
  );
  if (record.status === 'active' && !allowDesignDeletion) return;
  button.disabled = true;
  try {
    const result = await api('/api/revoke', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: record.id, allowDesignDeletion })
    });
    syncStatus.textContent = result.message;
    await loadDashboard();
  } catch (error) {
    syncStatus.textContent = error.message;
    button.disabled = false;
  }
}

usersBody.addEventListener('click', revoke);
invitationsBody.addEventListener('click', revoke);



const accountChoice = document.querySelector('#account-choice');
const adminFeedback = document.querySelector('#admin-feedback');
const planNames = { active: 'Activo', expired: 'Vencido · solo consulta', suspended: 'Suspendido', admin: 'Administrador' };
function renderAccount(data) {
  const { me } = data;
  const admin = me.role === 'admin';
  const usage = me.usage;
  const emailInput = document.querySelector('#my-email');
  if (!emailInput.dataset.initialized) { emailInput.value = me.email || ''; emailInput.dataset.initialized = '1'; }
  document.querySelector('#account-label').textContent = me.email || me.username;
  document.querySelector('#plan-title').textContent = me.name;
  document.querySelector('#plan-status').textContent = planNames[usage.status] ?? 'Sin plan';
  document.querySelector('#plan-details').hidden = admin;
  document.querySelector('#plan-message').textContent = admin
    ? 'Acceso a todas las cuentas e invitaciones.'
    : usage.allowed ? 'Cancelar o revocar no devuelve cupo.'
      : 'Plan vencido. El historial sigue disponible; renueva para gestionar invitaciones.';
  if (!admin) {
    document.querySelector('#quota-used').textContent = `${usage.sent} / ${usage.limit}`;
    document.querySelector('#quota-remaining').textContent = usage.remaining;
    document.querySelector('#quota-reset').textContent = usage.allowed && Date.parse(usage.end) < Date.parse(usage.expiresAt)
      ? dateText(usage.end) : 'Al renovar';
    document.querySelector('#plan-expiry').textContent = dateText(usage.expiresAt);
    document.querySelector('#quota-progress').max = usage.limit || 1;
    document.querySelector('#quota-progress').value = usage.sent + usage.reserved;
    document.querySelector('#quota-note').textContent = usage.reserved
      ? `${usage.reserved} cupo(s) reservado(s) por envíos por comprobar. El período actual comenzó el ${dateText(usage.start)}.`
      : `Período mensual desde el ${dateText(usage.start)}. Los cupos sin usar no se acumulan.`;
  }
  for (const element of form.elements) element.disabled = !usage.allowed;
  submit.disabled = inviteBusy || !usage.allowed || usage.remaining === 0;
  updateCustomDuration();
  showView(currentView, false);
  document.querySelector('#admin-link').hidden = !admin;
  for (const element of document.querySelectorAll('.admin-only')) element.hidden = !admin;
  if (admin) renderAccounts(data.accounts);
  const operations = document.querySelector('#operations-body');
  operations.replaceChildren();
  document.querySelector('#operations-section').hidden = !data.operations.length;
  for (const operation of data.operations) {
    const row = document.createElement('tr');
    cell(row, admin ? `${operation.email} · ${operation.owner}` : operation.email);
    cell(row, dateText(operation.createdAt));
    cell(row, operation.status === 'sending' ? 'En curso' : 'Por comprobar');
    const td = cell(row, admin ? '' : 'Administración debe comprobarlo');
    if (admin && operation.status === 'uncertain') {
      for (const [sent, label] of [[true, 'Confirmar envío'], [false, 'No se envió']]) {
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'secondary-button'; button.textContent = label;
        button.addEventListener('click', async () => {
          if (!confirm(`¿Comprobar en Canva el envío a ${operation.email} y ${sent ? 'contabilizarlo' : 'liberar el cupo si no aparece'}?`)) return;
          button.disabled = true;
          try {
            const result = await post('/api/admin/resolve', { id: operation.id, sent });
            adminFeedback.textContent = result.message; await loadDashboard();
          } catch (error) { adminFeedback.textContent = error.message; button.disabled = false; }
        });
        td.append(button);
      }
    }
    operations.append(row);
  }
}
function renderAccounts(accounts) {
  const body = document.querySelector('#accounts-body'); body.replaceChildren();
  for (const account of accounts) {
    const row = document.createElement('tr');
    cell(row, `${account.name} · ${account.email || account.username}`);
    cell(row, planNames[account.usage.status]);
    cell(row, `${account.usage.sent} / ${account.usage.limit}${account.usage.reserved ? ` (+${account.usage.reserved} por comprobar)` : ''}`);
    cell(row, dateText(account.usage.expiresAt)); body.append(row);
  }
  document.querySelector('#accounts-empty').hidden = accounts.length > 0;
  const selected = accountChoice.value;
  accountChoice.replaceChildren(new Option('Selecciona una cuenta', ''));
  for (const account of accounts) accountChoice.add(new Option(`${account.name} · ${account.email || account.username}`, account.id));
  accountChoice.value = selected;
  updateAccountActions(false);
}
function updateAccountActions(fillQuota = true) {
  const account = dashboard?.accounts?.find(a => a.id === accountChoice.value);
  document.querySelector('#toggle-account').textContent = account?.enabled === false ? 'Habilitar cuenta' : 'Suspender cuenta';
  if (fillQuota && account) {
    document.querySelector('#renew-account-quota').value = account.usage.limit;
    document.querySelector('#edit-account-email').value = account.email || '';
  }
}
accountChoice.addEventListener('change', () => updateAccountActions());
function post(path, data) { return api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }); }
async function adminAction(button, data) {
  if (!accountChoice.value) { adminFeedback.textContent = 'Selecciona una cuenta.'; return; }
  button.disabled = true; adminFeedback.textContent = '';
  try {
    const result = await post('/api/admin/account', { id: accountChoice.value, ...data });
    adminFeedback.textContent = result.message; await loadDashboard();
  } catch (error) { adminFeedback.textContent = error.message; }
  finally { button.disabled = false; }
}
document.querySelector('#create-account-form').addEventListener('submit', async event => {
  event.preventDefault(); const createForm = event.currentTarget;
  const button = createForm.querySelector('button'); button.disabled = true;
  try {
    const result = await post('/api/admin/accounts', {
      name: document.querySelector('#new-account-name').value.trim(),
      email: document.querySelector('#new-account-email').value.trim(),
      password: document.querySelector('#new-account-password').value,
      monthlyQuota: Number(document.querySelector('#new-account-quota').value),
      months: Number(document.querySelector('#new-account-months').value)
    });
    createForm.reset(); adminFeedback.textContent = result.message;
    await loadDashboard(); accountChoice.value = result.account.id; updateAccountActions();
  } catch (error) { adminFeedback.textContent = error.message; }
  finally { button.disabled = false; }
});
document.querySelector('#manage-account-form').addEventListener('submit', async event => {
  event.preventDefault();
  await adminAction(event.currentTarget.querySelector('button[type=submit]'), {
    action: 'renew', monthlyQuota: Number(document.querySelector('#renew-account-quota').value),
    months: Number(document.querySelector('#renew-account-months').value)
  });
});
document.querySelector('#toggle-account').addEventListener('click', async event => {
  const account = dashboard?.accounts?.find(a => a.id === accountChoice.value);
  if (!account) { adminFeedback.textContent = 'Selecciona una cuenta.'; return; }
  if (!confirm(`¿${account.enabled ? 'Suspender' : 'Habilitar'} la cuenta ${account.email || account.username}?`)) return;
  await adminAction(event.currentTarget, { action: account.enabled ? 'suspend' : 'activate' });
});
document.querySelector('#reset-account').addEventListener('click', async event => {
  const input = document.querySelector('#reset-account-password');
  if (input.value.length < 12 || input.value.length > 128) { adminFeedback.textContent = 'Usa una contraseña de 12 a 128 caracteres.'; return; }
  await adminAction(event.currentTarget, { action: 'password', password: input.value });
  input.value = '';
});
document.querySelector('#password-form').addEventListener('submit', async event => {
  event.preventDefault(); const passwordForm = event.currentTarget;
  const button = passwordForm.querySelector('button'); button.disabled = true;
  const feedback = document.querySelector('#password-feedback');
  try {
    const result = await post('/api/password', { currentPassword: document.querySelector('#current-password').value,
      password: document.querySelector('#new-password').value });
    feedback.textContent = result.message; passwordForm.reset();
  } catch (error) { feedback.textContent = error.message; }
  finally { button.disabled = false; }
});

document.querySelector('#email-form').addEventListener('submit', async event => {
  event.preventDefault(); const emailForm = event.currentTarget;
  const button = emailForm.querySelector('button'); button.disabled = true;
  const feedback = document.querySelector('#email-feedback');
  try {
    const result = await post('/api/email', { email: document.querySelector('#my-email').value.trim(),
      currentPassword: document.querySelector('#email-current-password').value });
    feedback.textContent = result.message; document.querySelector('#email-current-password').value = '';
    await loadDashboard();
  } catch (error) { feedback.textContent = error.message; }
  finally { button.disabled = false; }
});
document.querySelector('#save-account-email').addEventListener('click', async event => {
  const input = document.querySelector('#edit-account-email');
  if (!input.value || !input.reportValidity()) { adminFeedback.textContent = 'Introduce un correo electrónico válido.'; return; }
  await adminAction(event.currentTarget, { action: 'email', email: input.value.trim() });
});
function showView(view, updateUrl = true) {
  const admin = dashboard?.me.role === 'admin';
  currentView = view === 'admin' && !admin ? 'invites' : view;
  const titles = {
    invites: ['Invitaciones', 'Envíos, usuarios y plazos.'],
    admin: ['Cuentas y planes', 'Accesos, cupos mensuales y renovaciones.'],
    account: ['Mi cuenta', 'Correo electrónico y contraseña de acceso.']
  };
  document.querySelector('#invites-view').hidden = currentView !== 'invites';
  document.querySelector('#admin-section').hidden = currentView !== 'admin' || !admin;
  document.querySelector('#password-section').hidden = currentView !== 'account';
  for (const button of document.querySelectorAll('[data-view]')) {
    const selected = button.dataset.view === currentView;
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
  }
  document.querySelector('#view-title').textContent = titles[currentView][0];
  document.querySelector('#view-description').textContent = titles[currentView][1];
  if (updateUrl) history.replaceState(null, '', `#${currentView}`);
}
for (const button of document.querySelectorAll('[data-view]')) {
  button.addEventListener('click', () => showView(button.dataset.view));
  button.addEventListener('keydown', event => {
    const tabs = [...document.querySelectorAll('[data-view]')].filter(tab => !tab.hidden);
    const index = tabs.indexOf(event.currentTarget);
    const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length
      : event.key === 'ArrowLeft' ? (index - 1 + tabs.length) % tabs.length
        : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault(); tabs[next].focus(); showView(tabs[next].dataset.view);
  });
}
window.addEventListener('hashchange', () => {
  const view = location.hash.slice(1);
  if (['invites', 'admin', 'account'].includes(view)) showView(view, false);
});
updateCustomDuration();
loadDashboard();
setInterval(loadDashboard, 30_000);
