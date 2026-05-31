# Guía de Pruebas de Transcripción de Larga Duración en Español

Esta guía contiene los pasos detallados y comandos `curl` necesarios para realizar pruebas de extremo a extremo (End-to-End) en el sistema **PostNotes** con archivos de audio de larga duración (~90 minutos) configurados para el idioma **Español (es)**.

---

## 📋 Requisitos Previos

1. Asegúrate de tener los contenedores Docker en funcionamiento:
   ```bash
   docker compose up -d
   ```
2. Tener un archivo de audio de prueba en tu máquina local.
   * *Ejemplo:* `/home/kovac/Descargas/clase-90min.mp3`

---

## 🛠️ Paso 1: Verificar la Salud del Backend

Antes de iniciar la subida de un archivo grande, asegúrate de que la API de Express esté levantada y lista para recibir peticiones:

```bash
curl -s http://localhost:3000/api/health | jq
```
* **Respuesta esperada**: `{"status":"healthy","timestamp":"..."}`

---

## 📝 Paso 2: Crear una Nueva Nota

Cada archivo de audio subido debe estar asociado a una Nota. Crearemos una nota específica para esta prueba en español y obtendremos su identificador único (`id`).

```bash
curl -X POST \
  -H "Content-Type: application/json" \
  -d '{"title": "Clase de 90 Minutos en Español (Optimizado)"}' \
  http://localhost:3000/api/notes
```

### 📥 Ejemplo de Respuesta
```json
{
  "id": "cl7y01h9a00003567xxxxxxxx",
  "title": "Clase de 90 Minutos en Español (Optimizado)",
  "userId": "cl7y01h9a00003567yyyyyyyy",
  "content": [],
  "createdAt": "2026-05-27T06:00:00.000Z",
  "updatedAt": "2026-05-27T06:00:00.000Z",
  "audioJobs": []
}
```

> ⚠️ **IMPORTANTE**: Copia el valor de `"id"` que te devuelva el comando (ej: `cl7y01h9a00003567xxxxxxxx`). Lo usaremos como `<ID_DE_LA_NOTA>` en los siguientes pasos.

---

## 📡 Paso 3: Escuchar el Progreso en Tiempo Real (Server-Sent Events)

El backend de PostNotes cuenta con una conexión en tiempo real vía **SSE (Server-Sent Events)** ligada a los eventos de BullMQ. Esto te permite ver exactamente qué ocurre sin tener que consultar repetidamente el servidor.

Abre una **nueva pestaña o terminal** en tu máquina y ejecuta el siguiente comando para mantener una escucha activa de eventos sobre tu nota:

```bash
curl -N -s http://localhost:3000/api/notes/<ID_DE_LA_NOTA>/progress
```

Este terminal se mantendrá abierto y mostrará líneas con el progreso en tiempo real. Por ejemplo:
* `PENDING` (En cola)
* `PROCESSING` (Transcribiendo con Faster-Whisper o API remota)
* `COMPLETED` (Finalizado con éxito, guardando el apunte estructurado en bloques)
* `FAILED` (En caso de algún error)

---

## 🎙️ Paso 4: Subir el Audio de 90 Minutos

Sube tu archivo de audio asociándolo al `<ID_DE_LA_NOTA>` creado en el Paso 2. 

Utilizaremos el parámetro `language=es` en la URL de consulta (query string) para indicarle al motor de transcripción que fuerce el idioma español.

### Opción A: Procesamiento Local con `faster-whisper` (Optimizado para ARM64)
Usa el transcriptor local gratuito corriendo en el contenedor `transcriber`. Es ideal para conservar la privacidad y no tener costos de API.

```bash
curl -X POST \
  -F "audio=@/ruta/completa/a/tu/audio.mp3" \
  "http://localhost:3000/api/notes/<ID_DE_LA_NOTA>/audio?language=es&modelSize=base&provider=local"
```
*(Puedes cambiar `modelSize` por `medium` o `large-v3` si deseas probar otros tamaños de modelo local en tu servidor, aunque `base` ofrece un balance excelente de velocidad/precisión).*

---

### Opción B: Procesamiento Remoto Ultra Rápido con `Groq Whisper`
Si tienes configurada tu clave `GROQ_API_KEY` en tu archivo `.env`, puedes delegar la transcripción a la infraestructura en la nube de Groq.
* **Nota sobre límites**: Las APIs remotas tienen un límite estricto de 25MB de subida. Si tu archivo de 90 minutos pesa más de 24MB, el worker de PostNotes **lo comprimirá automáticamente usando ffmpeg** (a mono de 32kbps) antes de enviarlo.

```bash
curl -X POST \
  -F "audio=@/ruta/completa/a/tu/audio.mp3" \
  "http://localhost:3000/api/notes/<ID_DE_LA_NOTA>/audio?language=es&provider=groq"
```

---

### Opción C: Procesamiento Remoto con `OpenAI Whisper`
Si tienes una clave `OPENAI_API_KEY` activa y deseas probar con la API oficial de OpenAI Whisper:

```bash
curl -X POST \
  -F "audio=@/ruta/completa/a/tu/audio.mp3" \
  "http://localhost:3000/api/notes/<ID_DE_LA_NOTA>/audio?language=es&provider=openai"
```

---

## 📈 Paso 5: Consultar el Estado del Trabajo (Manual Polling)

Cuando ejecutes la subida del audio en el Paso 4, el backend te responderá instantáneamente (en menos de 1 segundo) confirmando que el archivo fue cargado y encolado en BullMQ. Te entregará un `jobId`:

```json
{
  "message": "Audio uploaded successfully. Transcription job queued.",
  "jobId": "a9a3b9cc-0f9c-4613-8822-cd120d2a84a6",
  "audioJob": {
    "id": "a9a3b9cc-0f9c-4613-8822-cd120d2a84a6",
    "noteId": "cl7y01h9a00003567xxxxxxxx",
    "status": "PENDING",
    "createdAt": "2026-05-27T06:01:00.000Z"
  }
}
```

Si prefieres monitorear el estado de manera manual sin el SSE del Paso 3, puedes consultar el endpoint de salud de la tarea usando el `jobId` devuelto:

```bash
curl -s http://localhost:3000/api/jobs/<JOB_ID> | jq
```

### Estados Posibles:
* **PENDING**: La tarea está en la cola BullMQ esperando que el Worker de NodeJS se libere (el Worker tiene concurrencia máxima de 1 para evitar sobrecargar la CPU del servidor).
* **PROCESSING**: El Worker está transcribiendo el audio (y comprimiéndolo si fuera necesario).
* **COMPLETED**: La transcripción finalizó con éxito y los apuntes estructurados por el LLM han sido guardados en la nota.
* **FAILED**: El proceso falló (se incluirá el campo `errorMessage` con el detalle del error).

---

## 📓 Paso 6: Obtener la Nota y los Apuntes Estructurados finales

Una vez que el estado del trabajo sea `COMPLETED`, el texto crudo y la estructuración Notion-style en formato JSON compatible con el frontend estará asociada a la nota original. Obtén tu apunte final con el siguiente comando:

```bash
curl -s http://localhost:3000/api/notes/<ID_DE_LA_NOTA> | jq
```

---

## 🔍 Visualización de Logs en Tiempo Real

Para un monitoreo profundo del comportamiento interno del sistema en tu servidor Docker, abre otra terminal y ejecuta el visor de logs:

```bash
docker compose logs -f backend-worker transcriber backend-api
```

Esto te permitirá ver:
1. El momento en el que el `backend-api` recibe el archivo multipart y lo escribe en el volumen compartido `/app/shared_audio`.
2. Al `backend-worker` recogiendo la tarea de BullMQ.
3. Si el archivo pesa más de 24MB y se selecciona `groq`/`openai`, verás la compresión ejecutándose en tiempo real mediante `ffmpeg`.
4. El envío HTTP al servicio local de `transcriber` y el reporte de progreso.
