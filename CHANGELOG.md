# Historial de cambios

Este proyecto sigue [Versionado Semántico](https://semver.org/lang/es/).

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
