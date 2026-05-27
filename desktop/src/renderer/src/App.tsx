import { useState, useEffect, useRef } from 'react'
import axios from 'axios'
import { 
  FileText, 
  Plus, 
  Search, 
  CloudLightning, 
  Sparkles, 
  RefreshCw, 
  CheckCircle2, 
  XCircle, 
  Clock, 
  Music, 
  Globe, 
  Settings,
  Cloud,
  CloudOff,
  Trash2
} from 'lucide-react'
import Editor from './components/Editor'

const API_BASE = 'http://127.0.0.1:3000/api'

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
  status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED'
  errorMessage?: string
}

function App(): React.JSX.Element {
  // Connection state with Backend API
  const [backendConnected, setBackendConnected] = useState<boolean | null>(null)

  // Notes lists & search
  const [notes, setNotes] = useState<Note[]>([])
  const [search, setSearch] = useState('')
  const [selectedNote, setSelectedNote] = useState<Note | null>(null)
  
  // Audio settings
  const [provider, setProvider] = useState('local')
  const [modelSize, setModelSize] = useState('base')
  const [language, setLanguage] = useState('es')
  
  // Local status
  const [uploading, setUploading] = useState(false)
  const [savingStatus, setSavingStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  
  // Realtime Audio Job State (SSE)
  const [sseState, setSseState] = useState<{
    status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | null
    errorMessage?: string
  }>({ status: null })

  const eventSourceRef = useRef<EventSource | null>(null)
  const saveTimerRef = useRef<NodeJS.Timeout | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  // 1. Fetch Notes & Check Connection on startup
  useEffect(() => {
    checkConnection()
    return () => {
      if (eventSourceRef.current) eventSourceRef.current.close()
    }
  }, [])

  const checkConnection = async (): Promise<void> => {
    setBackendConnected(null) // Loading state
    try {
      const res = await axios.get<Note[]>(`${API_BASE}/notes`)
      setNotes(res.data)
      setBackendConnected(true)
    } catch (err) {
      console.error('Backend connection failed:', err)
      setBackendConnected(false)
    }
  }

  const fetchNotes = async (selectIdAfterFetch?: string): Promise<void> => {
    try {
      const res = await axios.get<Note[]>(`${API_BASE}/notes`)
      setNotes(res.data)
      
      if (selectIdAfterFetch) {
        const found = res.data.find(n => n.id === selectIdAfterFetch)
        if (found) setSelectedNote(found)
      }
    } catch (err) {
      console.error('Error fetching notes:', err)
    }
  }

  // 2. Fetch specific note details (refresh contents)
  const refreshActiveNote = async (noteId: string): Promise<void> => {
    try {
      const res = await axios.get<Note>(`${API_BASE}/notes/${noteId}`)
      setSelectedNote(res.data)
      
      // Update this note in the main list too
      setNotes(prev => prev.map(n => n.id === noteId ? res.data : n))
    } catch (err) {
      console.error('Error refreshing active note:', err)
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
      if (recentJob.status === 'PENDING' || recentJob.status === 'PROCESSING') {
        connectToSSE(selectedNote.id)
      }
    } else {
      setSseState({ status: null })
    }
  }, [selectedNote?.id])

  const connectToSSE = (noteId: string): void => {
    if (eventSourceRef.current) eventSourceRef.current.close()

    console.log(`[SSE] Connecting to progress channel for Note ${noteId}...`)
    const es = new EventSource(`${API_BASE}/notes/${noteId}/progress`)
    eventSourceRef.current = es

    es.addEventListener('status', (e: MessageEvent) => {
      const data = JSON.parse(e.data)
      console.log('[SSE] Status updated:', data)
      setSseState({
        status: data.status,
        errorMessage: data.error
      })

      // Update sidebar notes state dynamically
      setNotes(prev => prev.map(n => {
        if (n.id === noteId) {
          return {
            ...n,
            audioJobs: [{ id: data.jobId, status: data.status, errorMessage: data.error }]
          }
        }
        return n
      }))

      // If finished, reload the note's new structured block content and close SSE
      if (data.status === 'COMPLETED') {
        refreshActiveNote(noteId)
        es.close()
      } else if (data.status === 'FAILED') {
        es.close()
      }
    })

    es.onerror = (err) => {
      console.warn('[SSE] Connection lost, closing.', err)
      es.close()
    }
  }

  // 4. Create New Note
  const handleCreateNote = async (): Promise<void> => {
    try {
      const res = await axios.post<Note>(`${API_BASE}/notes`, {
        title: 'Nueva Nota sin título',
        content: []
      })
      // Prepend to notes list
      setNotes(prev => [res.data, ...prev])
      setSelectedNote(res.data)
    } catch (err) {
      console.error('Error creating note:', err)
    }
  }

  // 4b. Delete Note
  const handleDeleteNote = async (noteId: string): Promise<void> => {
    const confirmDelete = window.confirm('¿Estás seguro de que deseas eliminar este apunte de forma permanente?')
    if (!confirmDelete) return

    try {
      await axios.delete(`${API_BASE}/notes/${noteId}`)
      
      // Remove from list
      setNotes(prev => prev.filter(n => n.id !== noteId))
      
      // If deleted note was selected, deselect it
      if (selectedNote?.id === noteId) {
        setSelectedNote(null)
      }
    } catch (err) {
      console.error('Error deleting note:', err)
      alert('No se pudo eliminar el apunte')
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
    setSavingStatus('saving')

    saveTimerRef.current = setTimeout(async () => {
      if (!selectedNote) return
      try {
        await axios.put(`${API_BASE}/notes/${selectedNote.id}`, {
          title,
          content
        })
        setSavingStatus('saved')
        
        // Update title and timestamp in sidebar
        setNotes(prev => prev.map(n => n.id === selectedNote.id ? { ...n, title, content } : n))
      } catch (err) {
        console.error('Auto-save failed:', err)
        setSavingStatus('error')
      }
    }, 1000) // 1 second debounce
  }

  // 6. Handle Audio Upload
  const triggerFileSelect = (): void => {
    fileInputRef.current?.click()
  }

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0]
    if (!file || !selectedNote) return

    setUploading(true)
    const formData = new FormData()
    formData.append('audio', file)

    try {
      const url = `${API_BASE}/notes/${selectedNote.id}/audio?provider=${provider}&modelSize=${modelSize}&language=${language}`
      console.log(`[Upload] Uploading audio via: ${url}`)
      
      const res = await axios.post(url, formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      })

      console.log('[Upload] Successful upload response:', res.data)
      
      // Update state to pending & connect to SSE stream
      setSseState({ status: 'PENDING' })
      connectToSSE(selectedNote.id)
      
      // Refresh list to show badge on sidebar
      fetchNotes(selectedNote.id)
    } catch (err) {
      console.error('Upload failed:', err)
      alert('Error al subir el archivo de audio.')
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  // Filter notes by search query
  const filteredNotes = notes.filter(n => 
    n.title.toLowerCase().includes(search.toLowerCase())
  )

  return (
    <div className="app-container">
      {/* 1. SIDEBAR PANEL */}
      <aside className="sidebar">
        <div className="sidebar-header">
          <div className="brand">
            <div className="logo-icon">✨</div>
            <h1>PostNotes</h1>
          </div>
          <button className="new-note-btn" onClick={handleCreateNote}>
            <Plus size={16} />
            Nueva Nota
          </button>
          <div className="search-container">
            <Search className="search-icon" size={16} />
            <input 
              type="text" 
              placeholder="Buscar notas..." 
              className="search-input"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>

        <div className="notes-list">
          {filteredNotes.map((note) => {
            const recentJob = note.audioJobs?.[0]
            return (
              <div 
                key={note.id}
                className={`note-item ${selectedNote?.id === note.id ? 'active' : ''}`}
                onClick={() => setSelectedNote(note)}
              >
                <div className="note-item-header">
                  <span className="note-title-text">{note.title}</span>
                  {recentJob && (
                    <span className={`status-badge ${recentJob.status.toLowerCase()}`}>
                      {recentJob.status === 'PROCESSING' ? 'Procesando' : recentJob.status}
                    </span>
                  )}
                </div>
                <span className="note-date">
                  {new Date(note.updatedAt).toLocaleDateString('es-ES', {
                    day: '2-digit',
                    month: 'short',
                    hour: '2-digit',
                    minute: '2-digit'
                  })}
                </span>
              </div>
            )
          })}
        </div>
      </aside>

      {/* 2. MAIN PANEL */}
      <main className="main-panel">
        {selectedNote ? (
          <div className="workspace">
            {/* Toolbar & Header */}
            <div className="workspace-header">
              <div className="title-bar">
                <input 
                  type="text" 
                  className="title-input"
                  value={selectedNote.title}
                  onChange={(e) => handleTitleChange(e.target.value)}
                />
                
                <div className="save-indicator">
                  {savingStatus === 'saving' && <><RefreshCw size={14} className="status-icon-spin" /> Guardando...</>}
                  {savingStatus === 'saved' && <><CheckCircle2 size={14} style={{ color: '#00df89' }} /> Guardado</>}
                  {savingStatus === 'error' && <><XCircle size={14} style={{ color: '#ff0055' }} /> Error al guardar</>}
                </div>

                <button 
                  className="delete-note-btn" 
                  onClick={() => handleDeleteNote(selectedNote.id)}
                  title="Eliminar Apunte"
                  style={{
                    background: 'rgba(255, 0, 85, 0.1)',
                    border: '1px solid rgba(255, 0, 85, 0.25)',
                    color: '#ff0055',
                    padding: '8px 12px',
                    borderRadius: '8px',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    marginLeft: 'auto',
                    transition: 'all 0.2s ease',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'rgba(255, 0, 85, 0.25)'
                    e.currentTarget.style.boxShadow = '0 0 10px rgba(255, 0, 85, 0.2)'
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'rgba(255, 0, 85, 0.1)'
                    e.currentTarget.style.boxShadow = 'none'
                  }}
                >
                  <Trash2 size={14} style={{ marginRight: '6px' }} />
                  Eliminar
                </button>
              </div>

              {/* Transcription Audio Toolbar */}
              <div className="controls-toolbar">
                <div className="toolbar-group">
                  <span className="toolbar-label">Transcripción:</span>
                  
                  {/* Provider Choice */}
                  <select 
                    className="select-control"
                    value={provider}
                    onChange={(e) => setProvider(e.target.value)}
                  >
                    <option value="local">Whisper Local (CPU)</option>
                    <option value="groq">Groq Cloud (Rápido)</option>
                    <option value="openai">OpenAI Whisper API</option>
                  </select>

                  {/* Model Size Choice for Local Whisper */}
                  {provider === 'local' && (
                    <select 
                      className="select-control"
                      value={modelSize}
                      onChange={(e) => setModelSize(e.target.value)}
                    >
                      <option value="tiny">Tiny (Veloz)</option>
                      <option value="base">Base (Recomendado)</option>
                      <option value="small">Small</option>
                      <option value="medium">Medium</option>
                      <option value="large-v3">Large v3</option>
                    </select>
                  )}

                  {/* Language Selector */}
                  <select 
                    className="select-control"
                    value={language}
                    onChange={(e) => setLanguage(e.target.value)}
                  >
                    <option value="es">Español</option>
                    <option value="en">Inglés</option>
                    <option value="">Auto-detectar</option>
                  </select>
                </div>

                <div className="toolbar-group">
                  <input 
                    type="file" 
                    accept="audio/*" 
                    style={{ display: 'none' }} 
                    ref={fileInputRef}
                    onChange={handleFileUpload}
                  />
                  <button 
                    className="upload-btn" 
                    onClick={triggerFileSelect}
                    disabled={uploading || sseState.status === 'PROCESSING'}
                  >
                    <Music size={14} />
                    {uploading ? 'Subiendo...' : 'Subir Clase / Audio'}
                  </button>
                </div>
              </div>
            </div>

            {/* Realtime Transcribing Progress SSE Banner */}
            {sseState.status && sseState.status !== 'COMPLETED' && (
              <div className={`sse-banner ${sseState.status.toLowerCase()}`}>
                <div className="sse-left">
                  {sseState.status === 'PENDING' && (
                    <>
                      <Clock size={16} className="pulse-breathing" />
                      <span>Audio en cola. Esperando asignación de worker...</span>
                    </>
                  )}
                  {sseState.status === 'PROCESSING' && (
                    <>
                      <RefreshCw size={16} className="status-icon-spin" />
                      <span>Transcribiendo audio y estructurando apuntes con IA en tiempo real...</span>
                    </>
                  )}
                  {sseState.status === 'FAILED' && (
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <XCircle size={16} />
                        <span>La transcripción falló</span>
                      </div>
                      {sseState.errorMessage && (
                        <p className="sse-error-details">{sseState.errorMessage}</p>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Scrollable BlockNote Editor workspace */}
            <div className="editor-wrapper">
              <Editor 
                key={selectedNote.id}
                initialContent={selectedNote.content}
                onChange={handleContentChange}
              />
            </div>
          </div>
        ) : (
          /* Empty Workspace / Welcome Screen */
          <div className="welcome-screen">
            <div className="welcome-box">
              <div className="welcome-logo-glow">
                <FileText size={40} color="#fff" />
              </div>
              <h2>Bienvenido a PostNotes</h2>
              <p>
                Sube las grabaciones de tus clases o conferencias de hasta 90 minutos. 
                Nuestro sistema las transcribirá y organizará en apuntes estructurados interactivos en tiempo real.
              </p>
              <button className="new-note-btn" style={{ margin: '0 auto' }} onClick={handleCreateNote}>
                <Plus size={16} />
                Comenzar Apunte
              </button>

              <div className="welcome-stats">
                <div className="stat-item">
                  <div className="stat-val">{notes.length}</div>
                  <div className="stat-lbl">Notas Creadas</div>
                </div>
                <div className="stat-item">
                  <div className="stat-val">Whisper</div>
                  <div className="stat-lbl">Tecnología IA</div>
                </div>
              </div>
            </div>
          </div>
        )}
        
        {/* Loading connection status screen overlay */}
        {backendConnected === null && (
          <div className="welcome-screen" style={{ position: 'absolute', top: 0, left: 320, right: 0, bottom: 0, background: 'var(--color-bg-deep)', zIndex: 100 }}>
            <div className="welcome-box">
              <RefreshCw size={40} className="status-icon-spin" style={{ color: 'var(--accent-electric)', margin: '0 auto 20px', display: 'block' }} />
              <h2>Conectando con PostNotes...</h2>
              <p>Estableciendo enlace seguro con la base de datos y la API local.</p>
            </div>
          </div>
        )}

        {/* Server Disconnected error screen overlay */}
        {backendConnected === false && (
          <div className="welcome-screen" style={{ position: 'absolute', top: 0, left: 320, right: 0, bottom: 0, background: 'var(--color-bg-deep)', zIndex: 100 }}>
            <div className="welcome-box" style={{ borderColor: 'rgba(255, 0, 85, 0.25)', boxShadow: '0 0 30px rgba(255, 0, 85, 0.15)' }}>
              <div className="welcome-logo-glow" style={{ background: 'linear-gradient(135deg, #ff0055 0%, #7928ca 100%)', boxShadow: '0 0 20px rgba(255, 0, 85, 0.45)' }}>
                <CloudOff size={40} color="#fff" />
              </div>
              <h2>Servidor Desconectado</h2>
              <p style={{ color: 'rgba(255, 255, 255, 0.65)' }}>
                No pudimos conectarnos al servidor de PostNotes en <code>http://localhost:3000</code>.<br /><br />
                Asegúrate de que tu backend de Docker esté iniciado y corriendo:
              </p>
              
              <div style={{ textAlign: 'left', background: 'rgba(255, 255, 255, 0.02)', padding: '16px 20px', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.05)', marginBottom: '24px', fontSize: '13px', fontFamily: 'monospace', color: '#b0c0cf' }}>
                <span style={{ color: 'var(--accent-electric)', fontWeight: 'bold' }}># Ejecuta en tu terminal raíz:</span><br />
                docker compose up -d
              </div>

              <button className="new-note-btn" style={{ margin: '0 auto' }} onClick={checkConnection}>
                <RefreshCw size={16} />
                Reintentar Conexión
              </button>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}

export default App
