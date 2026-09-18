# Secure MCP Local Guard

Servidor MCP local para trabajar con archivos privados desde ChatGPT mediante
[OpenAI Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels),
sin abrir puertos entrantes ni publicar el servidor local en Internet.

> Estado: versión local funcional y endurecida en Windows, distribuida bajo
> Apache-2.0. La implementación de macOS y Linux tiene pruebas automáticas, pero
> aún requiere validación funcional en equipos reales. La
> instalación privada de `tunnel-client` debe sustituirse por las instrucciones de
> distribución oficiales que correspondan.

## Qué permite hacer

- Listar carpetas y archivos.
- Leer texto o archivos binarios por fragmentos.
- Crear y sobrescribir archivos con protección frente a cambios concurrentes.
- Mover archivos a una papelera recuperable.
- Crear y restaurar copias de seguridad verificadas.
- Exigir una aprobación local para cada escritura o permitir un modo autónomo.
- Activar permisos por 10, 30 o 60 minutos, o sin límite temporal.
- Mantener varios perfiles de carpetas completamente aislados.
- Controlar el túnel, el inicio automático nativo y los permisos desde un panel ES/EN.

No existe ninguna herramienta para ejecutar comandos, PowerShell o programas.

## Modelo de seguridad

- Solo se acepta una carpeta explícitamente autorizada; nunca una unidad completa,
  Windows, el propio proyecto ni una carpeta que lo contenga.
- Cada perfil tiene permisos, aprobaciones y copias independientes, ligados a la
  huella de su carpeta real.
- Las aprobaciones son de un solo uso y se consumen de forma atómica.
- Se bloquean escapes con `..`, rutas absolutas, enlaces simbólicos, enlaces duros, uniones,
  flujos ADS, nombres reservados de Windows, secretos habituales y los datos del
  propio túnel.
- Los archivos con más de un enlace duro se rechazan aunque todos sus nombres
  parezcan estar dentro de la carpeta autorizada: no es posible demostrarlo con
  `realpath`. Los enlaces temporales usados internamente para crear archivos
  atómicamente se eliminan antes de finalizar la operación.
- Las copias llevan perfil, huella de carpeta y SHA-256. Los metadatos se validan
  antes de listar, limpiar o restaurar.
- La credencial del plano de control se protege con DPAPI, Keychain o Secret
  Service, según el sistema. Durante la ejecución se
  retira del entorno del controlador, solo se añade deliberadamente al proceso de
  `tunnel-client` y se elimina antes de cargar el código del servidor MCP o iniciar
  procesos auxiliares. La decisión está documentada en
  [ADR-001](docs/decisions/0001-limit-control-plane-key-scope.md).
- El panel escucha exclusivamente en `127.0.0.1`, usa token efímero anti-CSRF,
  política CSP y cabeceras defensivas.
- La auditoría rota automáticamente y encadena criptográficamente sus eventos para
  detectar modificaciones accidentales o posteriores.

El límite final de confianza es la cuenta local del sistema. Otro proceso malicioso
ejecutado como el mismo usuario podría manipular archivos o procesos locales.

## Datos privados

El código no contiene perfiles, rutas personales, credenciales, aprobaciones,
copias ni registros. Las ubicaciones predeterminadas son:

```text
%LOCALAPPDATA%\OpenAI-Secure-MCP-Tunnel
~/Library/Application Support/OpenAI-Secure-MCP-Tunnel
${XDG_STATE_HOME:-~/.local/state}/openai-secure-mcp-tunnel
```

La carpeta `.tunnel-client`, `vendor`, `.env` y los registros están excluidos por
`.gitignore`. Antes de hacer público un repositorio, revisa también todo su historial
Git y rota cualquier credencial que haya llegado a un commit.

## Requisitos

- Windows 10/11, macOS o Linux con sesión de usuario.
- Node.js 22 o posterior.
- Acceso a Secure MCP Tunnel en la organización de OpenAI.
- Una copia autorizada de `tunnel-client`. En Windows se detecta la copia de
  `vendor\tunnel-client\tunnel-client.exe`; en macOS/Linux se indica con `--client`
  o `MCP_TUNNEL_CLIENT_PATH` si no está en `PATH`.
- Keychain disponible en macOS o un proveedor Secret Service desbloqueado en Linux.

## Primera configuración

1. Guarda la credencial sin incluirla en argumentos:

```text
node cli.mjs credential set
```

2. Configura y verifica el cliente:

```text
node cli.mjs setup --workspace "RUTA" --tunnel-id "tunnel_<32_caracteres_minusculos_o_digitos>" --client "RUTA_CLIENTE"
```

3. Inicia el servicio:

```text
node cli.mjs run
```

Con el panel iniciado, el ciclo de vida también puede controlarse desde terminal:

```text
node cli.mjs tunnel status
node cli.mjs tunnel stop
node cli.mjs tunnel start
node cli.mjs tunnel restart
```

En Windows se conservan los flujos compatibles de PowerShell:

```powershell
cd "<RUTA_DEL_PROYECTO>"
.\setup-tunnel.ps1
```

Comprueba que el diagnóstico termina en `RESULT ok`.

`setup-tunnel.ps1` configura el MCP con `mcp-launcher.mjs`, que limpia las
credenciales de OpenAI antes de importar `server.mjs`.

## Inicio manual

```powershell
cd "<RUTA_DEL_PROYECTO>"
.\start-tunnel.ps1
```

El iniciador pide la carpeta autorizada. Pulsa `Enter` para conservar la guardada o
escribe otra. Mantén abierta la ventana: `Ctrl+C` apaga el controlador y el túnel.

- Panel principal: se abre automáticamente al iniciar de forma interactiva. Si el
  túnel se inició en segundo plano, ejecuta `.\open-panel.ps1`.
- Panel técnico del cliente: <http://127.0.0.1:8082/ui>
- Salud: <http://127.0.0.1:8080/healthz>
- Preparación: <http://127.0.0.1:8080/readyz>

## Conectar desde ChatGPT.com

Consulta el tutorial [Conectar Secure MCP Local Guard con
ChatGPT.com](TUTORIAL-CHATGPT.md). Explica paso a paso cómo crear la app en modo
desarrollador, seleccionar el túnel, probar primero el acceso de solo lectura,
aprobar una modificación y solucionar problemas de conexión.

## Inicio automático

Después de configurar el túnel:

```text
node cli.mjs autostart enable
node cli.mjs autostart status
node cli.mjs autostart disable
```

En Windows también siguen disponibles:

```powershell
.\enable-autostart.ps1
```

Para desactivarlo:

```powershell
.\disable-autostart.ps1
```

También puede cambiarse desde el panel.

Para retirar el arranque y la credencial nativa sin borrar registros ni copias:

```text
node cli.mjs uninstall --yes
```

En macOS/Linux, la desinstalación comprueba que el servicio esté detenido y que
la credencial haya desaparecido. Si el gestor de servicios falla, conserva la
definición hasta poder confirmar la parada. Si el almacén está bloqueado o no
responde, informa del error y no anuncia éxito. Desbloquea el almacén y repite
la operación; en macOS hace falta una sesión gráfica disponible. La operación
es idempotente cuando se puede confirmar que servicio y credencial ya no existen.
Las instancias iniciadas manualmente se detienen desde su panel o terminal.

## Panel de control

El panel está en español por defecto y permite cambiar a inglés. Los permisos de
lectura, creación, modificación y eliminación se aplican inmediatamente. La
aprobación por operación, protección sensible, copias y retención son independientes
para cada perfil.

Al cambiar de perfil se reinicia el túnel si estaba activo. Las aprobaciones del
perfil anterior no aparecen ni pueden utilizarse en el nuevo.

El panel usa un enlace efímero cuyo secreto viaja en el fragmento `#` y se elimina
de la barra de direcciones al cargar. El enlace se guarda en la carpeta privada y
no se incrusta en el HTML público de `127.0.0.1`.

## Pruebas

```powershell
npm test
```

Las pruebas usan carpetas temporales y cubren permisos, lectura binaria, escapes de
ruta, ADS, secretos, copias, papelera, aislamiento de perfiles y consumo simultáneo
de aprobaciones.

## Archivos principales

- `cli.mjs`: interfaz portátil de configuración, inicio y autostart.
- `platform-runtime.mjs`: almacenes de credenciales y servicios nativos.
- `control-api-contract.mjs`: contrato validado de `/api/v1`.
- `control-panel.mjs`: backend y ciclo de vida local.
- `panel/`: interfaz adaptable ES/EN.
- `server.mjs`: herramientas MCP y límites del espacio autorizado.
- `mcp-launcher.mjs`: saneamiento del entorno antes de cargar el MCP.
- `secure-store.mjs`: estado por perfil, bloqueo atómico y auditoría.
- `harden-private-data.ps1`: restringe los ACL de los datos privados.
- `open-panel.ps1`: abre el enlace efímero del panel desde el almacén privado.
- `start-tunnel.ps1`: inicio manual.
- `enable-autostart.ps1` y `disable-autostart.ps1`: inicio con Windows.
- `SECURITY.md`: política de seguridad y divulgación responsable.
- `SECURITY-AUDIT.md`: última auditoría y riesgos residuales conocidos.
- `TUTORIAL-CHATGPT.md`: conexión, prueba y desconexión desde ChatGPT.com.
- `docs/control-api-v1.md`: interfaz local versionada.
- `docs/decisions/`: decisiones de arquitectura y sus límites de seguridad.

## Publicación

El repositorio es público en
[github.com/jpascualgb/secure-mcp-local-guard](https://github.com/jpascualgb/secure-mcp-local-guard).
Antes de instalarlo, redistribuirlo o publicar una modificación:

1. Confirmar las condiciones de redistribución de `tunnel-client`; `vendor/` está
   excluido del repositorio.
2. Completar las validaciones reales y las comprobaciones del binario externo
   indicadas en [SECURITY-AUDIT.md](SECURITY-AUDIT.md).
3. Volver a ejecutar las pruebas, la auditoría de dependencias y un escaneo de
   secretos. La integración continua ya ejecuta pruebas y `npm audit` en cada
   cambio propuesto y semanalmente.
4. Revisar que no haya rutas, capturas ni identificadores personales.
5. Mantener activadas en GitHub las funciones disponibles de Dependabot, análisis
   de secretos y protección de la rama principal.

## Licencia

Este proyecto se distribuye bajo la [Apache License 2.0](LICENSE). El archivo
`NOTICE` identifica al titular inicial. La licencia no cubre `tunnel-client.exe`,
marcas de OpenAI ni dependencias de terceros.
