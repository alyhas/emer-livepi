from fastapi import FastAPI, APIRouter, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.responses import StreamingResponse
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os
import logging
from pathlib import Path
from pydantic import BaseModel, Field
from typing import List
import uuid
from datetime import datetime
import json
import asyncio
from google import genai
from google.genai import types
import io

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

# MongoDB connection
mongo_url = os.environ['MONGO_URL']
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ['DB_NAME']]

# Initialize Gemini client
GEMINI_API_KEY = os.environ.get('GEMINI_API_KEY')
if not GEMINI_API_KEY:
    raise ValueError("GEMINI_API_KEY not found in environment variables")

gemini_client = genai.Client(api_key=GEMINI_API_KEY)

# Create the main app without a prefix
app = FastAPI()

# Create a router with the /api prefix
api_router = APIRouter(prefix="/api")

# Define Models
class StatusCheck(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    client_name: str
    timestamp: datetime = Field(default_factory=datetime.utcnow)

class StatusCheckCreate(BaseModel):
    client_name: str

class TextToSpeechRequest(BaseModel):
    text: str
    voice: str = "Kore"  # Default voice

# Add your routes to the router instead of directly to app
@api_router.get("/")
async def root():
    return {"message": "Hello World"}

@api_router.post("/status", response_model=StatusCheck)
async def create_status_check(input: StatusCheckCreate):
    status_dict = input.dict()
    status_obj = StatusCheck(**status_dict)
    _ = await db.status_checks.insert_one(status_obj.dict())
    return status_obj

@api_router.get("/status", response_model=List[StatusCheck])
async def get_status_checks():
    status_checks = await db.status_checks.find().to_list(1000)
    return [StatusCheck(**status_check) for status_check in status_checks]

@api_router.post("/text-to-speech-stream")
async def text_to_speech_stream(request: TextToSpeechRequest):
    """
    Stream audio from text using Gemini Live API
    """
    try:
        # Configure the session for audio responses
        config = types.LiveConnectConfig(
            response_modalities=["AUDIO"],
            speech_config=types.SpeechConfig(
                voice_config=types.VoiceConfig(
                    prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=request.voice)
                )
            )
        )

        # Create a live session
        session = gemini_client.start_live_session(config=config)

        async def generate_audio():
            try:
                # Send text input to the model
                await session.send_client_content(
                    turns=[{"role": "user", "parts": [{"text": request.text}]}],
                    turn_complete=True
                )

                # Receive and yield the streaming audio response
                async for response in session.receive():
                    for part in response.parts:
                        if part.audio:
                            yield part.audio
                            
            except Exception as e:
                logger.error(f"Error in audio generation: {str(e)}")
                raise
            finally:
                # Clean up the session
                try:
                    await session.end()
                except:
                    pass

        return StreamingResponse(
            generate_audio(), 
            media_type="audio/wav",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
            }
        )

    except Exception as e:
        logger.error(f"Error in text_to_speech_stream: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Text-to-speech streaming failed: {str(e)}")

@api_router.get("/voices")
async def get_available_voices():
    """
    Get list of available voices
    """
    voices = ["Puck", "Charon", "Kore", "Fenrir", "Aoede", "Leda", "Orus", "Zephyr"]
    return {"voices": voices}

# WebSocket endpoint for real-time streaming
@api_router.websocket("/tts-websocket")
async def websocket_tts(websocket: WebSocket):
    await websocket.accept()
    session = None
    
    try:
        while True:
            # Receive text from client
            data = await websocket.receive_text()
            message = json.loads(data)
            
            text = message.get("text", "")
            voice = message.get("voice", "Kore")
            
            if not text:
                await websocket.send_json({"error": "No text provided"})
                continue
            
            try:
                # Configure the session for audio responses
                config = types.LiveConnectConfig(
                    response_modalities=["AUDIO"],
                    speech_config=types.SpeechConfig(
                        voice_config=types.VoiceConfig(
                            prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=voice)
                        )
                    )
                )

                # Create a new live session
                session = gemini_client.start_live_session(config=config)

                # Send text input to the model
                await session.send_client_content(
                    turns=[{"role": "user", "parts": [{"text": text}]}],
                    turn_complete=True
                )

                # Send streaming audio response
                async for response in session.receive():
                    for part in response.parts:
                        if part.audio:
                            # Convert audio bytes to base64 for JSON transmission
                            import base64
                            audio_b64 = base64.b64encode(part.audio).decode('utf-8')
                            await websocket.send_json({
                                "type": "audio_chunk",
                                "data": audio_b64
                            })
                
                await websocket.send_json({"type": "end"})
                
            except Exception as e:
                logger.error(f"Error in WebSocket TTS: {str(e)}")
                await websocket.send_json({"error": str(e)})
            finally:
                if session:
                    try:
                        await session.end()
                    except:
                        pass
                    session = None
                    
    except WebSocketDisconnect:
        logger.info("WebSocket disconnected")
    except Exception as e:
        logger.error(f"WebSocket error: {str(e)}")
    finally:
        if session:
            try:
                await session.end()
            except:
                pass

# Include the router in the main app
app.include_router(api_router)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()