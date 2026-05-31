import React, { useState, useEffect, useRef } from "react"
import { 
  Mic, 
  Square, 
  Pause, 
  Play, 
  Upload, 
  Settings
} from "lucide-react"
import { Button } from "./ui/button"
import { Select } from "./ui/select"
import { Card, CardContent } from "./ui/card"
import axios from "axios"

interface AudioRecorderProps {
  noteId: string
  onUploadStart: () => void
  onUploadSuccess: (jobId: string) => void
  onUploadError: (err: string) => void
  disabled?: boolean
}

export default function AudioRecorder({
  noteId,
  onUploadStart,
  onUploadSuccess,
  onUploadError,
  disabled = false
}: AudioRecorderProps) {
  // Config States
  const [provider, setProvider] = useState("local")
  const [modelSize, setModelSize] = useState("base")
  const [language, setLanguage] = useState("es")

  // Recording Logic States
  const [isRecording, setIsRecording] = useState(false)
  const [isPaused, setIsPaused] = useState(false)
  const [recordingTime, setRecordingTime] = useState(0)
  const [uploading, setUploading] = useState(false)

  // Refs for audio capturing
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const streamRef = useRef<MediaStream | null>(null)
  const timerRef = useRef<any>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  // Refs for Web Audio visualizer
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const animationFrameRef = useRef<number | null>(null)

  // Clean up on unmount
  useEffect(() => {
    return () => {
      cleanupAudio()
    }
  }, [])

  const cleanupAudio = () => {
    if (timerRef.current) clearInterval(timerRef.current)
    if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current)
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop())
    }
    if (audioContextRef.current && audioContextRef.current.state !== "closed") {
      audioContextRef.current.close()
    }
    audioContextRef.current = null
    analyserRef.current = null
    sourceRef.current = null
    streamRef.current = null
  }

  // 1. Web Audio visualizer wave logic
  const startVisualizer = (stream: MediaStream) => {
    try {
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext
      const audioContext = new AudioContextClass()
      const analyser = audioContext.createAnalyser()
      const source = audioContext.createMediaStreamSource(stream)

      analyser.fftSize = 256
      source.connect(analyser)

      audioContextRef.current = audioContext
      analyserRef.current = analyser
      sourceRef.current = source

      drawVisualizer()
    } catch (err) {
      console.warn("Failed to initialize Web Audio visualizer:", err)
    }
  }

  const drawVisualizer = () => {
    if (!canvasRef.current || !analyserRef.current) return

    const canvas = canvasRef.current
    const ctx = canvas.getContext("2d")
    if (!ctx) return

    const analyser = analyserRef.current
    const bufferLength = analyser.frequencyBinCount
    const dataArray = new Uint8Array(bufferLength)

    const width = canvas.width
    const height = canvas.height

    const draw = () => {
      if (!analyserRef.current || !canvasRef.current) return
      
      animationFrameRef.current = requestAnimationFrame(draw)
      analyser.getByteFrequencyData(dataArray)

      ctx.fillStyle = "rgba(10, 10, 12, 0.2)" // sleek trail effect
      ctx.fillRect(0, 0, width, height)

      // If paused, just draw a silent flat center line
      if (isPaused) {
        ctx.lineWidth = 2
        ctx.strokeStyle = "rgba(168, 85, 247, 0.4)" // purple accent
        ctx.beginPath()
        ctx.moveTo(0, height / 2)
        ctx.lineTo(width, height / 2)
        ctx.stroke()
        return
      }

      const barWidth = (width / bufferLength) * 2.5
      let barHeight
      let x = 0

      // Waveform center gradient glow
      const gradient = ctx.createLinearGradient(0, 0, width, 0)
      gradient.addColorStop(0, "#a855f7") // purple-500
      gradient.addColorStop(0.5, "#10b981") // emerald-500
      gradient.addColorStop(1, "#3b82f6") // blue-500

      ctx.beginPath()
      for (let i = 0; i < bufferLength; i++) {
        barHeight = dataArray[i] / 1.5

        // Scale bar height according to active volume
        if (barHeight < 1) barHeight = 2

        const y = height / 2 - barHeight / 2
        
        ctx.fillStyle = gradient
        ctx.fillRect(x, y, barWidth - 1, barHeight)

        x += barWidth + 1
      }
    }

    draw()
  }

  // 2. Start Recording
  const startRecording = async () => {
    audioChunksRef.current = []
    setRecordingTime(0)
    setIsRecording(true)
    setIsPaused(false)

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream

      // Configure media recorder with native fallback codecs
      let options = { mimeType: "audio/webm" }
      if (!MediaRecorder.isTypeSupported(options.mimeType)) {
        options = { mimeType: "audio/ogg" }
      }
      if (!MediaRecorder.isTypeSupported(options.mimeType)) {
        options = { mimeType: "" } // browser default
      }

      const mediaRecorder = new MediaRecorder(stream, options)
      mediaRecorderRef.current = mediaRecorder

      mediaRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          audioChunksRef.current.push(event.data)
        }
      }

      mediaRecorder.onstop = async () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: mediaRecorder.mimeType || "audio/webm" })
        await uploadAudioBlob(audioBlob)
        cleanupAudio()
      }

      // Start capturing
      mediaRecorder.start(1000) // fire dataavailable event every 1s
      startVisualizer(stream)

      // Start timer tick
      timerRef.current = setInterval(() => {
        setRecordingTime(prev => prev + 1)
      }, 1000)

    } catch (err: any) {
      console.error("Mic permissions or initialization failed:", err)
      setIsRecording(false)
      onUploadError("No se pudo acceder al micrófono. Por favor concede los permisos de audio.")
    }
  }

  // 3. Pause Recording
  const pauseRecording = () => {
    if (!mediaRecorderRef.current || !isRecording || isPaused) return
    mediaRecorderRef.current.pause()
    setIsPaused(true)
    
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }

    // Suspend audio context visualizer to freeze wave drawing
    if (audioContextRef.current && audioContextRef.current.state === "running") {
      audioContextRef.current.suspend()
    }
  }

  // 4. Resume Recording
  const resumeRecording = () => {
    if (!mediaRecorderRef.current || !isRecording || !isPaused) return
    mediaRecorderRef.current.resume()
    setIsPaused(false)

    // Resume timer ticks
    timerRef.current = setInterval(() => {
      setRecordingTime(prev => prev + 1)
    }, 1000)

    // Resume audio context visualizer
    if (audioContextRef.current && audioContextRef.current.state === "suspended") {
      audioContextRef.current.resume()
    }
  }

  // 5. Stop Recording (Triggers Auto-upload)
  const stopRecording = () => {
    if (!mediaRecorderRef.current || !isRecording) return
    setIsRecording(false)
    setIsPaused(false)
    
    // Stop recording, triggering the onstop event
    mediaRecorderRef.current.stop()
  }

  // 6. Binary Blob Automatic Upload Logic
  const uploadAudioBlob = async (blob: Blob) => {
    setUploading(true)
    onUploadStart()

    const formData = new FormData()
    // Always upload as a proper mp3 or webm audio file
    const fileExtension = blob.type.includes("ogg") ? "ogg" : "webm"
    formData.append("audio", blob, `grabacion-${Date.now()}.${fileExtension}`)

    try {
      const url = `/api/notes/${noteId}/audio?provider=${provider}&modelSize=${modelSize}&language=${language}`
      const response = await axios.post(url, formData, {
        headers: { "Content-Type": "multipart/form-data" }
      })

      if (response.data && response.data.jobId) {
        onUploadSuccess(response.data.jobId)
      } else {
        throw new Error("No se obtuvo un Identificador de trabajo válido.")
      }
    } catch (err: any) {
      console.error("Automatic upload failed:", err)
      onUploadError(err.response?.data?.error || err.message || "Error al subir el audio grabado.")
    } finally {
      setUploading(false)
    }
  }

  // 7. Manual File Upload trigger alternative
  const handleFileSelect = () => {
    fileInputRef.current?.click()
  }

  const handleManualUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    setUploading(true)
    onUploadStart()
    const formData = new FormData()
    formData.append("audio", file)

    try {
      const url = `/api/notes/${noteId}/audio?provider=${provider}&modelSize=${modelSize}&language=${language}`
      const response = await axios.post(url, formData, {
        headers: { "Content-Type": "multipart/form-data" }
      })

      if (response.data && response.data.jobId) {
        onUploadSuccess(response.data.jobId)
      } else {
        throw new Error("No se obtuvo un Identificador de trabajo válido.")
      }
    } catch (err: any) {
      console.error("Manual file upload failed:", err)
      onUploadError(err.response?.data?.error || err.message || "Error al subir el archivo seleccionado.")
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ""
    }
  }

  // Time formatter (00:00)
  const formatTime = (totalSeconds: number) => {
    const minutes = Math.floor(totalSeconds / 60)
    const seconds = totalSeconds % 60
    return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`
  }

  return (
    <Card className="border border-border/40 overflow-hidden mb-6 bg-card/20 shadow-lg relative border-glow">
      <CardContent className="p-6">
        <div className="flex flex-col lg:flex-row gap-6 items-stretch">
          
          {/* Recorder Controls Dashboard */}
          <div className="flex-1 flex flex-col justify-between">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <div className={`h-2.5 w-2.5 rounded-full ${isRecording ? (isPaused ? "bg-amber-500" : "bg-red-500 animate-ping") : "bg-muted-foreground/30"}`} />
                <span className="text-sm font-semibold tracking-wide uppercase text-muted-foreground">
                  {isRecording ? (isPaused ? "Grabación Pausada" : "Grabación en curso...") : "Consola de Audio"}
                </span>
              </div>
              
              {isRecording && (
                <div className="font-mono text-lg font-bold text-glow text-primary">
                  {formatTime(recordingTime)}
                </div>
              )}
            </div>

            {/* Glowing wave Visualizer */}
            <div className="w-full h-24 bg-background/50 rounded-lg relative overflow-hidden border border-border/30 flex items-center justify-center mb-6">
              <canvas 
                ref={canvasRef} 
                width={500} 
                height={96}
                className="w-full h-full block absolute inset-0"
              />
              
              {!isRecording && !uploading && (
                <div className="flex flex-col items-center gap-1 z-10 opacity-70 pointer-events-none">
                  <Mic className="h-6 w-6 text-muted-foreground" />
                  <span className="text-xs text-muted-foreground">Ondas sonoras en espera</span>
                </div>
              )}

              {uploading && (
                <div className="flex flex-col items-center gap-2 z-10">
                  <div className="animate-spin rounded-full h-6 w-6 border-2 border-primary border-t-transparent" />
                  <span className="text-xs text-primary font-medium tracking-wide">Subiendo archivo automáticamente...</span>
                </div>
              )}
            </div>

            {/* Control buttons */}
            <div className="flex items-center gap-3">
              {!isRecording ? (
                <Button 
                  onClick={startRecording}
                  disabled={disabled || uploading}
                  variant="default"
                  className="flex-1 gap-2 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700 text-white shadow-md shadow-purple-500/10"
                >
                  <Mic className="h-4 w-4" />
                  Grabar Clase
                </Button>
              ) : (
                <div className="flex flex-1 gap-3">
                  {isPaused ? (
                    <Button 
                      onClick={resumeRecording}
                      variant="secondary"
                      className="flex-1 gap-2 border border-border bg-secondary/80 hover:bg-secondary"
                    >
                      <Play className="h-4 w-4 text-emerald-500 fill-emerald-500/20" />
                      Reanudar
                    </Button>
                  ) : (
                    <Button 
                      onClick={pauseRecording}
                      variant="secondary"
                      className="flex-1 gap-2 border border-border bg-secondary/80 hover:bg-secondary"
                    >
                      <Pause className="h-4 w-4 text-amber-500 fill-amber-500/20" />
                      Pausar
                    </Button>
                  )}

                  <Button 
                    onClick={stopRecording}
                    variant="destructive"
                    className="flex-1 gap-2 shadow-md shadow-red-500/10 border border-red-500/20 bg-red-600/90 hover:bg-red-600"
                  >
                    <Square className="h-4 w-4 fill-white/20" />
                    Detener y Subir
                  </Button>
                </div>
              )}

              {/* Manual upload alternative hidden input */}
              <input 
                type="file" 
                ref={fileInputRef} 
                accept="audio/*" 
                style={{ display: "none" }} 
                onChange={handleManualUpload}
              />
              {!isRecording && (
                <Button 
                  onClick={handleFileSelect} 
                  variant="outline" 
                  disabled={disabled || uploading}
                  className="gap-2 border-border/80 bg-background/20 hover:bg-accent/40"
                  title="Subir archivo existente"
                >
                  <Upload className="h-4 w-4" />
                  <span className="hidden sm:inline">Subir archivo</span>
                </Button>
              )}
            </div>
          </div>

          {/* Vertical divider */}
          <div className="hidden lg:block w-[1px] bg-border/40" />

          {/* AI Speech Settings Panel */}
          <div className="w-full lg:w-72 flex flex-col gap-4 justify-between">
            <div className="flex items-center gap-2 mb-1">
              <Settings className="h-4 w-4 opacity-70" />
              <span className="text-xs font-semibold tracking-wide uppercase text-muted-foreground">Configuración de Transcripción</span>
            </div>

            {/* Provider */}
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-muted-foreground/90">Proveedor de Motor IA:</label>
              <Select 
                value={provider} 
                onChange={(e) => setProvider(e.target.value)}
                disabled={isRecording || uploading}
              >
                <option value="local">Whisper Local (CPU)</option>
                <option value="groq">Groq Cloud (Ultra Rápido)</option>
                <option value="openai">OpenAI Whisper API</option>
              </Select>
            </div>

            {/* Model Size (only if local) */}
            {provider === "local" && (
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-muted-foreground/90">Tamaño del Modelo Local:</label>
                <Select 
                  value={modelSize} 
                  onChange={(e) => setModelSize(e.target.value)}
                  disabled={isRecording || uploading}
                >
                  <option value="tiny">Tiny (Veloz)</option>
                  <option value="base">Base (Equilibrado)</option>
                  <option value="small">Small</option>
                  <option value="medium">Medium</option>
                  <option value="large-v3">Large v3</option>
                </Select>
              </div>
            )}

            {/* Language */}
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-muted-foreground/90">Idioma del Dictado:</label>
              <Select 
                value={language} 
                onChange={(e) => setLanguage(e.target.value)}
                disabled={isRecording || uploading}
              >
                <option value="es">Español</option>
                <option value="en">Inglés</option>
                <option value="">Auto-detectar</option>
              </Select>
            </div>
          </div>

        </div>
      </CardContent>
    </Card>
  )
}
