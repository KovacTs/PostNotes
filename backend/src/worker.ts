import { Worker, Job } from 'bullmq';
import axios from 'axios';
import OpenAI from 'openai';
import dotenv from 'dotenv';
import prisma from './db';
import { redisConnection, QUEUE_NAME } from './queue';
import { exec } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

dotenv.config();

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || 'dummy-key',
});

// Initialize Groq client using OpenAI SDK compatibility
const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY || 'dummy-key',
  baseURL: 'https://api.groq.com/openai/v1',
});

const TRANSCRIBER_URL = process.env.TRANSCRIBER_URL || 'http://transcriber:8000';

interface TranscriptionJobData {
  audioJobId: string;
  filePath: string;
  modelSize?: string;
  language?: string;
  provider?: string;
}

function getFileSizeInMB(filePath: string): number {
  try {
    const stats = fs.statSync(filePath);
    return stats.size / (1024 * 1024);
  } catch (err) {
    return 0;
  }
}

function compressAudio(inputPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const fileDir = path.dirname(inputPath);
    const fileExt = path.extname(inputPath);
    const fileBase = path.basename(inputPath, fileExt);
    const outputPath = path.join(fileDir, `${fileBase}-compressed.mp3`);

    console.log(`[Worker] Compressing audio ${inputPath} to ${outputPath} using ffmpeg...`);
    
    // Convert to mono 32k mp3 - ideal for speech transcription legibility and ultra-lightweight
    const cmd = `ffmpeg -y -i "${inputPath}" -codec:a libmp3lame -b:a 32k -ac 1 "${outputPath}"`;
    
    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        console.error(`[Worker] ffmpeg compression error:`, error);
        return reject(new Error(`Failed to compress audio with ffmpeg: ${error.message}`));
      }
      console.log(`[Worker] Compression complete. Original size: ${getFileSizeInMB(inputPath).toFixed(2)} MB, New size: ${getFileSizeInMB(outputPath).toFixed(2)} MB`);
      resolve(outputPath);
    });
  });
}

/**
 * Calls the OpenAI API (or custom LLM endpoint) to convert raw transcription
 * into a BlockNote.js/Tiptap compatible JSON block structure.
 */
async function generateStructuredNotes(title: string, transcription: string): Promise<any> {
  if (!process.env.OPENAI_API_KEY) {
    console.warn("WARNING: OPENAI_API_KEY is not defined. Returning a fallback simple block structure.");
    return [
      {
        id: "fallback-heading",
        type: "heading",
        props: { level: 1 },
        content: [{ type: "text", text: `Notas: ${title}`, styles: {} }]
      },
      {
        id: "fallback-para",
        type: "paragraph",
        content: [{ type: "text", text: transcription, styles: {} }]
      }
    ];
  }

  const systemPrompt = `Eres un asistente de estudio de nivel Senior. Tu tarea es estructurar una transcripción de clase o reunión en apuntes limpios, profesionales y organizados utilizando un formato de bloque JSON específico y compatible con el editor BlockNote.js (Tiptap).

El formato del JSON de salida DEBE ser un objeto que contenga un arreglo de bloques bajo la clave "blocks". Cada bloque debe seguir estrictamente este esquema:
{
  "id": "un-string-unico-id-uuid-o-similar",
  "type": "heading" | "paragraph" | "bulletListItem" | "numberedListItem" | "checkListItem",
  "props": {
    "textColor": "default",
    "backgroundColor": "default",
    "textAlignment": "left",
    "level": 1 | 2 | 3 (solo si type es "heading")
  },
  "content": [
    {
      "type": "text",
      "text": "El contenido del texto",
      "styles": {
        "bold": true, // opcional
        "italic": true, // opcional
        "underline": true // opcional
      }
    }
  ]
}

Reglas para la nota:
1. Comienza con un encabezado Nivel 1 ("type": "heading", "level": 1) con el tema general.
2. Agrega una introducción o resumen corto en un párrafo ("type": "paragraph").
3. Divide las ideas clave en secciones usando encabezados Nivel 2 o 3.
4. Utiliza listas con viñetas ("bulletListItem") para puntos importantes, listas numeradas ("numberedListItem") para secuencias, y listas de tareas ("checkListItem") para pendientes o compromisos importantes extraídos de la clase.
5. El tono debe ser académico, claro y bien estructurado. Evita rodeos e incluye fórmulas, conceptos clave o explicaciones concisas.

Responde ÚNICAMENTE con un JSON válido que tenga la estructura: { "blocks": [...] }. No agregues explicaciones externas ni markdown fuera del JSON.`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini", // Highly cost-effective and perfectly suited for structured output
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Título del Apunte: "${title}"\n\nTranscripción de la clase:\n${transcription}` }
      ],
      response_format: { type: "json_object" },
      temperature: 0.3
    });

    const resultText = response.choices[0].message.content;
    if (!resultText) {
      throw new Error("Empty response received from OpenAI.");
    }

    const parsedJson = JSON.parse(resultText);
    return parsedJson.blocks || parsedJson;
  } catch (error) {
    console.error("Error generating structured notes via LLM. Falling back to raw transcription layout:", error);
    return [
      {
        id: "error-warning-heading",
        type: "heading",
        props: { level: 2, textColor: "red" },
        content: [{ type: "text", text: "⚠️ Estructuración IA Fallida (Transcripción Guardada)", styles: { bold: true } }]
      },
      {
        id: "error-warning-para",
        type: "paragraph",
        content: [{ type: "text", text: `Nota: Los apuntes no pudieron ser formateados con inteligencia artificial debido al siguiente problema: ${(error as Error).message}. Se muestra la transcripción directa del audio a continuación.`, styles: { italic: true } }]
      },
      {
        id: "fallback-heading",
        type: "heading",
        props: { level: 1 },
        content: [{ type: "text", text: `Notas de: ${title}`, styles: {} }]
      },
      {
        id: "fallback-para",
        type: "paragraph",
        content: [{ type: "text", text: transcription, styles: {} }]
      }
    ];
  }
}

// Instantiate the BullMQ Worker
const worker = new Worker(
  QUEUE_NAME,
  async (job: Job<TranscriptionJobData>) => {
    const { audioJobId, filePath, modelSize = 'base', language, provider } = job.data;
    console.log(`[Worker] Started processing Job ${job.id} for AudioJob ${audioJobId}`);

    // 1. Fetch the Job and Note details from PostgreSQL
    const audioJob = await prisma.audioJob.findUnique({
      where: { id: audioJobId },
      include: { note: true }
    });

    if (!audioJob) {
      throw new Error(`AudioJob with ID ${audioJobId} not found in database.`);
    }

    // 2. Update DB status to PROCESSING
    await prisma.audioJob.update({
      where: { id: audioJobId },
      data: { status: 'PROCESSING' }
    });

    let actualFilePath = filePath;
    let tempCompressedPath: string | null = null;

    try {
      let rawText = '';
      const providerName = provider || 'local';
      console.log(`[Worker] Using transcription provider: ${providerName}`);

      if (providerName === 'openai' || providerName === 'groq') {
        const fileSizeMB = getFileSizeInMB(filePath);
        console.log(`[Worker] Audio file size is ${fileSizeMB.toFixed(2)} MB`);

        // Remote APIs have a 25MB limit. If the file exceeds 24MB, or to save upload bandwidth,
        // we compress the audio automatically using ffmpeg.
        if (fileSizeMB > 24) {
          console.log(`[Worker] File size exceeds 24MB. Compressing audio first...`);
          tempCompressedPath = await compressAudio(filePath);
          actualFilePath = tempCompressedPath;
        }

        console.log(`[Worker] Sending audio to remote API (${providerName})...`);
        
        if (providerName === 'openai') {
          if (!process.env.OPENAI_API_KEY) {
            throw new Error("OPENAI_API_KEY is not defined. Remote transcription failed.");
          }
          const response = await openai.audio.transcriptions.create({
            file: fs.createReadStream(actualFilePath),
            model: 'whisper-1',
            language: language || undefined
          });
          rawText = response.text;
        } else { // groq
          if (!process.env.GROQ_API_KEY || process.env.GROQ_API_KEY === 'your_groq_api_key_here') {
            throw new Error("GROQ_API_KEY is not defined. Remote transcription failed.");
          }
          const response = await groq.audio.transcriptions.create({
            file: fs.createReadStream(actualFilePath),
            model: 'whisper-large-v3',
            language: language || undefined
          });
          rawText = response.text;
        }
      } else {
        // Local FastAPI whisper transcription
        console.log(`[Worker] Sending request to local transcriber at: ${TRANSCRIBER_URL}`);
        
        // We use /transcribe/path since both containers share the audio directory volume
        const whisperResponse = await axios.post(
          `${TRANSCRIBER_URL}/transcribe/path`,
          {
            file_path: filePath,
            model_size: modelSize,
            language: language || null
          },
          {
            // 30 minutes timeout as audio can be up to 90 mins long
            timeout: 30 * 60 * 1000, 
            headers: { 'Content-Type': 'application/json' }
          }
        );

        rawText = whisperResponse.data.text;
      }
      
      if (!rawText || rawText.trim() === "") {
        throw new Error("Transcriber returned empty text.");
      }

      console.log(`[Worker] Transcription complete. Length: ${rawText.length} characters.`);

      // 4. Request LLM processing to structure the notes into BlockNote.js JSON
      console.log(`[Worker] Generating structured Notion-style blocks using LLM...`);
      const blockContent = await generateStructuredNotes(audioJob.note.title, rawText);

      // 5. Save transcription & structured notes to the database, mark job as COMPLETED
      await prisma.$transaction([
        prisma.note.update({
          where: { id: audioJob.noteId },
          data: { content: blockContent }
        }),
        prisma.audioJob.update({
          where: { id: audioJobId },
          data: {
            status: 'COMPLETED',
            transcription: rawText,
          }
        })
      ]);

      console.log(`[Worker] Successfully completed job for AudioJob ${audioJobId}`);

    } catch (err: any) {
      console.error(`[Worker] Failed during transcription/LLM task:`, err);
      
      // Update AudioJob status to FAILED and record error trace
      await prisma.audioJob.update({
        where: { id: audioJobId },
        data: {
          status: 'FAILED',
          errorMessage: err.message || String(err)
        }
      });

      // We don't re-throw so the BullMQ task marks as finished/inspected rather than looping endlessly
    } finally {
      // Guaranteed cleanup of audio files to prevent storage leak
      if (process.env.DELETE_AUDIO_AFTER_COMPLETION === 'true') {
        try {
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            console.log(`[Worker] Cleaned up original audio file: ${filePath}`);
          }
        } catch (err) {
          console.warn(`[Worker] Failed to delete original audio file: ${err}`);
        }
      }
      
      // Always clean up the temporary compressed file if it was created
      if (tempCompressedPath) {
        try {
          if (fs.existsSync(tempCompressedPath)) {
            fs.unlinkSync(tempCompressedPath);
            console.log(`[Worker] Cleaned up temporary compressed audio file: ${tempCompressedPath}`);
          }
        } catch (err) {
          console.warn(`[Worker] Failed to delete temporary compressed audio file: ${err}`);
        }
      }
    }
  },
  {
    connection: redisConnection,
    concurrency: 1, // Only 1 Whisper transcription at a time to prevent CPU resource thrashing
  }
);

// General worker event listeners
worker.on('active', (job) => {
  console.log(`[Worker] Job ${job.id} is active`);
});

worker.on('completed', (job) => {
  console.log(`[Worker] Job ${job.id} completed successfully`);
});

worker.on('failed', (job, err) => {
  console.error(`[Worker] Job ${job?.id} failed with error: ${err.message}`);
});

console.log(`[Worker] BullMQ Worker is running, waiting for transcription jobs...`);
