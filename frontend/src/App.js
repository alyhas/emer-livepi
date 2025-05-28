import React, { useState, useRef, useEffect } from "react";
import "./App.css";
import axios from "axios";

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL;
const API = `${BACKEND_URL}/api`;

function App() {
  const [text, setText] = useState("");
  const [selectedVoice, setSelectedVoice] = useState("Kore");
  const [isStreaming, setIsStreaming] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [voices, setVoices] = useState([]);
  const [streamingMethod, setStreamingMethod] = useState("http"); // "http" or "websocket"
  
  const audioRef = useRef(null);
  const wsRef = useRef(null);
  const audioContextRef = useRef(null);
  const sourceRef = useRef(null);

  // Fetch available voices on component mount
  useEffect(() => {
    fetchVoices();
  }, []);

  const fetchVoices = async () => {
    try {
      const response = await axios.get(`${API}/voices`);
      setVoices(response.data.voices);
    } catch (error) {
      console.error("Error fetching voices:", error);
      setVoices(["Kore", "Puck", "Charon", "Fenrir"]);
    }
  };

  const handleHttpStreaming = async () => {
    if (!text.trim()) {
      alert("Please enter some text to convert to speech");
      return;
    }

    setIsStreaming(true);
    setIsPlaying(true);

    try {
      const response = await axios.post(
        `${API}/text-to-speech-stream`,
        {
          text: text,
          voice: selectedVoice
        },
        {
          responseType: 'blob'
        }
      );

      // Create audio URL from blob
      const audioBlob = new Blob([response.data], { type: 'audio/wav' });
      const audioUrl = URL.createObjectURL(audioBlob);
      
      if (audioRef.current) {
        audioRef.current.src = audioUrl;
        audioRef.current.play();
      }

    } catch (error) {
      console.error("Error streaming audio:", error);
      alert("Error streaming audio: " + (error.response?.data?.detail || error.message));
    } finally {
      setIsStreaming(false);
    }
  };

  const handleWebSocketStreaming = () => {
    if (!text.trim()) {
      alert("Please enter some text to convert to speech");
      return;
    }

    setIsStreaming(true);
    setIsPlaying(true);

    // Create WebSocket connection
    const wsUrl = `${BACKEND_URL.replace('https:', 'wss:').replace('http:', 'ws:')}/api/tts-websocket`;
    wsRef.current = new WebSocket(wsUrl);

    // Initialize Web Audio API for real-time playback
    if (!audioContextRef.current) {
      audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)();
    }

    wsRef.current.onopen = () => {
      console.log("WebSocket connected");
      // Send text to server
      wsRef.current.send(JSON.stringify({
        text: text,
        voice: selectedVoice
      }));
    };

    wsRef.current.onmessage = (event) => {
      const data = JSON.parse(event.data);
      
      if (data.type === "audio_chunk") {
        // Convert base64 to audio and play
        const audioData = atob(data.data);
        const audioBuffer = new Uint8Array(audioData.length);
        for (let i = 0; i < audioData.length; i++) {
          audioBuffer[i] = audioData.charCodeAt(i);
        }
        
        // Play audio chunk (simplified - in real app you'd queue and play sequentially)
        const blob = new Blob([audioBuffer], { type: 'audio/wav' });
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audio.play().catch(console.error);
        
      } else if (data.type === "end") {
        console.log("Streaming complete");
        setIsStreaming(false);
        wsRef.current.close();
      } else if (data.error) {
        console.error("WebSocket error:", data.error);
        alert("Streaming error: " + data.error);
        setIsStreaming(false);
        wsRef.current.close();
      }
    };

    wsRef.current.onerror = (error) => {
      console.error("WebSocket error:", error);
      alert("WebSocket connection error");
      setIsStreaming(false);
    };

    wsRef.current.onclose = () => {
      console.log("WebSocket disconnected");
      setIsStreaming(false);
    };
  };

  const handleStartStreaming = () => {
    if (streamingMethod === "http") {
      handleHttpStreaming();
    } else {
      handleWebSocketStreaming();
    }
  };

  const handleStopAudio = () => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
    
    if (wsRef.current) {
      wsRef.current.close();
    }
    
    setIsPlaying(false);
    setIsStreaming(false);
  };

  const handleAudioEnded = () => {
    setIsPlaying(false);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-900 via-purple-900 to-indigo-900">
      <div className="container mx-auto px-4 py-8">
        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="text-5xl font-bold text-white mb-4 bg-gradient-to-r from-blue-400 to-purple-400 bg-clip-text text-transparent">
            🎤 Live Audio Streaming
          </h1>
          <p className="text-xl text-gray-300">
            Convert your text to speech using Gemini Live API
          </p>
        </div>

        {/* Main Content */}
        <div className="max-w-4xl mx-auto">
          <div className="bg-white/10 backdrop-blur-lg rounded-2xl p-8 shadow-2xl border border-white/20">
            
            {/* Settings */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
              {/* Voice Selection */}
              <div>
                <label className="block text-white text-sm font-medium mb-2">
                  Select Voice
                </label>
                <select
                  value={selectedVoice}
                  onChange={(e) => setSelectedVoice(e.target.value)}
                  className="w-full px-4 py-3 bg-white/20 border border-white/30 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent"
                  disabled={isStreaming}
                >
                  {voices.map((voice) => (
                    <option key={voice} value={voice} className="bg-gray-800">
                      {voice}
                    </option>
                  ))}
                </select>
              </div>

              {/* Streaming Method */}
              <div>
                <label className="block text-white text-sm font-medium mb-2">
                  Streaming Method
                </label>
                <select
                  value={streamingMethod}
                  onChange={(e) => setStreamingMethod(e.target.value)}
                  className="w-full px-4 py-3 bg-white/20 border border-white/30 rounded-lg text-white focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent"
                  disabled={isStreaming}
                >
                  <option value="http" className="bg-gray-800">HTTP Streaming</option>
                  <option value="websocket" className="bg-gray-800">WebSocket (Real-time)</option>
                </select>
              </div>
            </div>

            {/* Text Input */}
            <div className="mb-6">
              <label className="block text-white text-sm font-medium mb-2">
                Enter Text to Convert
              </label>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Type your message here... For example: Hello! Welcome to our live streaming text-to-speech application. This is powered by Google's Gemini Live API."
                className="w-full h-32 px-4 py-3 bg-white/20 border border-white/30 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent resize-none"
                disabled={isStreaming}
              />
              <div className="text-right text-gray-400 text-sm mt-1">
                {text.length} characters
              </div>
            </div>

            {/* Control Buttons */}
            <div className="flex flex-col sm:flex-row gap-4 mb-6">
              <button
                onClick={handleStartStreaming}
                disabled={isStreaming || !text.trim()}
                className="flex-1 px-6 py-4 bg-gradient-to-r from-blue-500 to-purple-600 text-white font-semibold rounded-lg shadow-lg hover:from-blue-600 hover:to-purple-700 transform hover:scale-105 transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed disabled:transform-none"
              >
                {isStreaming ? (
                  <span className="flex items-center justify-center">
                    <svg className="animate-spin -ml-1 mr-3 h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    Streaming...
                  </span>
                ) : (
                  `🎵 Start ${streamingMethod === 'http' ? 'HTTP' : 'Real-time'} Streaming`
                )}
              </button>

              <button
                onClick={handleStopAudio}
                disabled={!isPlaying && !isStreaming}
                className="px-6 py-4 bg-red-500 text-white font-semibold rounded-lg shadow-lg hover:bg-red-600 transform hover:scale-105 transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed disabled:transform-none"
              >
                🛑 Stop Audio
              </button>
            </div>

            {/* Audio Player */}
            <div className="bg-white/10 rounded-lg p-4">
              <h3 className="text-white text-lg font-medium mb-3">Audio Player</h3>
              <audio
                ref={audioRef}
                controls
                className="w-full"
                onEnded={handleAudioEnded}
                onPlay={() => setIsPlaying(true)}
                onPause={() => setIsPlaying(false)}
              >
                Your browser does not support the audio element.
              </audio>
              
              {isStreaming && (
                <div className="mt-3 text-center">
                  <div className="inline-flex items-center text-blue-400">
                    <div className="animate-pulse mr-2">🎵</div>
                    <span>
                      {streamingMethod === 'http' ? 'Generating audio...' : 'Streaming in real-time...'}
                    </span>
                  </div>
                </div>
              )}
            </div>

            {/* Info */}
            <div className="mt-6 text-center text-gray-400 text-sm">
              <p>
                ✨ Powered by Google Gemini Live API | 
                🎯 {streamingMethod === 'http' ? 'HTTP streaming for complete audio' : 'WebSocket for real-time chunks'}
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;