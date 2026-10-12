# ADR-005: Confirmación diferida de archivos de ChatGPT

## Estado

Aceptada

## Fecha

2026-09-19

## Contexto

`openai/fileParams` entrega a la primera llamada un objeto con una URL temporal y
un identificador de archivo. Si el panel exige aprobación, el modelo debe continuar
en otro turno. ChatGPT no garantiza que pueda reconstruir en ese turno el mismo
objeto temporal, aunque el archivo generado siga visible en la conversación. Pedir
que repita la herramienta original puede fallar antes de alcanzar el servidor.

La aprobación debe seguir vinculada exactamente al contenido descargado y al
destino mostrado, sin convertir la URL temporal en una autorización reutilizable ni
escribir datos no aprobados en disco.

## Decisión

- Descargar y validar el archivo antes de crear la solicitud de aprobación, como
  hasta ahora, y conservar el búfer validado únicamente en memoria.
- Añadir `confirmar_guardado_chatgpt`, una herramienta aditiva que recibe solo el
  `aprobacion_id`. No acepta archivo ni destino, por lo que no puede modificar la
  operación mostrada en el panel.
- Ligar la aprobación a perfil, huella del espacio autorizado, acción, ruta y
  SHA-256. Consumirla atómicamente una sola vez antes de escribir.
- Revalidar permiso, destino, enlaces y ausencia del archivo inmediatamente antes
  de la escritura atómica.
- Caducar el búfer a los 30 minutos y limitar el almacén a cuatro transferencias y
  100 MiB. No persistir contenido temporal en disco ni en el registro.
- Mantener el argumento `aprobacion_id` de las herramientas originales para
  compatibilidad con clientes que sí puedan repetir el descriptor completo.

## Alternativas consideradas

### Exigir que ChatGPT vuelva a adjuntar el archivo

Rechazada porque obliga al usuario a repetir una generación o selección que ya fue
validada y aprobada, y el enlace temporal puede cambiar entre turnos.

### Guardar el archivo temporal en disco

Rechazada para esta escala porque amplía la superficie de datos persistentes,
requiere limpieza frente a fallos y complica los permisos del almacén privado.

### Desactivar las aprobaciones para archivos

Rechazada porque elimina un control de seguridad elegido explícitamente por el
usuario.

## Consecuencias

- Reiniciar el servidor invalida transferencias pendientes; el usuario debe volver
  a enviarlas para obtener una aprobación nueva.
- Los límites de memoria impiden acumular indefinidamente archivos a la espera de
  aprobación.
- Añadir la herramienta requiere reiniciar el túnel y actualizar las acciones del
  complemento en ChatGPT.
