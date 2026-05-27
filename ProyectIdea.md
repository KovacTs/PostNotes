Actúa como un Arquitecto de Software y Desarrollador Full-Stack Senior. Necesito que me ayudes a construir un proyecto personal desde cero. No busco comercializar esta app, es una herramienta de uso exclusivo para mí. 

**Contexto del Proyecto:**
Como estudiante de Ingeniería Civil en Informática y Telecomunicaciones en la Universidad Diego Portales, necesito una aplicación móvil para grabar mis clases y reuniones, transcribirlas automáticamente y utilizar un LLM para generar apuntes estructurados. Quiero que la interfaz de las notas funcione con un editor de bloques al estilo Notion (donde pueda leer, editar o borrar texto estructurado). 

Mi entorno de desarrollo local es Arch Linux (con Hyprland), pero la aplicación estará alojada en producción en la capa Always Free de Oracle Cloud (OCI). Quiero mantener una lógica de "Autoservicio / On-Demand" para interactuar con mis notas y pedir resúmenes específicos cuando lo necesite.

**Stack Tecnológico Definido:**
- **Frontend Móvil:** React Native (con Expo) para permitir la grabación de audio en segundo plano sin que el sistema operativo lo congele.
- **App de escritorio para archlinux:** electron (con react y vite)
- **Editor de Notas:** BlockNote.js o Tiptap (adaptado para React Native/Web) para manejar estructuras JSON de bloques en lugar de texto plano.
- **Backend:** Node.js con Express, utilizando TypeScript.
- **Base de Datos y ORM:** PostgreSQL gestionado a través de Prisma.
- **Colas de Tareas Asíncronas:** BullMQ + Redis.
- **Microservicio de IA (Local):** Python (FastAPI) ejecutando Faster-Whisper para transcripción gratuita.
- **LLM Externo:** GPT-4o-mini (o Claude 3.5 Haiku) para procesar la transcripción y generar el JSON de los bloques estilo Notion.
- **Infraestructura:** Instancia VM.Standard.A1.Flex en OCI (ARM64, 4 vCPUs, 24 GB RAM). Todo debe estar orquestado con Docker y `docker-compose`.

**Arquitectura de Datos y Flujo de Trabajo (Job Queue Pattern):**
1. El celular graba la clase (audios de hasta 90 mins) y envía el archivo al backend Node.js mediante `multer`.
2. El backend guarda el archivo, crea un registro en Prisma con el estado `PENDING`, inserta un trabajo en BullMQ y responde un status 200 al frontend instantáneamente para liberar la app móvil.
3. Un Worker de BullMQ toma el trabajo y hace un POST interno por HTTP al microservicio de FastAPI.
4. El contenedor de FastAPI ejecuta Faster-Whisper (usando `compute_type="int8"` optimizado para CPU ARM), procesa la transcripción y devuelve el texto crudo.
5. El Worker recibe el texto y llama a la API del LLM pasándole la transcripción, pidiendo que estructure los apuntes, resalte ideas clave y genere tareas en un formato JSON compatible con BlockNote/Tiptap.
6. El Worker actualiza el registro en Prisma al estado `COMPLETED` guardando el JSON estructurado.

**Entregables que necesito de ti en esta sesión:**
1. **El esquema de Prisma (`schema.prisma`):** Diseña los modelos para manejar Usuarios, Documentos/Notas, los Bloques de texto (JSON) y el control de estado de los audios (PENDING, PROCESSING, COMPLETED, FAILED).
2. **El `docker-compose.yml`:** Configura los servicios necesarios (Node.js, Postgres, Redis, Microservicio Python). Ten en cuenta que la imagen de Python debe construirse localmente y no debe exponer puertos al exterior, solo a la red interna de Docker.
3. **El Boilerplate del Worker de BullMQ en Node.js:** Un ejemplo funcional en TypeScript de cómo el worker debe consumir la cola, llamar a FastAPI (con un timeout largo de 30 mins) y manejar los errores.
4. **El Microservicio en Python:** El código del `main.py` de FastAPI y su `Dockerfile` instalando `ffmpeg` y `faster-whisper`.

Por favor, entrégame el código bien documentado, aplicando buenas prácticas y asegurándote de que la solución sea compatible con arquitecturas ARM (aarch64) debido a los servidores de Oracle.