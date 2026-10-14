# Revisión de ZKAAVS — 2026-10-14

Comprobaciones ejecutadas sobre la configuración activa:

- API y túnel en redes exclusivas; sin puertos publicados ni redes compartidas
  con otros proyectos. El antiguo puerto 3000 del host ya no está escuchando.
- API con UID 10001, sin montajes, socket Docker o credenciales del host.
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

## Alcance y límites

Se revisó ZKAAVS, no la seguridad completa de los demás proyectos, del router
ni de las cuentas de GitHub, Cloudflare o Name.com. No se comprobó su 2FA.
No se reinició el miniPC ni Docker para evitar interrumpir otros proyectos.

Los contenedores comparten kernel y daemon Docker con el host. Una vulnerabilidad
del kernel/runtime o acceso administrativo puede superar esta separación.
Una VM o máquina dedicada ofrece una frontera más fuerte.

La API actual es pública y solo expone comprobaciones de estado. CORS no es
un sistema de autenticación. Las nuevas funciones privadas deben incorporar
controles de acceso antes de publicarse.

Las reglas dependen de los bridges `br-zkaavs-api` y `br-zkaavs-out` y de los
rangos actuales de conexión de Cloudflare. Los cambios del firewall o de Docker
requieren verificar nuevamente la separación. DNS del túnel usa el resolver de
Docker; no se implementó un filtro por nombre de dominio para sus consultas DNS.
