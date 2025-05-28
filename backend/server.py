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
import base64

import google.genai as genai
from google.genai import types

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

genai_client = genai.Client(
    http_options={"api_version": "v1beta"},
    api_key=GEMINI_API_KEY,
)

MODEL = "models/gemini-2.0-flash-live-001"

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

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

# Add your routes to the router instead of directly to app
@api_router.get("/")
async def root():
    return {"message": "Gemini Live API Audio Dialog"}

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

@api_router.get("/voices")
async def get_available_voices():
    """Get list of available voices for Gemini Live API"""
    voices = ["Puck", "Charon", "Kore", "Fenrir", "Aoede", "Leda", "Orus", "Zephyr"]
    return {"voices": voices}

@api_router.post("/test-gemini-text")
async def test_gemini_text(request: dict):
    """Simple test endpoint for Gemini Live API with text"""
    try:
        text = request.get("text", "Hello!")
        logger.info(f"Testing Gemini with text: {text}")
        
        config = types.LiveConnectConfig(
            response_modalities=["AUDIO"],
            speech_config=types.SpeechConfig(
                voice_config=types.VoiceConfig(
                    prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name="Puck")
                )
            )
        )
        
        async with genai_client.aio.live.connect(model=MODEL, config=config) as session:
            logger.info("Connected to Gemini for text test")
            await session.send(input=text, end_of_turn=True)
            
            responses = []
            turn = session.receive()
            async for response in turn:
                logger.info(f"Response type: {type(response)}")
                logger.info(f"Response attributes: {dir(response)}")
                
                if hasattr(response, 'text') and response.text:
                    responses.append({"type": "text", "content": response.text})
                    
                if hasattr(response, 'parts'):
                    for part in response.parts:
                        if hasattr(part, 'text') and part.text:
                            responses.append({"type": "text", "content": part.text})
                        if hasattr(part, 'inline_data'):
                            responses.append({"type": "audio", "size": len(part.inline_data.data) if part.inline_data.data else 0})
                            
                break  # Just get first response for test
            
            return {"status": "success", "responses": responses}
            
    except Exception as e:
        logger.error(f"Test failed: {str(e)}")
        import traceback
        logger.error(traceback.format_exc())
        return {"status": "error", "message": str(e)}

# WebSocket endpoint for Gemini Live Audio Dialog
@api_router.websocket("/live-audio")
async def gemini_live_audio(websocket: WebSocket):
    await websocket.accept()
    logger.info("WebSocket connected for Gemini Live Audio")
    
    # Default configuration for audio dialog
    config = types.LiveConnectConfig(
        response_modalities=["AUDIO"],
        media_resolution="MEDIA_RESOLUTION_MEDIUM",
        speech_config=types.SpeechConfig(
            language_code="en-US",
            voice_config=types.VoiceConfig(
                prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name="Puck")
            )
        ),
        context_window_compression=types.ContextWindowCompressionConfig(
            trigger_tokens=25600,
            sliding_window=types.SlidingWindow(target_tokens=12800),
        ),
    )
    
    try:
        async with genai_client.aio.live.connect(model=MODEL, config=config) as session:
            logger.info("Connected to Gemini Live API")
            
            # Send initial system message
            await websocket.send_json({
                "type": "system",
                "message": "Connected to Gemini Live API. You can now talk!"
            })
            
            async def handle_websocket_messages():
                """Handle incoming messages from the client"""
                try:
                    while True:
                        message = await websocket.receive_text()
                        data = json.loads(message)
                        
                        if data["type"] == "audio":
                            # Send audio data to Gemini
                            audio_data = base64.b64decode(data["data"])
                            logger.info(f"Sending audio data: {len(audio_data)} bytes")
                            await session.send(input={
                                "data": audio_data,
                                "mime_type": "audio/webm"  # Changed from audio/pcm to webm
                            })
                            
                        elif data["type"] == "text":
                            # Send text message to Gemini
                            logger.info(f"Sending text: {data['text']}")
                            await session.send(input=data["text"], end_of_turn=True)
                            
                        elif data["type"] == "config":
                            # Update voice configuration if needed
                            logger.info(f"Config update: {data}")
                            
                except WebSocketDisconnect:
                    logger.info("WebSocket disconnected")
                except Exception as e:
                    logger.error(f"Error handling websocket messages: {str(e)}")
            
            async def handle_gemini_responses():
                """Handle responses from Gemini Live API"""
                try:
                    while True:
                        turn = session.receive()
                        async for response in turn:
                            logger.info(f"Received response: {type(response)}")
                            
                            # Handle different response types
                            if hasattr(response, 'data') and response.data:
                                # Send audio response back to client
                                audio_b64 = base64.b64encode(response.data).decode('utf-8')
                                await websocket.send_json({
                                    "type": "audio_response",
                                    "data": audio_b64
                                })
                                logger.info("Sent audio response to client")
                            
                            if hasattr(response, 'text') and response.text:
                                # Send text response back to client
                                await websocket.send_json({
                                    "type": "text_response",
                                    "text": response.text
                                })
                                logger.info(f"Sent text response: {response.text}")
                            
                            # Check for parts in response
                            if hasattr(response, 'parts'):
                                for part in response.parts:
                                    if hasattr(part, 'inline_data') and part.inline_data:
                                        # Handle inline audio data
                                        audio_b64 = base64.b64encode(part.inline_data.data).decode('utf-8')
                                        await websocket.send_json({
                                            "type": "audio_response",
                                            "data": audio_b64
                                        })
                                        logger.info("Sent inline audio response to client")
                                    
                                    if hasattr(part, 'text') and part.text:
                                        await websocket.send_json({
                                            "type": "text_response",
                                            "text": part.text
                                        })
                                        logger.info(f"Sent part text response: {part.text}")
                                        
                except Exception as e:
                    logger.error(f"Error handling Gemini responses: {str(e)}")
                    import traceback
                    logger.error(traceback.format_exc())
            
            # Run both handlers concurrently
            await asyncio.gather(
                handle_websocket_messages(),
                handle_gemini_responses()
            )
            
    except WebSocketDisconnect:
        logger.info("WebSocket disconnected")
    except Exception as e:
        logger.error(f"Error in live audio websocket: {str(e)}")
        try:
            await websocket.send_json({
                "type": "error",
                "message": str(e)
            })
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

@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()