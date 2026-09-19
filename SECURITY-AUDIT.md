# Auditoría de seguridad y calidad — 9 de septiembre de 2026

> Actualización del 10 de septiembre: véase la
> [revisión de las tres correcciones posteriores](docs/audits/2026-09-10-fixes.md).
>
> Actualización del 18 de septiembre: el repositorio se publica como beta con
> Windows validado y macOS/Linux en validación comunitaria. `tunnel-client` ya tiene
> un repositorio oficial público bajo Apache-2.0 y publica evidencias de integridad;
> continúa excluido de este repositorio y debe descargarse directamente desde
> OpenAI. La versión correctiva `v3.1.1` elimina una condición de carrera del
> escáner de secretos y añade su prueba de regresión. El informe siguiente conserva
> la evidencia técnica iniciada el 9 de septiembre y actualiza sus condiciones de
> distribución.
>
> Actualización del 19 de septiembre: la versión `v3.2.0` amplía la superficie MCP
> con operaciones recursivas de carpetas y entradas de imagen de ChatGPT. El nuevo
> modelo de amenazas y sus límites se documentan en
> [ADR-003](docs/decisions/0003-folder-trees-and-chatgpt-file-inputs.md).
>
> Actualización correctiva `v3.2.1`: el iniciador admite configuraciones antiguas
> con UTF-8 BOM sin relajar la validación de su contenido. La credencial continúa
> almacenada mediante DPAPI y nunca se incorpora al archivo JSON.

## Dictamen

La nueva revisión no deja vulnerabilidades críticas ni de prioridad alta conocidas
en el código fuente del repositorio. Los hallazgos altos de la auditoría anterior y
los requisitos funcionales descritos en los audios están implementados y cubiertos
por pruebas de regresión.

El resultado autoriza una beta pública y revisión por pares. Windows cuenta con
validación funcional real; macOS y Linux conservan estado experimental hasta que se
complete un ciclo funcional en equipos reales. Este estado debe comunicarse sin
prometer soporte de producción multiplataforma.

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
  terceros que hayan sido versionados bajo `vendor/`. Cada archivo se abre,
  comprueba y lee mediante el mismo descriptor; un cambio durante el escaneo falla
  de forma segura.
- Las solicitudes de aprobación almacenadas se validan antes de mostrarse y sus
  identificadores se escapan en el panel.
- Los directorios internos se ocultan del listado sin depender de mayúsculas o
  minúsculas, además de mantenerse inaccesibles por ruta directa.
- Las URL IPv6 loopback y los caracteres `%` de las unidades `systemd` se generan
  con el escape exigido por cada plataforma.
- Crear, copiar, mover, renombrar y eliminar carpetas reutiliza permisos y
  aprobaciones. Cada árbol se limita a 10.000 elementos y 512 MiB, rechaza enlaces
  y archivos especiales, y queda ligado a una huella de contenido que se verifica
  antes y después de la operación.
- La eliminación de carpetas mueve el árbol completo a la papelera protegida y
  revierte el movimiento si falla la verificación o la publicación atómica de sus
  metadatos.
- Las imágenes recibidas mediante `openai/fileParams` se limitan a 20 MiB y a PNG,
  JPEG o WebP. La descarga bloquea SSRF mediante HTTPS/443, validación de todas las
  resoluciones y redirecciones, fijación de la dirección validada y rechazo de
  rangos locales, privados, reservados, IPv4 mapeado y traducción IPv6 conocida.
- Las URL firmadas de descarga no se incluyen en el registro de actividad.

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
- El MCP publica herramientas separadas para crear carpetas, copiar, mover o
  renombrar y eliminar carpetas, además de una entrada de archivo oficial para
  guardar imágenes de ChatGPT como archivos nuevos.
- La integración continua valida Node 22 en Windows, macOS y Linux, comprueba
  sintaxis, ejecuta regresiones, revisa dependencias y escanea secretos en el árbol
  y en todo el historial Git.

## Evidencia de esta revisión

- Instalación reproducible definida por `package-lock.json` y sin scripts de
  instalación de terceros en la integración continua (`npm ci --ignore-scripts`).
- Dependencias de producción: `npm audit --omit=dev --audit-level=moderate`, 0
  vulnerabilidades conocidas en la consulta del 19 de septiembre de 2026. npm
  verificó firmas de registro para 94 paquetes y attestations para 9.
- La suite completa superó las pruebas de entorno, plataformas y almacenes nativos,
  CLI, escáner de secretos, regresiones de seguridad, servidor MCP y panel/API.
- 24 archivos JavaScript superaron la comprobación sintáctica.
- Todos los scripts PowerShell superaron el analizador sintáctico.
- El escáner local no encontró credenciales ni archivos sensibles en el estado
  actual ni en objetos alcanzables del historial Git.
- `git diff --check` no detectó errores de espacios o parches mal formados.
- La ejecución de GitHub Actions
  [34390800878](https://github.com/jpascualgb/tunel-chat-mcp/actions/runs/34390800878)
  terminó correctamente en Windows, macOS y Ubuntu con el commit `fb6fc5f`.
- La ejecución
  [35380656658](https://github.com/jpascualgb/tunel-chat-mcp/actions/runs/35380656658)
  volvió a terminar correctamente en los tres sistemas el 18 de septiembre de
  2026.
- La ejecución posterior a la corrección
  [35384261757](https://github.com/jpascualgb/tunel-chat-mcp/actions/runs/35384261757)
  terminó correctamente en Windows, macOS y Ubuntu con el commit `ace9b06`.
- CodeQL con consultas ampliadas terminó correctamente en la ejecución
  [35384262009](https://github.com/jpascualgb/tunel-chat-mcp/actions/runs/35384262009).
  La alerta alta de carrera de archivos quedó corregida y la alerta media restante
  se documentó como falso positivo tras verificar la lista permitida de loopback;
  no quedan alertas CodeQL abiertas.
- GitHub mantiene activados informes privados de vulnerabilidades, Dependabot,
  escaneo de secretos y protección contra inserción de secretos. `main` exige pull
  request, historial lineal, conversaciones resueltas y CI verde en los tres
  sistemas; prohíbe force-push y borrado.

## Riesgos residuales

### Prioridad media

1. **Validación real de macOS y Linux.** En Windows se verificó un ciclo DPAPI
   completo. Las definiciones de Keychain, Secret Service, launchd y systemd tienen
   pruebas de contrato y CI multiplataforma, pero esta auditoría local no dispuso de
   sesiones macOS/Linux con sus almacenes desbloqueados. Debe completarse una prueba
   funcional en ambos sistemas antes de prometer soporte de producción.

2. **Binario externo.** `tunnel-client` no forma parte del historial y su código no
   se ha auditado aquí. Debe obtenerse del repositorio o canal oficial de OpenAI y
   verificarse con las sumas, SBOM y procedencia publicadas para su versión. Túnel
   Chat MCP no lo reempaqueta ni lo redistribuye.

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
- El contrato de entrada de imágenes y sus defensas de red tienen pruebas locales,
  pero el traspaso real de una imagen generada desde ChatGPT debe verificarse tras
  desplegar `v3.2.0` y actualizar la app conectada al túnel.

## Controles de publicación y mantenimiento

1. Mantener verde la validación de CI en los tres sistemas para cada versión.
2. Mantener macOS y Linux como experimentales hasta verificar manualmente almacén,
   arranque, reinicio y desinstalación en ambos sistemas.
3. No distribuir binarios de `tunnel-client`; dirigir a las versiones oficiales y
   recomendar la verificación de sus evidencias de integridad.
4. Mantener la API exclusivamente en loopback. Cualquier acceso remoto requiere un
   modelo de amenazas, autenticación y auditoría nuevos.
