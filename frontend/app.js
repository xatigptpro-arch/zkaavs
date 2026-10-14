const apiBaseUrl = window.APP_CONFIG?.apiBaseUrl ?? "http://localhost:3000";

const apiUrl = document.querySelector("#api-url");
const apiState = document.querySelector("#api-state");
const apiOutput = document.querySelector("#api-output");

apiUrl.textContent = apiBaseUrl;

async function loadStatus() {
  try {
    const response = await fetch(`${apiBaseUrl}/api/status`, {
      headers: {
        Accept: "application/json"
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const payload = await response.json();
    apiState.textContent = "Conectado";
    apiState.className = "badge badge-ok";
    apiOutput.textContent = JSON.stringify(payload, null, 2);
  } catch (error) {
    apiState.textContent = "Sin conexion";
    apiState.className = "badge badge-error";
    apiOutput.textContent = [
      "No se pudo conectar con el backend.",
      "",
      `API: ${apiBaseUrl}`,
      `Error: ${error.message}`
    ].join("\n");
  }
}

loadStatus();
