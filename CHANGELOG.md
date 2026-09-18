# Historial de cambios

Este proyecto sigue [Versionado Semántico](https://semver.org/lang/es/).

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
