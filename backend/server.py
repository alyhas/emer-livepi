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

MODEL = "gemini-2.5-flash-preview-native-audio-dialog"

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
        response_modalities=[types.Modality.TEXT, types.Modality.AUDIO],
        media_resolution="MEDIA_RESOLUTION_MEDIUM",
        speech_config=types.SpeechConfig(
            language_code="en-US",
            voice_config=types.VoiceConfig(
                prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name="Puck") # Or allow client to choose
            )
        ),
        context_window_compression=types.ContextWindowCompressionConfig(
            trigger_tokens=25600,
            sliding_window=types.SlidingWindow(target_tokens=12800),
        ),
    )
    
    try:
        async with genai_client.aio.live.connect(model=MODEL, config=config) as session:
            logger.info("Successfully connected to Gemini Live API session.")
            
            # Send initial system message to client
            await websocket.send_json({
                "type": "system",
                "message": "Connected to Gemini Live API. You can now talk!"
            })

            # Define the handler for client-to-Gemini messages
            async def send_to_gemini(): # Note: This function will need access to 'websocket' and 'session' from the outer scope.
                try:
                    while True:
                        text = await websocket.receive_text()
                        data = json.loads(text)

                        if data["type"] == "audio":
                            audio_bytes = base64.b64decode(data["data"])
                            logger.info(f"Client Audio: Sending {len(audio_bytes)} bytes to Gemini") # Keep logging
                            await session.send_audio(audio_bytes)
                        elif data["type"] == "text":
                            logger.info(f"Client Text: Sending '{data['text']}' to Gemini") # Keep logging
                            await session.send_text(data["text"], end_of_turn=True)
                except WebSocketDisconnect:
                    logger.info("WebSocket disconnected by client during send_to_gemini.") # Keep logging
                    pass # Or re-raise if gather needs to know specifically
                except Exception as e: # Keep general error logging
                    logger.error(f"Error in send_to_gemini: {str(e)}")
                    # Consider sending error to client if websocket is still open
                    pass

            # Define the handler for Gemini-to-client messages
            async def receive_from_gemini(): # Note: This function will need access to 'websocket' and 'session' from the outer scope.
                try:
                    async for resp in session:
                        # TEXT partials
                        if resp.text_response and resp.text_response.text:
                            text_to_send = resp.text_response.text.strip()
                            if text_to_send: # Keep check for empty strings
                                logger.info(f"Gemini Text: Sending '{text_to_send}' to client") # Keep logging
                                await websocket.send_json({
                                    "type": "text_chunk",
                                    "text": text_to_send
                                })
                        # AUDIO partials
                        if resp.audio_response and resp.audio_response.audio:
                            audio_data = resp.audio_response.audio
                            if audio_data: # Ensure not sending empty audio
                                logger.info(f"Gemini Audio: Sending {len(audio_data)} bytes to client") # Keep logging
                                await websocket.send_bytes(audio_data)
                except WebSocketDisconnect: # This might be raised if client disconnects while session is active
                    logger.info("WebSocket disconnected during receive_from_gemini (or Gemini session ended).") # Keep logging
                    pass # Or re-raise
                except types.generation_types.StopCandidateException as e: # Keep specific error handling
                    logger.info(f"Gemini session ended with StopCandidateException in receive_from_gemini: {e}")
                    try:
                        await websocket.send_json({"type": "system", "message": "Conversation turn ended."})
                    except: pass
                except Exception as e: # Keep general error logging
                    logger.error(f"Error in receive_from_gemini: {str(e)}")
                    # Consider sending error to client if websocket is still open
                    pass
            
            # Run both loops concurrently. If one errors or completes, 'gather' will be affected.
            # If send_to_gemini ends due to WebSocketDisconnect, 
            # it will cause gather to cancel receive_from_gemini.
            await asyncio.gather(
                send_to_gemini(),
                receive_from_gemini()
            )
            
    except WebSocketDisconnect:
        logger.info("WebSocket disconnected by client (caught in main try-except).")
    except types.generation_types.DeadlineExceeded as e:
        logger.error(f"Gemini API DeadlineExceeded: {str(e)}")
        try:
            await websocket.send_json({"type": "error", "message": "Gemini API request timed out. Please try again."})
        except: pass
    except types.generation_types.RpcError as e:
        logger.error(f"Gemini API RpcError: {str(e)}")
        try:
            await websocket.send_json({"type": "error", "message": f"Gemini API communication error: {str(e)}"})
        except: pass
    except Exception as e:
        logger.error(f"Unhandled error in live audio WebSocket handler: {str(e)}")
        import traceback
        logger.error(traceback.format_exc())
        try:
            await websocket.send_json({
                "type": "error",
                "message": f"An unexpected server error occurred: {str(e)}"
            })
        except:
            pass # Websocket might be closed
    finally:
        logger.info("Gemini Live Audio WebSocket connection closed.")
        # Ensure client knows connection is closed if websocket is still open at this point
        # This might be redundant if WebSocketDisconnect was already handled, but good for cleanup.
        # try:
        #     if websocket.client_state != WebSocketState.DISCONNECTED:
        # await websocket.close(code=1000) # Graceful close
        # except Exception as e:
        # logger.debug(f"Error during final websocket close: {e}")


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