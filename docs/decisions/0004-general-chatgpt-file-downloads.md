# ADR-004: Descargas generales de archivos de ChatGPT

## Estado

Aceptada

## Fecha

2026-09-19

## Contexto

La entrada inicial de archivos de ChatGPT solo guardaba imágenes PNG, JPEG y WebP.
Los usuarios también generan PDF, documentos, hojas de cálculo, presentaciones,
datos, archivos comprimidos y contenido multimedia que necesitan conservar dentro
de su carpeta autorizada. Esos enlaces y metadatos proceden de una frontera remota
no confiable y ampliar los formatos aumenta el riesgo de SSRF, archivos disfrazados,
contenido activo y consumo de memoria.

## Decisión

- Conservar `guardar_imagen_chatgpt` y añadir `guardar_archivo_chatgpt`; el cambio
  es aditivo y no rompe conectores existentes.
- Reutilizar `openai/fileParams`, la descarga HTTPS con DNS fijado, la validación de
  redirecciones, los permisos de creación, las aprobaciones y la escritura atómica.
- Limitar los archivos generales a 50 MiB y a dos descargas simultáneas. Este flujo
  usa un único enlace HTTPS temporal; no incorpora las sesiones fragmentadas
  PC↔VPS de Túnel Agente MCP.
- Exigir coherencia entre firma, MIME y extensión. Permitir únicamente formatos
  reconocidos de documentos, datos, ZIP, imágenes, audio y vídeo.
- Bloquear como archivo directo ejecutables, scripts, accesos directos, HTML, SVG y
  formatos Office con macros. Detectar también indicadores de macros dentro de un
  contenedor Office aunque utilice una extensión no macro.
- Guardar ZIP como contenido opaco. No descomprimirlos ni ejecutar su contenido;
  mostrar su tipo, tamaño y SHA-256 en la aprobación local.
- Crear siempre un archivo nuevo. Nunca sobrescribir un destino existente.

## Consecuencias

- Desde `v3.3.1`, una aprobación pendiente conserva el archivo validado en memoria
  durante un máximo de 30 minutos y se completa con una acción separada. Si el
  plazo caduca o el servidor se reinicia, el usuario debe volver a adjuntar o
  seleccionar el archivo. Véase [ADR-005](0005-staged-chatgpt-file-approvals.md).
- Los archivos mayores de 50 MiB requieren otro mecanismo de transferencia. Elevar
  este límite exigiría almacenamiento temporal en disco y descarga por streaming.
- El túnel valida el contenedor ZIP pero no actúa como antivirus de su contenido;
  quien lo extraiga debe aplicar las protecciones habituales del sistema.
- Añadir la herramienta requiere reiniciar el túnel y actualizar las acciones del
  conector en ChatGPT.
