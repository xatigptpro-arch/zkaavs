const form = document.querySelector('#invite-form');
const submit = document.querySelector('#submit');
const feedback = document.querySelector('#feedback');

form.addEventListener('submit', async event => {
  event.preventDefault();
  submit.disabled = true;
  submit.textContent = 'Enviando…';
  feedback.textContent = '';
  feedback.className = '';
  try {
    const response = await fetch('/invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: document.querySelector('#email').value.trim(),
        confirmed: document.querySelector('#confirmed').checked
      })
    });
    const result = await response.json();
    if (response.status === 401) {
      location.assign('/login');
      return;
    }
    feedback.textContent = result.message ?? 'No se pudo procesar la invitación.';
    feedback.className = response.ok ? 'success' : 'error';
    if (response.ok) form.reset();
  } catch {
    feedback.textContent = 'No se pudo conectar con el miniPC.';
    feedback.className = 'error';
  } finally {
    submit.disabled = false;
    submit.textContent = 'Enviar invitación';
  }
});
