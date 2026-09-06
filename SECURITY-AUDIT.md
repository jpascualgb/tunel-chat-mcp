# Auditoría de seguridad — 6 de septiembre de 2026

## Resultado

No se han encontrado vulnerabilidades críticas. Las recomendaciones inmediatas de
esta revisión ya están aplicadas, pero el proyecto debe permanecer privado hasta
resolver los dos hallazgos de prioridad alta descritos más abajo.

El límite de confianza sigue siendo la cuenta local de Windows: el túnel protege
el acceso remoto y restringe la carpeta autorizada, pero no pretende aislarse de
otro proceso malicioso que ya se ejecute con la misma cuenta del usuario.

## Mejoras verificadas en esta revisión

- La clave del plano de control ya no se publica en el entorno del proceso de
  PowerShell que inicia el sistema.
- El controlador retira las credenciales de OpenAI de su propio entorno y de los
  procesos auxiliares. Solo construye un entorno con la clave necesaria al iniciar
  `tunnel-client`.
- `mcp-launcher.mjs` elimina esas credenciales antes de importar el código del
  servidor MCP. La limitación y su modelo de amenazas se registran en
  [ADR-001](docs/decisions/0001-limit-control-plane-key-scope.md).
- La credencial almacenada continúa protegida con DPAPI y ACL restringidas.
- El panel continúa ligado a `127.0.0.1`, con token efímero, comprobación de origen,
  CSP y cabeceras defensivas.
- Se añadió integración continua para ejecutar pruebas y auditoría de dependencias
  en cambios, propuestas de cambio y semanalmente. Las acciones oficiales están
  fijadas por hash de commit y el flujo solo tiene permiso de lectura.
- Se corrigió `qs` de `6.15.3` a `6.16.0`; `npm audit --omit=dev` termina sin
  vulnerabilidades conocidas.

## Hallazgos abiertos

### Prioridad alta

1. **Las vistas previas para aprobar cambios cargan archivos completos en memoria.**
   `server.mjs` lee el archivo entero antes de acotarlo visualmente al sobrescribir
   o eliminar. Un archivo muy grande dentro de la carpeta autorizada puede agotar
   memoria. Debe leerse solo una ventana limitada y probarse con archivos grandes.

2. **La restauración necesita volver a comprobar el destino justo antes de
   escribir.** Las operaciones de restaurar una copia o la papelera validan rutas
   léxicas, pero no repiten todas las comprobaciones contra enlaces simbólicos o
   uniones del flujo MCP. Además, restaurar una copia puede sobrescribir un archivo
   más reciente. Deben usar una resolución segura común, fallar si el destino ya
   existe salvo confirmación explícita y escribir de forma atómica.

### Prioridad media

- La comprobación de hash, la copia de seguridad y la escritura son pasos
  separados; otro proceso local podría cambiar el archivo entre ellos.
- La cadena del registro de auditoría dispone de verificador, pero este no se
  ejecuta automáticamente al iniciar, y cada rotación comienza una cadena nueva.
- El campo `confirmar` del esquema de algunas herramientas no participa en la
  autorización efectiva y puede inducir a error.
- La lectura por fragmentos calcula la huella del archivo completo, por lo que un
  archivo enorme sigue consumiendo E/S completa.
- Si el movimiento a la papelera funciona y después falla la escritura de sus
  metadatos, puede quedar un elemento recuperable sin índice.

### Prioridad baja o limitaciones conocidas

- Una aplicación maliciosa que ya se ejecute con la misma cuenta puede intentar
  inspeccionar memoria o procesos. La clave debe rotarse ante cualquier sospecha.
- Los scripts de instalación, almacén seguro e inicio automático solo son
  compatibles con Windows. La evolución segura para macOS y Linux está definida en
  [ROADMAP.md](ROADMAP.md), sin recurrir a claves en texto plano.
- La API del panel ya está separada de la interfaz, pero todavía no está versionada
  ni documentada como interfaz estable. Debe seguir siendo exclusivamente local.

## Evidencia de verificación

- Pruebas automatizadas del saneamiento del entorno, servidor MCP y panel.
- Comprobación sintáctica de JavaScript y PowerShell.
- `npm audit --omit=dev`: cero vulnerabilidades conocidas tras actualizar `qs`.
- Revisión de diferencias y búsqueda de patrones habituales de secretos.
- Flujo de CI para Windows y Node.js 22 en cada cambio propuesto y semanalmente.

## Condiciones antes de publicar

1. Corregir y cubrir con pruebas los dos hallazgos de prioridad alta.
2. Repetir esta auditoría y el escaneo del historial completo de Git.
3. Confirmar las condiciones de redistribución de `tunnel-client`; el ejecutable no
   forma parte del repositorio.
4. Mantener la API en bucle local. Cualquier acceso remoto requerirá un modelo de
   amenazas nuevo, autenticación fuerte y otra revisión independiente.
