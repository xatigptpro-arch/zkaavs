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

## Infraestructura ZKAAVS

`zkaavs.app` es el lobby en GitHub Pages. Cada futura app puede tener su propio
subdominio y backend local. Por ahora la API base corre en `127.0.0.1:3000`.

El servicio de usuario se instala con:

```bash
mkdir -p ~/.config/systemd/user
cp deploy/zkaavs-backend.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now zkaavs-backend
```

Comprobacion y logs:

```bash
curl http://127.0.0.1:3000/health
systemctl --user status zkaavs-backend
journalctl --user -u zkaavs-backend -n 50
```

El usuario debe tener lingering habilitado para arrancar al encender el miniPC.
En esta maquina ya esta habilitado.

Para publicar `api.zkaavs.app`, agregar el dominio a Cloudflare, conservar los
cuatro registros A de GitHub Pages y el CNAME de www, y cambiar los nameservers
en Name.com por los asignados por Cloudflare. Crear un tunel dedicado usando
`deploy/cloudflared.example.yml` como plantilla. No modificar el tunel existente
de otros proyectos. No abrir el puerto 3000 en el router.

La API publica esta disponible en `https://api.zkaavs.app` y el frontend usa
esa URL en `frontend/config.js`. El registro CNAME `api` apunta a
`4e0ee0cd-5e9b-48c2-be36-bcd999147326.cfargotunnel.com` con proxy activado.
Los registros de GitHub Pages permanecen en DNS only.

Para permitir otra app en CORS, agregar
su origen exacto a `FRONTEND_ORIGINS` en el servicio y reiniciar la API.
