# Historial de cambios

Este proyecto sigue [Versionado Semántico](https://semver.org/lang/es/).

## [3.3.1] - 2026-09-19

### Correcciones

- Las imágenes y archivos descargados para una aprobación local se conservan
  temporalmente en memoria durante un máximo de 30 minutos. Tras aprobar, ChatGPT
  completa la escritura con `confirmar_guardado_chatgpt` y el identificador de la
  solicitud, sin tener que reconstruir el enlace temporal del archivo en otro turno.
- La confirmación diferida queda ligada al perfil, carpeta, destino, contenido y
  SHA-256 aprobados, se consume una sola vez y nunca permite cambiar la ruta.

### Seguridad

- El almacenamiento temporal no toca el disco, admite como máximo cuatro
  transferencias y 100 MiB en total, y libera los búferes al confirmar o caducar.
- Se mantiene la compatibilidad con el flujo anterior cuando ChatGPT sí puede
  repetir el descriptor completo del archivo.
- `@modelcontextprotocol/sdk` se actualizó a 1.32.1 y las dependencias transitivas
  vulnerables se renovaron a versiones corregidas y con firmas verificadas.

## [3.3.0] - 2026-09-19

### Funcionalidad

- Nueva herramienta `guardar_archivo_chatgpt` para conservar como archivos nuevos
  documentos, hojas de cálculo, presentaciones, PDF, texto, datos, ZIP, imágenes,
  audio y vídeo que ChatGPT entregue mediante `openai/fileParams`.
- Las descargas generales admiten hasta 50 MiB y reutilizan los permisos de
  creación, la aprobación local o el modo autónomo, el registro y el confinamiento
  a la carpeta autorizada. Se limitan a dos transferencias simultáneas.

### Seguridad

- La firma, el MIME y la extensión deben coincidir. Se bloquean descargas directas
  de ejecutables, scripts, accesos directos, documentos con macros, HTML y SVG.
- Los ZIP se conservan cerrados y nunca se descomprimen ni ejecutan. Todas las
  descargas mantienen HTTPS, puerto 443, validación de cada redirección, bloqueo de
  redes privadas y fijación de la dirección DNS validada.

### Correcciones

- La fijación DNS admite la forma `all: true` usada por Node.js 22, evitando el
  error `Invalid IP address: undefined` sin rebajar la protección SSRF.

## [3.2.1] - 2026-09-19

### Corrección

- El iniciador vuelve a aceptar `workspace.json` heredados que PowerShell guardó
  con una marca UTF-8 BOM. Estos perfiles ya no se interpretan como configuración
  dañada y pueden arrancar con la credencial protegida actual.
- Se añadió una prueba de regresión que reproduce el archivo heredado real.

## [3.2.0] - 2026-09-19

### Funcionalidad

- Nuevas herramientas MCP para crear carpetas, copiar árboles, mover o renombrar
  elementos y eliminar carpetas de forma recuperable.
- Nueva entrada de archivo oficial de ChatGPT para guardar imágenes PNG, JPEG y
  WebP dentro de la carpeta autorizada, siempre como archivos nuevos.
- Las nuevas acciones respetan los permisos temporales, el modo autónomo, las
  aprobaciones locales, la protección sensible y el registro de actividad.

### Seguridad

- Los árboles se limitan a 10.000 elementos y 512 MiB, rechazan enlaces simbólicos,
  uniones, enlaces duros y archivos especiales, y se vinculan a una huella de
  contenido antes de aprobarlos.
- Las copias y movimientos verifican la integridad del resultado; la eliminación
  de carpetas se revierte si falla la verificación o el registro en la papelera.
- Las descargas de imágenes exigen HTTPS y puerto 443, fijan la dirección pública
  resuelta y vuelven a validar cada redirección. Se bloquean direcciones privadas,
  locales, reservadas y mapeadas mediante IPv6, además de limitar tiempo y tamaño.
- El tipo MIME declarado no basta: la firma del archivo debe corresponder a PNG,
  JPEG o WebP y la extensión de destino debe coincidir.

## [3.1.1] - 2026-09-18

### Seguridad

- El escáner de secretos abre, comprueba y lee cada archivo mediante el mismo
  descriptor, evitando una condición de carrera entre la inspección y la lectura.
- El escaneo falla de forma segura si un archivo cambia mientras se inspecciona o
  no puede abrirse con las garantías requeridas.
- Se añadió una prueba de regresión determinista para este escenario.

## [3.1.0] - 2026-09-18

Primera versión pública de Túnel Chat MCP.

### Funcionalidad

- Acceso limitado a una carpeta autorizada desde ChatGPT mediante Secure MCP Tunnel.
- Lectura, creación, modificación y eliminación recuperable con permisos separados.
- Aprobaciones locales opcionales, copias verificadas y registro encadenado.
- Panel local en español e inglés, perfiles aislados y control del inicio automático.
- CLI portátil y adaptadores para Windows, macOS y Linux.

### Seguridad

- Panel limitado a loopback con token efímero y cabeceras defensivas.
- Credencial del plano de control almacenada mediante DPAPI, Keychain o Secret Service.
- Bloqueo de escapes de ruta, enlaces, ADS, secretos habituales y espacios protegidos.
- Pruebas multiplataforma, escaneo de secretos y auditoría de dependencias en CI.

### Compatibilidad

- Windows 10/11: validado funcionalmente.
- macOS y Linux de escritorio: implementación y pruebas automáticas disponibles;
  validación funcional comunitaria pendiente.

### Distribución

Esta versión contiene únicamente el código de Túnel Chat MCP. No incluye
`tunnel-client`, credenciales, perfiles, registros, copias de seguridad ni datos de
usuario. `tunnel-client` debe obtenerse de OpenAI por separado.
