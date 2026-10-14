# ZKAAVS

Lobby estático en https://zkaavs.app, publicado con GitHub Pages.
API en https://api.zkaavs.app, servida por un túnel exclusivo de Cloudflare.

## Estructura

- `frontend/`: lobby sin consultas a la API ni información de infraestructura.
- `backend/`: API Express; Node 24 LTS.
- `deploy/compose.yml`: API y túnel en contenedores separados.
- `deploy/isolate-network.sh`: reglas de red exclusivas de ZKAAVS.
- `deploy/zkaavs-stack.service`: arranque automático del conjunto.

## Aislamiento en el miniPC

La API no publica puertos en el host. Su única red es `zkaavs_private`, interna,
y solo la comparte con el túnel. No monta archivos del host ni credenciales.
El túnel tiene una segunda red para salir a los destinos de Cloudflare en el
puerto 7844 TCP/UDP. Las reglas INPUT y DOCKER-USER bloquean conexiones de estas
redes hacia el host, la LAN y las demás redes Docker. La API no tiene salida a
Internet; el túnel solo tiene la salida necesaria para sus conexiones y DNS.

Ambos contenedores usan usuarios sin privilegios, disco de solo lectura,
capabilities eliminadas, no-new-privileges, límites de CPU/memoria/procesos y
rotación de logs. No usan el socket Docker, la red del host ni redes de otros
proyectos. Las imágenes base están fijadas por digest; sus actualizaciones
requieren revisar los nuevos digests y reconstruir.

El túnel solo recibe su propia credencial de `/etc/zkaavs/tunnel.json`, montada
en solo lectura. No recibe el certificado administrativo de Cloudflare ni las
credenciales de otros túneles. Este directorio del host es accesible solo por
root y el archivo pertenece al UID 65532 con permisos 0400.

Los contenedores comparten el kernel del host: no equivalen a una VM y no
protegen contra un administrador del host o alguien con acceso al socket Docker.
El firewall es parte del aislamiento. Si se cambian Docker, UFW o sus reglas,
hay que volver a ejecutar y verificar las reglas de ZKAAVS.

## Operación

El conjunto está habilitado para arrancar al encender el miniPC. Los antiguos
servicios de usuario `zkaavs-backend` y `zkaavs-tunnel` fueron deshabilitados.

```bash
sudo systemctl status zkaavs-stack
sudo journalctl -u zkaavs-stack -n 50
docker compose -f deploy/compose.yml ps
docker compose -f deploy/compose.yml logs --tail 50
curl https://api.zkaavs.app/health
```

Para actualizar el backend:

```bash
docker compose -f deploy/compose.yml build
sudo systemctl restart zkaavs-stack
```

El servicio reinstala las reglas de aislamiento antes de iniciar los contenedores.
Docker los reinicia si fallan; el inicio tras arrancar el daemon queda a cargo
de systemd para evitar que arranquen antes de aplicar el firewall.
Al detenerlo se conservan las reglas; solo se bloquean las redes de ZKAAVS.

## API y CORS

Los únicos endpoints actuales son `GET /health` y `GET /api/status`; ambos
responden `{ "ok": true }`. No hay cuentas, datos privados ni operaciones de
escritura. Se aplican cabeceras de seguridad, respuestas sin caché y un límite de
120 solicitudes por minuto por IP/subred IPv6 (en memoria por proceso).

En producción CORS permite únicamente `https://zkaavs.app` y
`https://www.zkaavs.app`. CORS controla navegadores; no es autenticación ni impide
que un cliente externo consulte estos endpoints públicos. Antes de añadir datos
privados o acciones de escritura se necesita autenticación y autorización.

## Desarrollo local

Con Node 24:

```bash
cd backend
npm ci
npm run dev
```

Fuera de producción también se permiten los orígenes locales del puerto 8080.
El lobby puede servirse con cualquier servidor estático.

## DNS y despliegue web

Cloudflare gestiona DNS con `bryce.ns.cloudflare.com` y
`dahlia.ns.cloudflare.com`. Los cuatro registros A de GitHub Pages y el CNAME de
`www` permanecen en DNS only. El CNAME `api` apunta a
`4e0ee0cd-5e9b-48c2-be36-bcd999147326.cfargotunnel.com` con proxy activado.
El dominio sigue registrado en Name.com.

`.github/workflows/pages.yml` publica `frontend/` al subir cambios a `main`.
La política CSP del lobby permite únicamente su CSS local; no carga scripts,
recursos externos ni realiza conexiones a la API.

Ver `deploy/SECURITY.md` para el alcance y resultados de la revisión actual.
