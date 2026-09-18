# Auditoría de seguridad y calidad — 9 de septiembre de 2026

> Actualización del 10 de septiembre: véase la
> [revisión de las tres correcciones posteriores](docs/audits/2026-09-10-fixes.md).
> El informe siguiente conserva el estado histórico del 9 de septiembre.

## Dictamen

La nueva revisión no deja vulnerabilidades críticas ni de prioridad alta conocidas
en el código fuente del repositorio. Los hallazgos altos de la auditoría anterior y
los requisitos funcionales descritos en los audios están implementados y cubiertos
por pruebas de regresión.

El resultado autoriza pruebas privadas y revisión por pares. Antes de una
publicación general aún deben verificarse en máquinas reales los adaptadores de
macOS/Linux y la procedencia/licencia del binario privado `tunnel-client`.

## Correcciones verificadas

- La configuración corrupta falla de forma cerrada; ya no reactiva permisos ni
  sustituye silenciosamente perfiles o aprobaciones.
- Cada aprobación queda ligada a operación, perfil, carpeta, contenido nuevo y
  huella del archivo anterior. Un cambio posterior invalida la aprobación.
- Las vistas previas leen como máximo 16 KiB y muestran como máximo 4.000
  caracteres, incluso para archivos de decenas de MiB.
- Escrituras, copias y restauraciones usan temporales y reemplazos o enlaces
  atómicos. Antes de restaurar se repiten las comprobaciones de enlaces y de la
  huella del destino.
- La papelera revierte el movimiento si no puede registrar sus metadatos; los
  metadatos de copias y papelera se publican atómicamente.
- El modo autónomo exige `confirmar=true` en cada escritura o eliminación.
- La cadena de auditoría conserva continuidad entre rotaciones y el panel verifica
  su integridad.
- La identidad de perfiles solo ignora mayúsculas en Windows; en sistemas de
  archivos POSIX evita colisiones entre rutas que se diferencian por capitalización.
- Una lectura por fragmentos puede omitir explícitamente la huella completa para no
  recorrer archivos grandes cuando no se necesita sobrescribirlos.
- El configurador de Windows ya no añade la clave al entorno de PowerShell. La
  clave solo se incorpora al entorno dedicado de `tunnel-client` y se elimina
  antes de cargar el servidor MCP o iniciar auxiliares.
- El panel rechaza cualquier dirección que no sea `127.0.0.1` o `::1`.
- Las comparaciones entre el espacio autorizado, el código y los datos privados
  canonizan alias y enlaces de directorio antes de evaluar solapamientos.
- Los procesos auxiliares de credenciales y servicios reciben un entorno saneado;
  no heredan claves OpenAI presentes accidentalmente en la sesión del usuario.
- Los nombres de ejecutable disponibles en `PATH` ya no se convierten en rutas
  locales inexistentes, y el panel informa de forma controlada si falta el cliente.
- La ejecución manual pregunta por la carpeta de trabajo, conserva la activa con
  `Enter` y crea un perfil aislado cuando se elige una carpeta nueva.
- El identificador se valida con el formato exacto admitido por el cliente:
  `tunnel_` seguido de 32 letras minúsculas o dígitos.
- El escáner revisa nombres sensibles incluso en archivos grandes, incluye los
  bloqueos de dependencias y comprueba cada ruta de cada árbol Git aunque varias
  rutas compartan el mismo contenido. También rechaza binarios o archivos de
  terceros que hayan sido versionados bajo `vendor/`.
- Las solicitudes de aprobación almacenadas se validan antes de mostrarse y sus
  identificadores se escapan en el panel.
- Los directorios internos se ocultan del listado sin depender de mayúsculas o
  minúsculas, además de mantenerse inaccesibles por ruta directa.
- Las URL IPv6 loopback y los caracteres `%` de las unidades `systemd` se generan
  con el escape exigido por cada plataforma.

## Funcionalidad solicitada en los audios

- Hay una CLI única con `platform`, `credential set`, `setup`, `run` y
  `autostart`.
- El almacén seguro es DPAPI en Windows, Keychain en macOS y Secret Service en
  Linux. La ausencia del proveedor nativo produce un error; no existe alternativa
  en texto plano.
- El inicio de usuario usa Task Scheduler, LaunchAgent o `systemd --user`. Las
  definiciones no contienen credenciales y conservan las rutas configuradas.
- Frontend y backend se comunican mediante `/api/v1`; entradas y errores tienen un
  contrato independiente validado con Zod y documentado en
  [docs/control-api-v1.md](docs/control-api-v1.md).
- La integración continua valida Node 22 en Windows, macOS y Linux, comprueba
  sintaxis, ejecuta regresiones, revisa dependencias y escanea secretos en el árbol
  y en todo el historial Git.

## Evidencia de esta revisión

- Instalación reproducible definida por `package-lock.json` y sin scripts de
  instalación de terceros en la integración continua (`npm ci --ignore-scripts`).
- Dependencias de producción: `npm audit --omit=dev --audit-level=moderate`, 0
  vulnerabilidades conocidas en la consulta del 9 de septiembre de 2026.
- Siete grupos de pruebas superados: entorno, plataformas/DPAPI real en Windows,
  CLI, escáner de secretos, regresiones de seguridad, servidor MCP y panel/API.
- 19 archivos JavaScript superaron `node --check`.
- Todos los scripts PowerShell superaron el analizador sintáctico.
- El escáner local no encontró credenciales ni archivos sensibles en el estado
  actual ni en objetos alcanzables del historial Git.
- `git diff --check` no detectó errores de espacios o parches mal formados.
- La ejecución de GitHub Actions
  [34390800878](https://github.com/jpascualgb/tunel-chat-mcp/actions/runs/34390800878)
  terminó correctamente en Windows, macOS y Ubuntu con el commit `fb6fc5f`.

## Riesgos residuales

### Prioridad media

1. **Validación real de macOS y Linux.** En Windows se verificó un ciclo DPAPI
   completo. Las definiciones de Keychain, Secret Service, launchd y systemd tienen
   pruebas de contrato y CI multiplataforma, pero esta auditoría local no dispuso de
   sesiones macOS/Linux con sus almacenes desbloqueados. Debe completarse una prueba
   funcional en ambos sistemas antes de prometer soporte de producción.

2. **Binario externo.** `tunnel-client` no forma parte del historial y su código no
   se ha auditado aquí. Deben comprobarse canal oficial, firma o suma publicada,
   versión y condiciones de redistribución para cada plataforma.

### Prioridad baja y límites del modelo

- Otro proceso malicioso con la misma cuenta local puede inspeccionar memoria,
  manipular procesos o volver a calcular registros. La clave permanece en memoria
  y en el entorno de `tunnel-client` mientras este la necesita.
- La cadena de auditoría detecta alteraciones parciales, pero no está anclada en un
  servicio externo ni firmada con una clave separada; no es evidencia forense
  frente al propietario de la cuenta local.
- La atomicidad de creación utiliza enlaces duros en el mismo volumen. En un
  sistema de archivos que no los admita, la operación falla de forma cerrada.
- Calcular SHA-256 completo sigue consumiendo E/S cuando el llamador lo solicita;
  puede omitirse con `incluir_sha256=false` para lecturas exploratorias.

## Condiciones antes de publicar

1. Mantener verde la validación de CI en los tres sistemas para cada cambio de
   publicación.
2. Ejecutar una prueba manual de almacén, arranque, reinicio y desinstalación en
   macOS y Linux.
3. Verificar procedencia, integridad y derechos de distribución de cada binario de
   `tunnel-client`.
4. Mantener la API exclusivamente en loopback. Cualquier acceso remoto requiere un
   modelo de amenazas, autenticación y auditoría nuevos.
