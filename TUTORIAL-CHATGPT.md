# Conectar Túnel Chat MCP con ChatGPT.com

Este tutorial explica cómo conectar en ChatGPT el túnel que ya has configurado en
tu PC. El servidor permanece en tu equipo y `tunnel-client` establece una conexión
HTTPS saliente con OpenAI; no necesitas publicar el servidor local ni abrir puertos
entrantes.

> Consulta de referencia: [documentación oficial de OpenAI sobre Secure MCP
> Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels).

## Antes de empezar

Necesitas:

- Haber terminado la [configuración local](README.md#primera-configuración).
- Un túnel creado en [OpenAI Platform](https://platform.openai.com/settings/organization/tunnels).
- Que ese túnel esté asociado tanto a la organización de Platform como al espacio
  de trabajo de ChatGPT que vas a utilizar.
- Permiso **Tunnels Read + Use** en la organización de Platform.
- Acceso al modo desarrollador en ChatGPT. En Enterprise o Edu puede tener que
  habilitarlo un administrador del espacio de trabajo.

Los permisos del túnel en Platform y el acceso al modo desarrollador de ChatGPT son
independientes. Tener uno no concede automáticamente el otro.

## 1. Inicia el túnel en tu equipo

Ejecuta la interfaz portátil:

```text
node cli.mjs run
```

En Windows también puedes abrir PowerShell dentro del proyecto y ejecutar:

```powershell
.\start-tunnel.ps1
```

1. El iniciador te preguntará por la carpeta autorizada. Pulsa `Enter` para
   conservar la del perfil activo o escribe otra ruta para seleccionar o crear un
   perfil aislado.
2. Espera a que se abra el panel de control.
3. Comprueba que el estado sea **Conectado** o **Preparado**.
4. Mantén el proceso y el túnel en ejecución mientras lo configuras o utilizas
   desde ChatGPT.

Puedes comprobar el estado técnico en:

- Panel de este proyecto: <http://127.0.0.1:8080/ui>
- Panel técnico de `tunnel-client`: <http://127.0.0.1:8082/ui>

Si el panel principal solicita un enlace seguro, abre una nueva consola en el
proyecto y ejecuta:

```powershell
.\open-panel.ps1
```

No copies en ChatGPT la clave de API, el archivo de credenciales ni el enlace
privado del panel local.

## 2. Abre la sección de plugins de ChatGPT

1. Inicia sesión en el espacio de trabajo correcto de ChatGPT.
2. Abre [chatgpt.com/plugins](https://chatgpt.com/plugins).
3. Pulsa el botón **+** para crear una app en modo desarrollador.

Si no aparece el botón para crearla, revisa el apartado de [solución de
problemas](#solución-de-problemas).

## 3. Crea la app conectada al túnel

En el formulario de creación:

1. Escribe un nombre reconocible, por ejemplo **Túnel Chat MCP**.
2. En **Connection** o **Conexión**, selecciona **Tunnel**.
3. Elige tu túnel en la lista.
4. Si no aparece pero conoces su identificador, pega el valor `tunnel_...` en el
   campo que ofrece ChatGPT. No incluyas ese identificador en capturas o ejemplos
   públicos.
5. Revisa el nombre y la descripción de la app.
6. Guarda o crea la app.

ChatGPT solo puede descubrir el servidor y sus herramientas mientras
`tunnel-client` está en ejecución y conectado.

## 4. Haz una primera prueba de solo lectura

Antes de activar escritura o eliminación:

1. Deja activado únicamente el permiso **Lectura** en el panel local.
2. Mantén activadas **Aprobación por operación**, **Protección de archivos
   sensibles** y **Copias de seguridad**.
3. Abre un chat nuevo y selecciona la app que acabas de crear.
4. Envía este mensaje:

```text
Usa Túnel Chat MCP y ejecuta comprobar_estado_local. Dime solamente
la carpeta autorizada, los permisos efectivos y las protecciones activas.
No modifiques ningún archivo.
```

La respuesta debería mostrar el nombre del servidor, la carpeta autorizada y
permisos de solo lectura. Después puedes probar:

```text
Usa Túnel Chat MCP para listar los archivos y carpetas de la raíz
autorizada. No modifiques nada.
```

## 5. Prueba una modificación con aprobación local

Haz esta prueba únicamente dentro de una carpeta preparada para ello:

1. Activa **Creación** en el panel local durante 10 minutos.
2. Confirma que **Aprobación por operación** continúa activada.
3. Pide a ChatGPT:

```text
Usa Túnel Chat MCP para crear prueba-chatgpt.txt con el texto
"Conexión MCP verificada". Si necesita aprobación local, espera a que yo la
apruebe y después repite la operación con la aprobación correspondiente.
```

4. Revisa en el panel la ruta, acción y vista previa.
5. Aprueba la solicitud solo si coincide exactamente con lo que pediste.
6. Comprueba que el archivo se haya creado en la carpeta autorizada.
7. Desactiva **Creación** cuando termine la prueba.

No actives el modo autónomo hasta conocer bien el comportamiento del servidor y
de la app. En ese modo las operaciones permitidas se ejecutan sin una confirmación
individual en el panel.

## 6. Gestiona carpetas y guarda imágenes

Las nuevas herramientas utilizan los mismos permisos y aprobaciones del panel:

- **Crear carpeta** requiere **Creación**.
- **Copiar** requiere **Lectura** y **Creación**.
- **Mover, cortar/pegar o renombrar** requiere **Modificación** y **Creación**.
- **Eliminar una carpeta** requiere **Eliminación** y la conserva en la papelera
  local recuperable.
- **Guardar una imagen de ChatGPT** requiere **Creación** y nunca sobrescribe un
  archivo existente.

Puedes pedir, por ejemplo:

```text
Usa Túnel Chat MCP para crear la carpeta "imagenes", copiar la carpeta
"borradores" a "archivo/borradores" y renombrar "pendiente" como "revisado".
Solicita mi aprobación local cuando corresponda.
```

Para guardar una imagen generada o adjunta en el chat:

```text
Usa guardar_imagen_chatgpt para guardar esta imagen como
"imagenes/portada-chatgpt.png" dentro de la carpeta autorizada.
```

ChatGPT debe entregar la imagen a la herramienta como archivo. El conector declara
el formato de entrada oficial `openai/fileParams`; admite PNG, JPEG y WebP de hasta
20 MiB. Si la imagen solo aparece en un mensaje anterior y ChatGPT no la adjunta a
la llamada, vuelve a seleccionar o adjuntar esa imagen y repite la petición. La
referencia técnica está en la [documentación oficial de entradas de
archivo](https://developers.openai.com/es-419/plugins/reference#file-parameters).

Las operaciones recursivas están limitadas a 10.000 elementos y 512 MiB. No siguen
enlaces simbólicos ni uniones y no permiten copiar una carpeta dentro de sí misma.

## 7. Uso diario

En cada sesión:

1. Inicia el túnel o comprueba que el inicio automático del sistema esté activo.
2. Verifica en el panel la carpeta y el perfil activos.
3. Activa solo los permisos necesarios y, preferiblemente, durante un tiempo
   limitado.
4. Selecciona la app en ChatGPT y formula la tarea indicando rutas relativas.
5. Revisa las solicitudes de aprobación antes de aceptarlas.
6. Consulta el registro de actividad y desactiva los permisos de escritura al
   terminar.

Cambiar permisos en el panel no requiere volver a crear la app. Si actualizas el
código y cambian las herramientas MCP publicadas, reinicia el túnel y vuelve a
abrir o actualizar la app en ChatGPT para que descubra el esquema vigente.

## 8. Detener o desconectar

Para detener temporalmente el acceso:

- Pulsa **Apagar túnel** en el panel, o
- pulsa `Ctrl+C` en la consola que ejecuta `start-tunnel.ps1`.

Con el túnel detenido, ChatGPT conserva la configuración de la app, pero no puede
realizar llamadas al servidor local.

Para desconectarlo de forma permanente, elimina o desactiva la app desde ChatGPT y,
si ya no se va a utilizar, elimina la asociación o el túnel desde OpenAI Platform.
Antes de eliminar nada, comprueba que no lo utilicen otras apps o equipos.

## Solución de problemas

### No aparece la opción para crear una app

- Confirma que estás en el espacio de trabajo correcto de ChatGPT.
- Comprueba que tienes acceso al modo desarrollador.
- En Enterprise o Edu, pide al administrador que habilite ese acceso.

### El túnel no aparece en ChatGPT

- Comprueba en [Platform tunnel settings](https://platform.openai.com/settings/organization/tunnels)
  que está asociado al espacio de trabajo de ChatGPT objetivo, no solo a una
  organización de Platform.
- Comprueba que tienes **Tunnels Read + Use**.
- Si los permisos se acaban de conceder, su propagación puede tardar.

### La app aparece, pero no conecta o no muestra herramientas

1. Confirma que `start-tunnel.ps1` sigue en ejecución.
2. Revisa que <http://127.0.0.1:8082/readyz> indique que el cliente está preparado.
3. Ejecuta el diagnóstico local:

   ```powershell
   .\vendor\tunnel-client\tunnel-client.exe doctor --profile pc-personal --explain
   ```

4. Reinicia el túnel desde el panel.
5. Actualiza o vuelve a abrir la app en ChatGPT.

### ChatGPT ve la app, pero una operación está denegada

Esto suele significar que el permiso correspondiente está desactivado o ha
caducado. Actívalo desde el panel local y repite la llamada. Si la aprobación por
operación está activa, aprueba la solicitud local y repite exactamente la llamada
incluyendo el identificador de aprobación facilitado por el servidor.

### ChatGPT muestra una carpeta distinta de la esperada

No continúes con operaciones de escritura. Comprueba el perfil y la carpeta activa
en el panel local, cambia al perfil correcto y reinicia el túnel si el panel lo
solicita.

## Qué no debes compartir

No publiques ni pegues en chats, incidencias o capturas:

- Claves de API o credenciales del plano de control.
- El contenido de `%LOCALAPPDATA%\OpenAI-Secure-MCP-Tunnel`.
- El enlace efímero del panel que contiene `#<token>`.
- Rutas personales, listados o contenido de la carpeta autorizada.
- Registros de actividad sin revisarlos y redactarlos previamente.
