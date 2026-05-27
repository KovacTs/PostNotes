import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import prisma from './db';
import { audioQueue, redisConnection, QUEUE_NAME } from './queue';
import { QueueEvents } from 'bullmq';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Keep track of active SSE connections per note ID
const sseClients = new Map<string, express.Response[]>();

const queueEvents = new QueueEvents(QUEUE_NAME, { connection: redisConnection });

async function broadcastJobUpdate(audioJobId: string, status: string, error?: string, progress?: any) {
  try {
    const audioJob = await prisma.audioJob.findUnique({
      where: { id: audioJobId },
      select: { noteId: true }
    });
    if (!audioJob) return;

    const clients = sseClients.get(audioJob.noteId);
    if (clients && clients.length > 0) {
      const payload = JSON.stringify({
        audioJobId,
        status,
        error,
        progress,
        timestamp: new Date().toISOString()
      });
      console.log(`[SSE] Broadcasting status '${status}' to ${clients.length} clients for note ${audioJob.noteId}`);
      clients.forEach(res => {
        res.write(`data: ${payload}\n\n`);
      });
    }
  } catch (err) {
    console.error(`[SSE] Error broadcasting update for job ${audioJobId}:`, err);
  }
}

// Bind QueueEvents to SSE broadcast
queueEvents.on('active', ({ jobId }) => {
  broadcastJobUpdate(jobId, 'PROCESSING');
});

queueEvents.on('completed', ({ jobId }) => {
  broadcastJobUpdate(jobId, 'COMPLETED');
});

queueEvents.on('failed', ({ jobId, failedReason }) => {
  broadcastJobUpdate(jobId, 'FAILED', failedReason);
});

queueEvents.on('progress', ({ jobId, data }) => {
  broadcastJobUpdate(jobId, 'PROCESSING', undefined, data);
});

// Set up the audio files storage location
// In production inside docker, this will map to the /app/shared_audio volume
const uploadDir = process.env.UPLOAD_DIR || '/app/shared_audio';

// Ensure the upload directory exists
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Multer Storage configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname);
    cb(null, `audio-${uniqueSuffix}${ext}`);
  }
});

// Allow large uploads since audios up to 90 min can be very large
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 500 * 1024 * 1024, // 500 MB limit
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// 1. Helper: Create a user (for bootstrapping and testing)
app.post('/api/users', async (req, res) => {
  const { email, name } = req.body;
  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }
  try {
    const user = await prisma.user.create({
      data: { email, name }
    });
    res.status(201).json(user);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// 2. CRUD: Get all Notes (Desktop Client)
app.get('/api/notes', async (req, res) => {
  try {
    const notes = await prisma.note.findMany({
      orderBy: { updatedAt: 'desc' },
      include: {
        audioJobs: {
          orderBy: { createdAt: 'desc' },
          take: 1
        }
      }
    });
    res.json(notes);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Create a Note (Robust Desktop + Mobile routing with automatic user bootstrapping)
app.post('/api/notes', async (req, res) => {
  const { title, content } = req.body;
  let { userId } = req.body;
  
  try {
    if (!userId) {
      // Find the first user or seed a default desktop user so client never crashes
      let defaultUser = await prisma.user.findFirst();
      if (!defaultUser) {
        defaultUser = await prisma.user.create({
          data: {
            email: 'desktop@postnotes.local',
            name: 'Usuario Desktop'
          }
        });
      }
      userId = defaultUser.id;
    }

    const note = await prisma.note.create({
      data: {
        title: title || 'Nueva Nota sin título',
        userId,
        content: content || []
      },
      include: {
        audioJobs: {
          orderBy: { createdAt: 'desc' },
          take: 1
        }
      }
    });
    res.status(201).json(note);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Update a Note's Title and/or Editor Blocks
app.put('/api/notes/:id', async (req, res) => {
  const { id } = req.params;
  const { title, content } = req.body;
  try {
    const note = await prisma.note.update({
      where: { id },
      data: {
        title,
        content
      },
      include: {
        audioJobs: {
          orderBy: { createdAt: 'desc' },
          take: 1
        }
      }
    });
    res.json(note);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Delete a Note and its associated AudioJobs
app.delete('/api/notes/:id', async (req, res) => {
  const { id } = req.params;
  try {
    // Delete any associated audio jobs first due to foreign key constraints
    await prisma.audioJob.deleteMany({
      where: { noteId: id }
    });
    
    const note = await prisma.note.delete({
      where: { id }
    });
    res.json({ message: 'Note deleted successfully', note });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get a single Note with its associated Audio Jobs
app.get('/api/notes/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const note = await prisma.note.findUnique({
      where: { id },
      include: {
        audioJobs: {
          orderBy: { createdAt: 'desc' }
        }
      }
    });
    if (!note) {
      return res.status(404).json({ error: 'Note not found' });
    }
    res.json(note);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Get all Notes for a User
app.get('/api/users/:userId/notes', async (req, res) => {
  const { userId } = req.params;
  try {
    const notes = await prisma.note.findMany({
      where: { userId },
      orderBy: { updatedAt: 'desc' }
    });
    res.json(notes);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// 3. Audio upload and job queuing endpoint
// Multer key must be 'audio'
app.post('/api/notes/:noteId/audio', upload.single('audio'), async (req, res) => {
  const { noteId } = req.params;
  const modelSize = req.query.modelSize as string || 'base';
  const language = req.query.language as string || process.env.DEFAULT_LANGUAGE || undefined;
  const provider = req.query.provider as string || 'local'; // 'local' | 'openai' | 'groq'

  if (!req.file) {
    return res.status(400).json({ error: 'No audio file uploaded.' });
  }

  try {
    // Check if the associated note exists
    const noteExists = await prisma.note.findUnique({
      where: { id: noteId }
    });

    if (!noteExists) {
      // Clean up uploaded file if note doesn't exist
      fs.unlinkSync(req.file.path);
      return res.status(404).json({ error: 'Note not found. Audio rejected.' });
    }

    const filePath = req.file.path;
    console.log(`[API] Audio file successfully uploaded to ${filePath}`);

    // Create an AudioJob record in PostgreSQL with PENDING status
    const audioJob = await prisma.audioJob.create({
      data: {
        noteId: noteId,
        status: 'PENDING',
        filePath: filePath,
      }
    });

    // Enqueue the job in BullMQ to be processed asynchronously by the Worker
    const job = await audioQueue.add('transcribe-audio-job', {
      audioJobId: audioJob.id,
      filePath: filePath,
      modelSize: modelSize,
      language: language,
      provider: provider
    }, {
      jobId: audioJob.id
    });

    console.log(`[API] Job successfully enqueued in BullMQ. Queue Job ID: ${job.id}`);

    // Respond instantly 200/201 to the mobile application, freeing the frontend thread
    res.status(202).json({
      message: 'Audio uploaded successfully. Transcription job queued.',
      jobId: job.id,
      audioJob: {
        id: audioJob.id,
        noteId: audioJob.noteId,
        status: audioJob.status,
        createdAt: audioJob.createdAt
      }
    });

  } catch (error: any) {
    console.error('[API] Error handling audio upload:', error);
    // Cleanup file in case of error
    if (req.file && fs.existsSync(req.file.path)) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (cleanupErr) {
        console.error('[API] Failed to clean up file:', cleanupErr);
      }
    }
    res.status(500).json({ error: error.message });
  }
});

// 4. Endpoint to check status of an AudioJob
app.get('/api/jobs/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const job = await prisma.audioJob.findUnique({
      where: { id },
      select: {
        id: true,
        noteId: true,
        status: true,
        transcription: true,
        errorMessage: true,
        createdAt: true,
        updatedAt: true
      }
    });

    if (!job) {
      return res.status(404).json({ error: 'AudioJob not found.' });
    }

    res.json(job);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// 5. SSE endpoint for real-time progress of a specific note's audio jobs
app.get('/api/notes/:noteId/progress', (req, res) => {
  const { noteId } = req.params;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });

  // Confirm connection
  res.write(`data: ${JSON.stringify({ connected: true, noteId })}\n\n`);

  if (!sseClients.has(noteId)) {
    sseClients.set(noteId, []);
  }
  sseClients.get(noteId)!.push(res);

  console.log(`[SSE] Client connected to note ${noteId}. Total clients: ${sseClients.get(noteId)!.length}`);

  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 30000);

  req.on('close', () => {
    clearInterval(heartbeat);
    const clients = sseClients.get(noteId);
    if (clients) {
      const index = clients.indexOf(res);
      if (index !== -1) {
        clients.splice(index, 1);
      }
      if (clients.length === 0) {
        sseClients.delete(noteId);
      }
    }
    console.log(`[SSE] Client disconnected from note ${noteId}`);
  });
});

app.listen(PORT, () => {
  console.log(`[API] Express Server is running on port ${PORT}`);
  console.log(`[API] Shared audio files directory is set to: ${uploadDir}`);
});
