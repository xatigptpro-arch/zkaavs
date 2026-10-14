# Revisión de ZKAAVS — 2026-10-14

Comprobaciones ejecutadas sobre la configuración activa:

- API y túnel en redes exclusivas; sin puertos publicados ni redes compartidas
  con otros proyectos. El antiguo puerto 3000 del host ya no está escuchando.
- API con UID 10001, sin montajes ni socket Docker.
- Túnel con UID 65532; únicamente su configuración y credencial en solo lectura.
- Disco de la API no escribible: pruebas en `/app` y `/tmp` rechazadas.
- Conexiones desde las redes de API y túnel hacia gateways del host, un servicio
  del host, el router de la LAN, otro contenedor y un destino público general
  rechazadas. Prueba de conexión desde otra red Docker a la API rechazada.
- Conexión túnel → API permitida. Cuatro conexiones QUIC del túnel registradas.
- Resolución DNS externa de la API bloqueada (`ESERVFAIL`).
- HTTPS público, CORS permitido y rechazado, cabeceras de seguridad, errores
  genéricos y límite de 120 solicitudes/minuto comprobados. Rotar direcciones
  dentro de una misma subred IPv6 no evita el límite.
- `npm audit --omit=dev`: cero vulnerabilidades conocidas en las dependencias.
- Búsqueda de patrones de credenciales en archivos versionados y los cinco
  commits previos: sin coincidencias. No equivale a una auditoría exhaustiva.
- Arranque automático gestionado por `zkaavs-stack.service`; contenedores con
  reinicio automático. Reglas aplicadas antes del inicio del conjunto.
- Reinicio del conjunto ZKAAVS verificado sin reiniciar otros contenedores.
  HTTP público redirige a HTTPS con respuesta 308.
- Navegador de Canva en su propio contenedor y red de salida; VNC publicado
  únicamente en la IP de Tailscale. Se comprobó que no puede iniciar conexiones
  hacia la API, mientras la API sí alcanza el controlador del navegador.
- El portal local rechazó un envío sin sesión (HTTP 401) y permitió iniciar
  sesión con la contraseña correcta. Una invitación de prueba autorizada mostró
  confirmación en Canva.
- El registro persistente del portal contiene solo invitaciones hechas desde
  ZKAAVS y vive en `/etc/zkaavs/portal-data` con UID 10002 y modo 0700/0600.
  Se verificó la lectura del estado en Canva y que la casilla de autorización
  ya no forma parte del formulario.
- El prototipo alojado en Sites quedó sin secreto ni dominio propio; el portal
  operativo está en el miniPC y se publica por el túnel exclusivo de ZKAAVS.

## Alcance y límites

Se revisó ZKAAVS, no la seguridad completa de los demás proyectos, del router
ni de las cuentas de GitHub, Cloudflare o Name.com. No se comprobó su 2FA.
No se reinició el miniPC ni Docker para evitar interrumpir otros proyectos.

Los contenedores comparten kernel y daemon Docker con el host. Una vulnerabilidad
del kernel/runtime o acceso administrativo puede superar esta separación.
Una VM o máquina dedicada ofrece una frontera más fuerte.

La API pública conserva solo los endpoints de estado. CORS no es un sistema de
autenticación. El portal exige contraseña y sesión segura. El navegador automatizado
mantiene una sesión administrativa de Canva: quien obtenga su perfil o acceso
al VNC podría operar con esa cuenta. El perfil se guarda fuera del repositorio,
con permisos restringidos en el miniPC.

El portal consulta los registros guardados cada 15 minutos y trata de cancelar
una invitación o quitar el usuario al vencer el plazo elegido. Canva no expone
la fecha exacta de aceptación en la vista automatizada; el contador de días
activos empieza en la primera comprobación que detecta al miembro. La ruta de
revocación automática aún no se ha ejecutado contra una cuenta real.

Las reglas dependen de los bridges `br-zkaavs-api`, `br-zkaavs-out` y
`br-zkaavs-canva`, además de los
rangos actuales de conexión de Cloudflare. Los cambios del firewall o de Docker
requieren verificar nuevamente la separación. DNS del túnel usa el resolver de
Docker; no se implementó un filtro por nombre de dominio para sus consultas DNS.
