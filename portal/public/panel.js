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

function updateCustomDuration() {
  const custom = duration.value === 'custom';
  customDurationWrap.hidden = !custom;
  customDuration.required = custom;
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
    cell(row, daysActive(record.activeSince));
    cell(row, record.expiresAt ? dateText(record.expiresAt) : 'Sin plazo');
    actionButton(row, 'Revocar acceso', record.id);
    usersBody.append(row);
  }
  document.querySelector('#users-empty').hidden = data.users.length > 0;

  invitationsBody.replaceChildren();
  for (const record of data.invitations) {
    const row = document.createElement('tr');
    cell(row, record.email);
    cell(row, dateText(record.invitedAt));
    cell(row, record.durationDays ? `${record.durationDays} días` : 'Sin plazo');
    const status = cell(row, statusText(record));
    if (record.revokeError) status.title = record.revokeError;
    if (record.status === 'pending') actionButton(row, 'Cancelar', record.id);
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
  submit.disabled = true;
  submit.textContent = 'Enviando…';
  feedback.textContent = '';
  try {
    const result = await api('/invite', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: document.querySelector('#email').value.trim(),
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
    submit.disabled = false;
    submit.textContent = 'Enviar invitación';
  }
});

refresh.addEventListener('click', async () => {
  refresh.disabled = true;
  try {
    await api('/api/sync', { method: 'POST' });
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
loadDashboard();
setInterval(loadDashboard, 30_000);
