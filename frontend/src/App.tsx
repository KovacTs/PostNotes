import React, { useState, useEffect, useRef } from "react"
import axios from "axios"
import { 
  FileText, 
  Plus, 
  Search, 
  RefreshCw, 
  CheckCircle2, 
  XCircle, 
  Clock, 
  CloudOff, 
  Trash2, 
  BookOpen
} from "lucide-react"
import Editor from "./components/Editor"
import AudioRecorder from "./components/AudioRecorder"
import { Button } from "./components/ui/button"
import { Input } from "./components/ui/input"

interface Note {
  id: string
  title: string
  content: any
  createdAt: string
  updatedAt: string
  audioJobs?: AudioJob[]
}

interface AudioJob {
  id: string
  status: "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED"
  errorMessage?: string
}

export default function App() {
  // Connection states
  const [backendConnected, setBackendConnected] = useState<boolean | null>(null)

  // Note Navigation states
  const [notes, setNotes] = useState<Note[]>([])
  const [search, setSearch] = useState("")
  const [selectedNote, setSelectedNote] = useState<Note | null>(null)

  // Status Indicators
  const [savingStatus, setSavingStatus] = useState<"idle" | "saving" | "saved" | "error">("idle")
  const [recorderDisabled, setRecorderDisabled] = useState(false)

  // SSE Transcription stream progress state
  const [sseState, setSseState] = useState<{
    status: "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED" | null
    errorMessage?: string
  }>({ status: null })

  const eventSourceRef = useRef<EventSource | null>(null)
  const saveTimerRef = useRef<any>(null)

  // 1. Connection check and initial fetch on startup
  useEffect(() => {
    checkConnection()
    return () => {
      if (eventSourceRef.current) eventSourceRef.current.close()
    }
  }, [])

  const checkConnection = async (): Promise<void> => {
    setBackendConnected(null)
    try {
      const res = await axios.get<Note[]>("/api/notes")
      setNotes(res.data)
      setBackendConnected(true)
    } catch (err) {
      console.error("Backend connection failed:", err)
      setBackendConnected(false)
    }
  }

  const fetchNotes = async (selectIdAfterFetch?: string): Promise<void> => {
    try {
      const res = await axios.get<Note[]>("/api/notes")
      setNotes(res.data)
      
      if (selectIdAfterFetch) {
        const found = res.data.find(n => n.id === selectIdAfterFetch)
        if (found) setSelectedNote(found)
      }
    } catch (err) {
      console.error("Error fetching notes:", err)
    }
  }

  // 2. Fetch specific note details (refresh contents)
  const refreshActiveNote = async (noteId: string): Promise<void> => {
    try {
      const res = await axios.get<Note>(`/api/notes/${noteId}`)
      setSelectedNote(res.data)
      
      // Update this note in the main list too
      setNotes(prev => prev.map(n => n.id === noteId ? res.data : n))
    } catch (err) {
      console.error("Error refreshing active note:", err)
    }
  }

  // 3. Connect to Server-Sent Events (SSE) for Real-Time progress
  useEffect(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close()
      eventSourceRef.current = null
    }

    if (!selectedNote) {
      setSseState({ status: null })
      return
    }

    // Determine initial state from recent audioJob
    const recentJob = selectedNote.audioJobs?.[0]
    if (recentJob) {
      setSseState({
        status: recentJob.status,
        errorMessage: recentJob.errorMessage
      })
      
      // If pending or processing, open SSE connection
      if (recentJob.status === "PENDING" || recentJob.status === "PROCESSING") {
        connectToSSE(selectedNote.id)
      }
    } else {
      setSseState({ status: null })
    }
  }, [selectedNote?.id])

  const connectToSSE = (noteId: string): void => {
    if (eventSourceRef.current) eventSourceRef.current.close()

    console.log(`[SSE] Connecting to progress channel for Note ${noteId}...`)
    const es = new EventSource(`/api/notes/${noteId}/progress`)
    eventSourceRef.current = es

    const handleMessage = (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data)
        
        // Skip connection handshake message
        if (data.connected) return

        console.log("[SSE] Status updated:", data)
        setSseState({
          status: data.status,
          errorMessage: data.error
        })

        // Update sidebar notes state dynamically
        setNotes(prev => prev.map(n => {
          if (n.id === noteId) {
            return {
              ...n,
              audioJobs: [{ id: data.audioJobId || data.jobId, status: data.status, errorMessage: data.error }]
            }
          }
          return n
        }))

        // If finished, reload the note's new structured block content and close SSE
        if (data.status === "COMPLETED") {
          refreshActiveNote(noteId)
          es.close()
        } else if (data.status === "FAILED") {
          es.close()
        }
      } catch (err) {
        console.warn("[SSE] Parse error or non-json event:", err)
      }
    }

    es.onmessage = handleMessage
    es.addEventListener("message", handleMessage)
    es.addEventListener("status", handleMessage)

    es.onerror = (err) => {
      console.warn("[SSE] Connection lost, closing.", err)
      es.close()
    }
  }

  // 4. Create New Note
  const handleCreateNote = async (): Promise<void> => {
    try {
      const res = await axios.post<Note>("/api/notes", {
        title: "Nueva Nota sin título",
        content: []
      })
      // Prepend to notes list
      setNotes(prev => [res.data, ...prev])
      setSelectedNote(res.data)
    } catch (err) {
      console.error("Error creating note:", err)
    }
  }

  // 4b. Delete Note
  const handleDeleteNote = async (noteId: string): Promise<void> => {
    const confirmDelete = window.confirm("¿Estás seguro de que deseas eliminar este apunte de forma permanente?")
    if (!confirmDelete) return

    try {
      await axios.delete(`/api/notes/${noteId}`)
      
      // Remove from list
      setNotes(prev => prev.filter(n => n.id !== noteId))
      
      // If deleted note was selected, deselect it
      if (selectedNote?.id === noteId) {
        setSelectedNote(null)
      }
    } catch (err) {
      console.error("Error deleting note:", err)
      alert("No se pudo eliminar el apunte")
    }
  }

  // 5. Debounced Auto-save
  const handleTitleChange = (newTitle: string): void => {
    if (!selectedNote) return
    const updated = { ...selectedNote, title: newTitle }
    setSelectedNote(updated)
    triggerAutoSave(newTitle, updated.content)
  }

  const handleContentChange = (newContent: any): void => {
    if (!selectedNote) return
    const updated = { ...selectedNote, content: newContent }
    setSelectedNote(updated)
    triggerAutoSave(updated.title, newContent)
  }

  const triggerAutoSave = (title: string, content: any): void => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    setSavingStatus("saving")

    saveTimerRef.current = setTimeout(async () => {
      if (!selectedNote) return
      try {
        await axios.put(`/api/notes/${selectedNote.id}`, {
          title,
          content
        })
        setSavingStatus("saved")
        
        // Update title and timestamp in sidebar
        setNotes(prev => prev.map(n => n.id === selectedNote.id ? { ...n, title, content, updatedAt: new Date().toISOString() } : n))
      } catch (err) {
        console.error("Auto-save failed:", err)
        setSavingStatus("error")
      }
    }, 1000) // 1 second debounce
  }

  // Filter notes by search query
  const filteredNotes = notes.filter(n => 
    n.title.toLowerCase().includes(search.toLowerCase())
  )

  return (
    <div className="flex h-screen w-screen bg-background overflow-hidden font-sans">
      
      {/* 1. SIDEBAR PANEL */}
      <aside className="w-80 flex flex-col border-r border-border/40 bg-card/10 backdrop-blur-md z-20 shrink-0">
        
        {/* Brand and controls */}
        <div className="p-5 flex flex-col gap-4 border-b border-border/40">
          <div className="flex items-center gap-2.5">
            <div className="h-8 w-8 rounded-lg bg-gradient-to-tr from-purple-500 to-indigo-500 flex items-center justify-center shadow-lg shadow-purple-500/20 text-white font-bold text-sm">
              ✨
            </div>
            <div>
              <h1 className="font-semibold tracking-wide text-glow text-white font-sans text-base">PostNotes</h1>
              <p className="text-[10px] text-muted-foreground uppercase tracking-widest font-medium">Asistente de Audio</p>
            </div>
          </div>
          
          <Button 
            className="w-full gap-2 bg-primary hover:bg-primary/95 text-white shadow-md font-semibold duration-150 active:scale-95" 
            onClick={handleCreateNote}
          >
            <Plus className="h-4 w-4" />
            Nueva Nota
          </Button>

          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 opacity-50" />
            <Input 
              type="text" 
              placeholder="Buscar notas..." 
              className="pl-8 bg-background/30 border-border/60 placeholder:opacity-50"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>

        {/* Note Cards List */}
        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-2">
          {filteredNotes.length > 0 ? (
            filteredNotes.map((note) => {
              const recentJob = note.audioJobs?.[0]
              const isActive = selectedNote?.id === note.id
              return (
                <div 
                  key={note.id}
                  className={`group relative rounded-xl border p-4 cursor-pointer transition-all duration-200 select-none ${
                    isActive 
                      ? "bg-primary/10 border-primary/40 shadow-md shadow-primary/5" 
                      : "border-border/40 bg-card/20 hover:bg-card/45 hover:border-border/80"
                  }`}
                  onClick={() => setSelectedNote(note)}
                >
                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-start justify-between gap-2">
                      <span className={`text-sm font-semibold truncate leading-tight transition-colors duration-150 ${isActive ? "text-primary-foreground" : "group-hover:text-white"}`}>
                        {note.title}
                      </span>
                      {recentJob && recentJob.status !== "COMPLETED" && (
                        <span className={`text-[9px] font-bold px-2 py-0.5 rounded-full tracking-wide uppercase shrink-0 ${
                          recentJob.status === "PENDING" 
                            ? "bg-amber-500/10 text-amber-500 border border-amber-500/20 record-pulse" 
                            : recentJob.status === "PROCESSING"
                            ? "bg-indigo-500/10 text-indigo-500 border border-indigo-500/20"
                            : "bg-red-500/10 text-red-500 border border-red-500/20"
                        }`}>
                          {recentJob.status === "PROCESSING" ? "Transcribiendo" : recentJob.status === "PENDING" ? "En Cola" : "Fallido"}
                        </span>
                      )}
                    </div>
                    
                    <span className="text-[11px] text-muted-foreground/80 font-medium">
                      {new Date(note.updatedAt).toLocaleDateString("es-ES", {
                        day: "2-digit",
                        month: "short",
                        hour: "2-digit",
                        minute: "2-digit"
                      })}
                    </span>
                  </div>
                </div>
              )
            })
          ) : (
            <div className="flex flex-col items-center justify-center p-8 text-center text-muted-foreground/50 gap-2 h-40">
              <FileText className="h-8 w-8 opacity-30" />
              <span className="text-xs">No se encontraron notas</span>
            </div>
          )}
        </div>
      </aside>

      {/* 2. MAIN PANEL */}
      <main className="flex-1 flex flex-col bg-background overflow-hidden relative">
        {selectedNote ? (
          <div className="flex-1 flex flex-col overflow-hidden">
            
            {/* Header toolbar */}
            <div className="px-6 py-4 border-b border-border/40 flex flex-col gap-3 shrink-0 bg-card/5 backdrop-blur-md">
              <div className="flex items-center justify-between gap-4">
                <input 
                  type="text" 
                  className="bg-transparent border-0 text-xl font-bold tracking-tight text-white focus:outline-none focus:ring-0 flex-1 truncate min-w-0"
                  value={selectedNote.title}
                  onChange={(e) => handleTitleChange(e.target.value)}
                />
                
                <div className="flex items-center gap-3 shrink-0">
                  {/* Save feedback indicator */}
                  <div className="text-xs font-semibold flex items-center gap-1.5">
                    {savingStatus === "saving" && (
                      <span className="text-muted-foreground flex items-center gap-1">
                        <RefreshCw className="h-3 w-3 animate-spin text-primary" /> Guardando...
                      </span>
                    )}
                    {savingStatus === "saved" && (
                      <span className="text-emerald-500 flex items-center gap-1">
                        <CheckCircle2 className="h-3.5 w-3.5" /> Guardado
                      </span>
                    )}
                    {savingStatus === "error" && (
                      <span className="text-destructive flex items-center gap-1">
                        <XCircle className="h-3.5 w-3.5" /> Error al guardar
                      </span>
                    )}
                  </div>

                  {/* Delete Button */}
                  <Button 
                    variant="outline" 
                    size="sm" 
                    className="gap-1.5 border-red-500/20 bg-red-500/5 text-red-500 hover:bg-destructive hover:text-white"
                    onClick={() => handleDeleteNote(selectedNote.id)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    <span className="hidden sm:inline">Eliminar</span>
                  </Button>
                </div>
              </div>
            </div>

            {/* SSE dynamic loading status banner */}
            {sseState.status && sseState.status !== "COMPLETED" && (
              <div className={`px-6 py-3 shrink-0 border-b flex items-center justify-between text-xs font-semibold select-none ${
                sseState.status === "PENDING" 
                  ? "bg-amber-500/5 text-amber-500 border-amber-500/10" 
                  : sseState.status === "PROCESSING"
                  ? "bg-indigo-500/5 text-indigo-400 border-indigo-500/10"
                  : "bg-red-500/5 text-red-500 border-red-500/10"
              }`}>
                <div className="flex items-center gap-2">
                  {sseState.status === "PENDING" && (
                    <>
                      <Clock className="h-4 w-4 record-pulse shrink-0" />
                      <span>Audio cargado con éxito. En cola esperando procesamiento de IA...</span>
                    </>
                  )}
                  {sseState.status === "PROCESSING" && (
                    <>
                      <RefreshCw className="h-4 w-4 animate-spin shrink-0 text-indigo-400" />
                      <span>El motor está transcribiendo el dictado y estructurando apuntes con IA en vivo...</span>
                    </>
                  )}
                  {sseState.status === "FAILED" && (
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center gap-2">
                        <XCircle className="h-4 w-4 shrink-0 text-red-500" />
                        <span>Fallo en la transcripción de la grabación</span>
                      </div>
                      {sseState.errorMessage && (
                        <span className="text-[10px] opacity-70 font-mono pl-6 block max-w-xl truncate">{sseState.errorMessage}</span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Workspace Area: Scrollable panel containing Recording Console and Notes Canvas */}
            <div className="flex-1 overflow-y-auto p-6 flex flex-col gap-6">
              
              {/* Voice recording dashboard */}
              <AudioRecorder 
                noteId={selectedNote.id}
                disabled={recorderDisabled || sseState.status === "PENDING" || sseState.status === "PROCESSING"}
                onUploadStart={() => {
                  setRecorderDisabled(true)
                  setSseState({ status: "PENDING" })
                }}
                onUploadSuccess={(jobId) => {
                  setRecorderDisabled(false)
                  connectToSSE(selectedNote.id)
                  fetchNotes(selectedNote.id)
                }}
                onUploadError={(err) => {
                  setRecorderDisabled(false)
                  setSseState({ status: "FAILED", errorMessage: err })
                  alert(`Error: ${err}`)
                }}
              />

              {/* Block Editor container */}
              <div className="flex-1 rounded-xl border border-border/40 p-4 min-h-[400px] glass">
                <Editor 
                  key={selectedNote.id}
                  initialContent={selectedNote.content}
                  onChange={handleContentChange}
                />
              </div>
            </div>

          </div>
        ) : (
          /* Welcome Screen */
          <div className="flex-1 flex flex-col items-center justify-center p-8 bg-background relative overflow-hidden">
            {/* Ambient Background Glows */}
            <div className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 h-[350px] w-[350px] rounded-full bg-purple-500/10 blur-[80px] pointer-events-none" />
            <div className="absolute bottom-1/4 left-1/3 h-[250px] w-[250px] rounded-full bg-blue-500/5 blur-[80px] pointer-events-none" />

            <div className="max-w-md w-full text-center flex flex-col items-center gap-6 relative z-10 p-8 rounded-2xl border border-border/30 glass border-glow">
              <div className="h-16 w-16 rounded-2xl bg-gradient-to-tr from-purple-500 to-indigo-500 flex items-center justify-center shadow-xl shadow-purple-500/20 text-white">
                <BookOpen className="h-8 w-8" />
              </div>
              
              <div className="flex flex-col gap-2">
                <h2 className="text-xl font-bold tracking-tight text-white font-sans">Bienvenido a PostNotes Web</h2>
                <p className="text-sm text-muted-foreground/80 leading-relaxed font-medium">
                  Graba tus clases o conferencias, transcríbelas de forma local y offline, y estructúralas en apuntes interactivos estilo Notion gracias a Inteligencia Artificial.
                </p>
              </div>

              <Button 
                onClick={handleCreateNote} 
                className="gap-2 font-semibold shadow-md bg-primary hover:bg-primary/95 text-white active:scale-95 duration-100"
              >
                <Plus className="h-4 w-4" />
                Comenzar Apunte
              </Button>

              {/* Stats overview */}
              <div className="w-full grid grid-cols-2 gap-4 border-t border-border/40 pt-6 mt-2 text-left">
                <div className="bg-background/40 p-3 rounded-lg border border-border/30">
                  <div className="text-2xl font-bold text-white text-glow">{notes.length}</div>
                  <div className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground/80">Notas Creadas</div>
                </div>
                <div className="bg-background/40 p-3 rounded-lg border border-border/30">
                  <div className="text-lg font-bold text-white leading-8">Whisper</div>
                  <div className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground/80">Tecnología IA</div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Loading overlay */}
        {backendConnected === null && (
          <div className="absolute inset-0 bg-background/95 backdrop-blur-sm z-50 flex items-center justify-center">
            <div className="flex flex-col items-center justify-center gap-4 text-center">
              <RefreshCw className="h-10 w-10 animate-spin text-primary" />
              <div>
                <h3 className="font-semibold text-white tracking-wide">Conectando con PostNotes...</h3>
                <p className="text-xs text-muted-foreground mt-1">Estableciendo enlace seguro con la API local.</p>
              </div>
            </div>
          </div>
        )}

        {/* Connection Failure screen overlay */}
        {backendConnected === false && (
          <div className="absolute inset-0 bg-background z-50 flex items-center justify-center p-6">
            <div className="max-w-md w-full p-8 rounded-2xl border border-red-500/20 glass border-glow flex flex-col items-center text-center gap-6 shadow-2xl shadow-red-500/5">
              <div className="h-14 w-14 rounded-full bg-red-500/10 flex items-center justify-center text-red-500 border border-red-500/20">
                <CloudOff className="h-7 w-7" />
              </div>

              <div className="flex flex-col gap-2">
                <h2 className="text-lg font-bold text-white">Servidor de PostNotes Desconectado</h2>
                <p className="text-sm text-muted-foreground/80 leading-relaxed font-medium">
                  No pudimos establecer enlace con la API en <code>http://localhost:3000</code>. Asegúrate de iniciar tu contenedor Docker.
                </p>
              </div>

              <div className="w-full bg-background/50 border border-border/40 p-4 rounded-xl text-left text-xs font-mono text-muted-foreground select-text">
                <span className="text-primary font-semibold"># Levanta los contenedores en tu terminal:</span>
                <br />
                docker compose up -d
              </div>

              <Button 
                onClick={checkConnection}
                className="gap-2 font-semibold bg-primary hover:bg-primary/95 text-white active:scale-95 duration-100"
              >
                <RefreshCw className="h-4 w-4" />
                Reintentar Conexión
              </Button>
            </div>
          </div>
        )}
      </main>

    </div>
  )
}
