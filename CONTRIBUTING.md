# Contribuir a Túnel Chat MCP

Gracias por ayudar a mejorar el proyecto. Los cambios pequeños, verificables y con
una explicación clara son más fáciles de revisar.

## Antes de empezar

- Busca primero una incidencia relacionada.
- Para una vulnerabilidad, no abras una incidencia pública: usa el
  [reporte privado](https://github.com/jpascualgb/tunel-chat-mcp/security/advisories/new).
- No compartas claves, identificadores de túnel, rutas personales, registros sin
  limpiar ni contenido de carpetas privadas.
- `tunnel-client` es una dependencia externa: no añadas sus binarios a `vendor/` ni
  al historial Git.

## Preparar el entorno

```text
git clone https://github.com/jpascualgb/tunel-chat-mcp.git
cd tunel-chat-mcp
npm ci --ignore-scripts
npm test
```

Se requiere Node.js 22 o posterior. Trabaja en una rama y abre una propuesta de
cambio contra `main`.

## Comprobaciones obligatorias

Antes de enviar cambios:

```text
npm test
npm run check
npm run security:scan
npm audit --omit=dev --audit-level=moderate
```

Revisa también `git diff` para confirmar que no contiene datos privados. No uses
`npm audit fix --force`; las actualizaciones de dependencias deben revisarse y
probarse individualmente.

## Informes de macOS y Linux

Las validaciones deben indicar sistema, versión, arquitectura, versión de Node.js y
versión de `tunnel-client`. Usa una carpeta temporal sin datos personales y prueba,
como mínimo, configuración, almacén de credenciales, inicio, lectura, escritura con
aprobación, reinicio, inicio automático y desinstalación.

## Licencia

Al enviar una contribución aceptas que se distribuya bajo la Apache License 2.0 del
repositorio. Conserva las atribuciones de código de terceros y declara cualquier
material que no sea original.
