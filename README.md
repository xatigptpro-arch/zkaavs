# ZKAAVS

Lobby estático en https://zkaavs.app, publicado con GitHub Pages.
API en https://api.zkaavs.app, servida por un túnel exclusivo de Cloudflare.

## Estructura

- `frontend/`: lobby sin consultas a la API ni información de infraestructura.
- `backend/`: API Express; Node 24 LTS.
- `deploy/compose.yml`: API, túnel, navegador y panel en contenedores aislados.
- `automation/`: navegador aislado para invitaciones de Canva Educación.
- `portal/`: panel privado de invitaciones, alojado en el servidor.
- `deploy/isolate-network.sh`: reglas de red exclusivas de ZKAAVS.
- `deploy/zkaavs-stack.service`: arranque automático del conjunto.

## Aislamiento en el miniPC

La API no publica puertos en el host. Su única red es `zkaavs_private`, interna,
y solo la comparte con el túnel, el portal y el navegador de Canva.
El túnel tiene una segunda red para salir a los destinos de Cloudflare en el
puerto 7844 TCP/UDP. Las reglas INPUT y DOCKER-USER bloquean conexiones de estas
redes hacia el host, la LAN y las demás redes Docker. La API no tiene salida a
Internet; el túnel solo tiene la salida necesaria para sus conexiones y DNS.

Los cuatro contenedores usan usuarios sin privilegios, disco base de solo lectura,
capabilities eliminadas, no-new-privileges, límites de CPU/memoria/procesos y
rotación de logs. No usan el socket Docker, la red del host ni redes de otros
proyectos. Las imágenes base están fijadas por digest; sus actualizaciones
requieren revisar los nuevos digests y reconstruir.

El navegador de Canva corre en un tercer contenedor con perfil persistente
exclusivo en `/etc/zkaavs/canva-profile`. Su VNC solo escucha en la IP de
Tailscale del miniPC, puerto 5902. Su salida de red se limita a HTTPS público;
no puede iniciar conexiones hacia la API, el túnel, el host, la LAN ni los
demás proyectos. El portal llama al navegador para gestionar invitaciones. Chrome
se ejecuta con `--no-sandbox` dentro del contenedor; la separación respecto al
host depende del aislamiento de Docker y de las reglas de firewall.

El portal corre en un cuarto contenedor sin puertos publicados. La única ruta
pública es `canva.zkaavs.app` a través del túnel. Exige credenciales individuales,
limita los intentos de acceso y usa una cookie segura de cuatro horas. El hash
de la contraseña inicial del administrador vive en
`/etc/zkaavs/portal-password.json`. Las cuentas, hashes individuales e historial
se guardan en `/etc/zkaavs/portal-data/state.json`, fuera del repositorio. El panel consulta Canva cada 15 minutos, inicia el plazo elegido
al enviar la invitación y cancela invitaciones pendientes al vencer. La retirada
de miembros aceptados requiere confirmación manual si Canva exige borrar diseños. Los días
activos se cuentan desde la primera detección del usuario en Canva. Puede
contactar al controlador del navegador, pero no a la API ni a otros proyectos.

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

El directorio de datos debe pertenecer al UID 10002 y tener permisos privados:

```bash
sudo install -d -o 10002 -g 10002 -m 0700 /etc/zkaavs/portal-data
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

`GET /health` y `GET /api/status` responden `{ "ok": true }`. La API no tiene
operaciones de escritura. Se aplican cabeceras de seguridad, respuestas sin
caché y un límite general de 120 solicitudes por minuto por IP/subred IPv6
(en memoria por proceso). Las invitaciones se gestionan únicamente desde el
portal privado, separado de la API.

En producción CORS permite únicamente `https://zkaavs.app` y
`https://www.zkaavs.app`. CORS controla navegadores; no es autenticación ni impide
que un cliente externo consulte los endpoints públicos. Una sesión de Canva
válida se mantiene únicamente en el perfil del navegador aislado.

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

Para `canva.zkaavs.app`, Cloudflare debe tener un CNAME con proxy activado
hacia `4e0ee0cd-5e9b-48c2-be36-bcd999147326.cfargotunnel.com`. El túnel
envía ese hostname al contenedor `portal` del miniPC. El prototipo de Sites
quedó desconectado y no forma parte del despliegue.

`.github/workflows/pages.yml` publica `frontend/` al subir cambios a `main`.
La política CSP del lobby permite únicamente su CSS local; no carga scripts,
recursos externos ni realiza conexiones a la API.

Ver `deploy/SECURITY.md` para el alcance y resultados de la revisión actual.


### Cuentas individuales del portal

El acceso ahora requiere usuario y contraseña. La cuenta inicial es `admin` y
conserva la contraseña anterior. Desde **Administración** se crean cuentas con
un cupo de invitaciones por mes y una vigencia en meses. También se pueden
renovar, suspender, habilitar y restablecer contraseñas. Cada cuenta ve y gestiona
únicamente sus invitaciones; el administrador ve todas y su propietario.

Los cupos se renuevan en el aniversario mensual de activación del plan, en UTC.
Las invitaciones confirmadas consumen cupo aunque se cancelen después. Los saldos
no se acumulan y renovar antes del vencimiento no reinicia el mes vigente. Un
plan vencido permite consultar el historial, pero bloquea invitaciones y
revocaciones hasta la renovación. El plazo de cada cliente es independiente.

Un envío cuyo resultado sea incierto reserva un cupo hasta que el administrador
lo compruebe en **Envíos por comprobar**. Este paso consulta Canva para confirmar
el envío o liberar la reserva; no vuelve a invitar al correo.

El estado existente se migra automáticamente a v2 y se guarda una copia previa
`state.json.v1.backup` en el directorio privado de datos.
Pruebas: `npm test --prefix portal`, con Node 24.
No se ha conectado ningún proveedor de pagos.
