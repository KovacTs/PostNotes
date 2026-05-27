import os
import shutil
import tempfile
from typing import Dict, Optional
from fastapi import FastAPI, UploadFile, File, Form, HTTPException, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from faster_whisper import WhisperModel

app = FastAPI(
    title="PostNotes Transcriber Service",
    description="Faster-Whisper service optimized for CPU/ARM64",
    version="1.0.0"
)

# Caching loaded models to avoid loading overhead on every request
# Oracle VM.Standard.A1.Flex provides 24GB RAM, so caching is highly efficient.
models_cache: Dict[str, WhisperModel] = {}

def get_model(model_size: str) -> WhisperModel:
    """
    Returns a cached WhisperModel or initializes a new one.
    Uses 'cpu' device and 'int8' compute type for optimized execution on ARM architecture.
    """
    if model_size not in models_cache:
        try:
            cpu_threads = int(os.getenv("WHISPER_CPU_THREADS", "4"))
            num_workers = int(os.getenv("WHISPER_NUM_WORKERS", "1"))
            print(f"Loading Whisper model '{model_size}' on CPU (threads={cpu_threads}, workers={num_workers}) with compute_type='int8'...")
            # We download models into /root/.cache/huggingface which will be a persistent volume
            models_cache[model_size] = WhisperModel(
                model_size,
                device="cpu",
                compute_type="int8",
                cpu_threads=cpu_threads,
                num_workers=num_workers,
                download_root=os.getenv("WHISPER_MODELS_DIR", None)
            )
            print(f"Model '{model_size}' loaded successfully.")
        except Exception as e:
            print(f"Error loading model: {str(e)}")
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"Could not load Whisper model '{model_size}': {str(e)}"
            )
    return models_cache[model_size]

class TranscribePathRequest(BaseModel):
    file_path: str
    model_size: Optional[str] = "base"
    language: Optional[str] = None  # Auto-detect if None

@app.get("/health")
def health_check():
    """Health check endpoint."""
    return {"status": "healthy", "cached_models": list(models_cache.keys())}

@app.post("/transcribe")
def transcribe_file(
    file: UploadFile = File(None),
    file_path: Optional[str] = Form(None),
    model_size: str = Form("base"),
    language: Optional[str] = Form(None)
):
    """
    Transcribes an audio file.
    Supports either direct file upload OR a file path accessible on a shared volume.
    """
    target_path = None
    temp_dir = None

    try:
        # Determine file source
        if file_path:
            # Case 1: Audio file is already on a shared volume
            if not os.path.exists(file_path):
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"File not found on shared volume: {file_path}"
                )
            target_path = file_path
        elif file:
            # Case 2: Direct file upload via HTTP multipart
            temp_dir = tempfile.mkdtemp()
            target_path = os.path.join(temp_dir, file.filename)
            with open(target_path, "wb") as buffer:
                shutil.copyfileobj(file.file, buffer)
        else:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Either 'file' upload or 'file_path' must be provided."
            )

        # Get the initialized Whisper model
        model = get_model(model_size)

        print(f"Starting transcription for {target_path} using model {model_size}...")
        
        # Transcribe audio file
        # beam_size=5 is default for faster-whisper and balances speed/accuracy
        segments, info = model.transcribe(
            target_path,
            beam_size=5,
            language=language if language else None
        )

        # Compile segments
        transcribed_text = []
        segments_list = []
        
        for segment in segments:
            transcribed_text.append(segment.text)
            segments_list.append({
                "start": round(segment.start, 2),
                "end": round(segment.end, 2),
                "text": segment.text.strip()
            })

        full_text = " ".join(transcribed_text).strip()

        print(f"Transcription completed. Language detected: {info.language} (probability: {info.language_probability:.2f})")

        return {
            "text": full_text,
            "language": info.language,
            "language_probability": info.language_probability,
            "duration": info.duration,
            "segments": segments_list
        }

    except HTTPException as he:
        raise he
    except Exception as e:
        print(f"Error during transcription: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Transcription failed: {str(e)}"
        )
    finally:
        # Clean up temporary directory if we created one
        if temp_dir and os.path.exists(temp_dir):
            shutil.rmtree(temp_dir)

@app.post("/transcribe/path")
def transcribe_from_path(request: TranscribePathRequest):
    """
    Alternative endpoint accepting JSON payload for transcribing via shared volume file path.
    """
    return transcribe_file(
        file=None,
        file_path=request.file_path,
        model_size=request.model_size or "base",
        language=request.language
    )
