import React, { useState, useRef, useEffect, useCallback } from "react";
import "./App.css";

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL;

function App() {
  const [isConnected, setIsConnected] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState("Disconnected");
  const [aiResponse, setAiResponse] = useState("");
  const [voices, setVoices] = useState([]);
  const [selectedVoice, setSelectedVoice] = useState("Puck");
  
  const wsRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const audioStreamRef = useRef(null);
  const audioContextRef = useRef(null);
  const audioChunksRef = useRef([]);

  // Fetch available voices
  useEffect(() => {
    fetchVoices();
  }, []);

  const fetchVoices = async () => {
    try {
      const response = await fetch(`${BACKEND_URL}/api/voices`);
      const data = await response.json();
      setVoices(data.voices);
    } catch (error) {
      console.error("Error fetching voices:", error);
      setVoices(["Puck", "Charon", "Kore", "Fenrir"]);
    }
  };

  const connectToGemini = useCallback(async () => {
    try {
      setConnectionStatus("Connecting...");
      
      // Create WebSocket connection
      const wsUrl = `${BACKEND_URL.replace('https:', 'wss:').replace('http:', 'ws:')}/api/live-audio`;
      wsRef.current = new WebSocket(wsUrl);

      wsRef.current.onopen = () => {
        console.log("Connected to Gemini Live API");
        setIsConnected(true);
        setConnectionStatus("Connected");
      };

      wsRef.current.onmessage = (event) => {
        const data = JSON.parse(event.data);
        console.log("Received from Gemini:", data);
        
        if (data.type === "audio_response") {
          // Play audio response from Gemini
          console.log("Playing audio response, size:", data.data.length);
          playAudioResponse(data.data);
        } else if (data.type === "text_response") {
          console.log("Received text response:", data.text);
          setAiResponse(prev => prev + data.text);
        } else if (data.type === "system") {
          console.log("System message:", data.message);
        } else if (data.type === "error") {
          console.error("Gemini error:", data.message);
          setConnectionStatus("Error: " + data.message);
        }
      };

      wsRef.current.onerror = (error) => {
        console.error("WebSocket error:", error);
        setConnectionStatus("Connection Error");
        setIsConnected(false);
      };

      wsRef.current.onclose = () => {
        console.log("Disconnected from Gemini Live API");
        setIsConnected(false);
        setConnectionStatus("Disconnected");
      };

    } catch (error) {
      console.error("Error connecting to Gemini:", error);
      setConnectionStatus("Connection Failed");
    }
  }, []);

  const playAudioResponse = async (audioBase64) => {
    try {
      setIsPlaying(true);
      
      // Convert base64 to audio buffer
      const audioData = atob(audioBase64);
      const audioBuffer = new Uint8Array(audioData.length);
      for (let i = 0; i < audioData.length; i++) {
        audioBuffer[i] = audioData.charCodeAt(i);
      }
      
      // Create audio context if needed
      if (!audioContextRef.current) {
        audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)();
      }
      
      // Create audio blob and play
      const blob = new Blob([audioBuffer], { type: 'audio/wav' });
      const audioUrl = URL.createObjectURL(blob);
      const audio = new Audio(audioUrl);
      
      audio.onended = () => {
        setIsPlaying(false);
        URL.revokeObjectURL(audioUrl);
      };
      
      await audio.play();
      
    } catch (error) {
      console.error("Error playing audio:", error);
      setIsPlaying(false);
    }
  };

  const startRecording = async () => {
    try {
      if (!isConnected) {
        alert("Please connect to Gemini first!");
        return;
      }

      setAiResponse(""); // Clear previous response
      
      // Get microphone access
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          sampleRate: 16000,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true
        } 
      });
      
      audioStreamRef.current = stream;
      
      // Create MediaRecorder
      mediaRecorderRef.current = new MediaRecorder(stream, {
        mimeType: 'audio/webm;codecs=opus'
      });
      
      audioChunksRef.current = [];
      
      mediaRecorderRef.current.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };
      
      mediaRecorderRef.current.onstop = async () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        
        // Convert to base64 and send to Gemini
        const reader = new FileReader();
        reader.onloadend = () => {
          const base64data = reader.result.split(',')[1];
          if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({
              type: "audio",
              data: base64data
            }));
          }
        };
        reader.readAsDataURL(audioBlob);
      };
      
      // Start recording
      mediaRecorderRef.current.start(100); // Collect data every 100ms
      setIsRecording(true);
      
    } catch (error) {
      console.error("Error starting recording:", error);
      alert("Error accessing microphone: " + error.message);
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
    
    if (audioStreamRef.current) {
      audioStreamRef.current.getTracks().forEach(track => track.stop());
    }
  };

  const sendTextMessage = () => {
    const textInput = document.getElementById('textInput');
    const text = textInput.value.trim();
    
    if (text && isConnected && wsRef.current) {
      setAiResponse(""); // Clear previous response
      wsRef.current.send(JSON.stringify({
        type: "text",
        text: text
      }));
      textInput.value = "";
    }
  };

  const disconnect = () => {
    if (wsRef.current) {
      wsRef.current.close();
    }
    stopRecording();
    setIsConnected(false);
    setConnectionStatus("Disconnected");
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-900 via-purple-900 to-indigo-900">
      <div className="container mx-auto px-4 py-8">
        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="text-5xl font-bold text-white mb-4 bg-gradient-to-r from-blue-400 to-purple-400 bg-clip-text text-transparent">
            🤖 Gemini Live Audio Dialog
          </h1>
          <p className="text-xl text-gray-300">
            Talk to Gemini AI with native audio conversation
          </p>
        </div>

        {/* Connection Status */}
        <div className="max-w-4xl mx-auto mb-6">
          <div className="bg-white/10 backdrop-blur-lg rounded-lg p-4 border border-white/20">
            <div className="flex items-center justify-between">
              <div className="flex items-center">
                <div className={`w-3 h-3 rounded-full mr-3 ${
                  isConnected ? 'bg-green-400 animate-pulse' : 'bg-red-400'
                }`}></div>
                <span className="text-white font-medium">Status: {connectionStatus}</span>
              </div>
              <div className="flex gap-2">
                {!isConnected ? (
                  <button
                    onClick={connectToGemini}
                    className="px-4 py-2 bg-green-500 text-white rounded-lg hover:bg-green-600 transition-colors"
                  >
                    Connect to Gemini
                  </button>
                ) : (
                  <button
                    onClick={disconnect}
                    className="px-4 py-2 bg-red-500 text-white rounded-lg hover:bg-red-600 transition-colors"
                  >
                    Disconnect
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Main Interface */}
        <div className="max-w-4xl mx-auto">
          <div className="bg-white/10 backdrop-blur-lg rounded-2xl p-8 shadow-2xl border border-white/20">
            
            {/* Voice Selection */}
            <div className="mb-6">
              <label className="block text-white text-sm font-medium mb-2">
                AI Voice
              </label>
              <select
                value={selectedVoice}
                onChange={(e) => setSelectedVoice(e.target.value)}
                className="w-full md:w-auto px-4 py-3 bg-white/20 border border-white/30 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-blue-400"
                disabled={!isConnected}
              >
                {voices.map((voice) => (
                  <option key={voice} value={voice} className="bg-gray-800">
                    {voice}
                  </option>
                ))}
              </select>
            </div>

            {/* Audio Controls */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
              
              {/* Voice Input */}
              <div className="bg-white/10 rounded-lg p-6">
                <h3 className="text-white text-lg font-medium mb-4 flex items-center">
                  🎤 Voice Input
                </h3>
                
                <div className="text-center">
                  {!isRecording ? (
                    <button
                      onClick={startRecording}
                      disabled={!isConnected}
                      className="w-20 h-20 bg-red-500 hover:bg-red-600 disabled:bg-gray-500 rounded-full flex items-center justify-center text-white text-2xl transition-all duration-200 mx-auto mb-4"
                    >
                      🎤
                    </button>
                  ) : (
                    <button
                      onClick={stopRecording}
                      className="w-20 h-20 bg-red-600 animate-pulse rounded-full flex items-center justify-center text-white text-2xl mx-auto mb-4"
                    >
                      ⏹️
                    </button>
                  )}
                  
                  <p className="text-gray-300 text-sm">
                    {isRecording ? "Recording... Click to stop" : "Click to start talking"}
                  </p>
                </div>
              </div>

              {/* AI Response */}
              <div className="bg-white/10 rounded-lg p-6">
                <h3 className="text-white text-lg font-medium mb-4 flex items-center">
                  🔊 AI Response
                  {isPlaying && (
                    <span className="ml-2 text-blue-400 animate-pulse">Playing...</span>
                  )}
                </h3>
                
                <div className="min-h-[100px] bg-white/10 rounded-lg p-4">
                  <p className="text-gray-200 whitespace-pre-wrap">
                    {aiResponse || "AI response will appear here..."}
                  </p>
                </div>
              </div>
            </div>

            {/* Text Input Alternative */}
            <div className="bg-white/10 rounded-lg p-6">
              <h3 className="text-white text-lg font-medium mb-4">💬 Or Type a Message</h3>
              <div className="flex gap-2">
                <input
                  id="textInput"
                  type="text"
                  placeholder="Type your message here..."
                  className="flex-1 px-4 py-3 bg-white/20 border border-white/30 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-400"
                  disabled={!isConnected}
                  onKeyPress={(e) => e.key === 'Enter' && sendTextMessage()}
                />
                <button
                  onClick={sendTextMessage}
                  disabled={!isConnected}
                  className="px-6 py-3 bg-blue-500 hover:bg-blue-600 disabled:bg-gray-500 text-white rounded-lg transition-colors"
                >
                  Send
                </button>
              </div>
            </div>

            {/* Instructions */}
            <div className="mt-6 text-center text-gray-400 text-sm">
              <p className="mb-2">
                ✨ <strong>How to use:</strong>
              </p>
              <p>
                1. Click "Connect to Gemini" → 2. Click the microphone to talk → 3. Have a conversation!
              </p>
              <p className="mt-2">
                🎯 You can also type messages or switch voices anytime
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;