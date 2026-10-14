# zkaavs infra base

Base minima para tener:

- Frontend estatico listo para GitHub Pages.
- Backend Node/Express listo para correr en el miniPC.

## Estructura

```txt
frontend/   Sitio estatico para GitHub Pages
backend/    API Express para correr en el miniPC
```

## Backend local

```bash
cd backend
npm install
npm run dev
```

Endpoints:

- `GET /health`
- `GET /api/status`

Variables utiles:

```bash
PORT=3000
FRONTEND_ORIGIN=https://tu-dominio.com
```

Para desarrollo local, el backend permite `http://localhost:8080`, `http://127.0.0.1:8080` y el valor de `FRONTEND_ORIGIN`.

## Frontend local

Desde la raiz:

```bash
npx serve frontend -l 8080
```

O cualquier servidor estatico equivalente.

El frontend lee la URL de API desde `frontend/config.js`.

Para local:

```js
window.APP_CONFIG = {
  apiBaseUrl: "http://localhost:3000"
};
```

Cuando expongas el backend del miniPC, cambia esa URL por algo como:

```js
window.APP_CONFIG = {
  apiBaseUrl: "https://api.tu-dominio.com"
};
```

## GitHub Pages

Este repo incluye `.github/workflows/pages.yml`, que publica el contenido de `frontend/` en GitHub Pages.

Pasos generales:

1. Crea un repo en GitHub.
2. Sube este proyecto.
3. En GitHub, ve a `Settings -> Pages`.
4. En `Build and deployment`, usa `GitHub Actions`.
5. Agrega tu dominio en `Custom domain`.

Luego en Name.com configuras los DNS para GitHub Pages y, aparte, `api.tu-dominio.com` para el backend.
