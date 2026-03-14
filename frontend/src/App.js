import { useEffect, useRef, useState } from "react";
import { LiveClient } from "@google/generative-ai"; // Ensure @google/generative-ai is installed

export default function App() {
  const [aiText, setAiText] = useState("");
  const [status, setStatus] = useState("Disconnected");
  const sessionRef = useRef(null);
  const recorderRef = useRef(null);
  // const [voices, setVoices] = useState([]); // Keep if /api/voices is still used
  // const [selectedVoice, setSelectedVoice] = useState("Puck"); // Keep if relevant

  // Note: The user feedback's App.js snippet does not include fetching voices
  // or selecting voices. If this functionality is still desired, it would need to be
  // merged carefully, but the primary goal here is to implement the LiveClient flow.
  // For now, implement exactly as per the snippet.

  useEffect(() => {
    // 1. Initialize the JS SDK
    if (!process.env.REACT_APP_GEMINI_API_KEY) {
      console.error("REACT_APP_GEMINI_API_KEY is not set. Please check your .env.local file.");
      setStatus("Error: API Key not set");
      return;
    }

    const client = new LiveClient({
      apiKey: process.env.REACT_APP_GEMINI_API_KEY,
      httpOptions: { apiVersion: "v1beta" },
    });

    try {
      sessionRef.current = client.live.connect({
        model: "models/gemini-2.5-flash-preview-native-audio-dialog", // User specified model
        audioConfig: {
          mimeType: "audio/webm; codecs=opus", // User specified
          sampleRateHertz: 48000, // User specified
        },
        responseConfig: {
          responseModalities: ["TEXT", "AUDIO"], // User specified
        },
      });
      setStatus("Connected to Live API");

      // 2. Subscribe to partials
      sessionRef.current.receive().subscribe(chunk => {
        if (chunk.text) {
          setAiText(prev => prev + chunk.text);
        }
        if (chunk.audio) { // chunk.audio is an ArrayBuffer
          const ctx = new AudioContext(); // Creates a new context for each chunk; consider reusing
          ctx.decodeAudioData(chunk.audio).then(buf => {
            const src = ctx.createBufferSource();
            src.buffer = buf;
            src.connect(ctx.destination);
            src.start();
          }).catch(e => console.error("Error decoding audio data:", e));
        }
      });
    } catch (error) {
        console.error("Error connecting to Live API:", error);
        setStatus("Connection Error: " + error.message);
        return; // Stop if connection fails
    }
    

    // 3. Cleanup on unmount
    return () => {
      if (sessionRef.current) {
        sessionRef.current.close();
        console.log("Live API session closed.");
      }
      if (recorderRef.current && recorderRef.current.state === "recording") {
        recorderRef.current.stop();
      }
    };
  }, []); // Empty dependency array ensures this runs once on mount and cleans up on unmount

  const startRecording = async () => {
    if (!sessionRef.current) {
      setStatus("Error: Not connected to Live API.");
      console.error("startRecording called before session is initialized.");
      return;
    }
    setStatus("Recording…");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: { // More specific audio constraints
            sampleRate: 48000, // Match session audioConfig if possible
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true
        }
      });
      const recorder = new MediaRecorder(stream, { 
        mimeType: "audio/webm; codecs=opus" // Match session audioConfig
      });
      recorderRef.current = recorder;
      recorder.ondataavailable = e => {
        if (e.data.size > 0 && sessionRef.current) {
          sessionRef.current.sendAudio(e.data); // e.data is a Blob
        }
      };
      recorder.start(100);  // 100ms chunks
    } catch (error) {
      console.error("Error starting recording:", error);
      setStatus("Mic Error: " + error.message);
    }
  };

  const stopRecording = () => {
    if (recorderRef.current && recorderRef.current.state === "recording") {
      recorderRef.current.stop();
      // The onstop event of MediaRecorder is not used here to send end_of_turn or similar.
      // The LiveClient might handle turns differently.
    }
    setStatus("Processing…"); // Or "Connected to Live API" if appropriate
  };

  // Basic UI from the user feedback
  return (
    <div>
      <h1>Emer-LivePI (Direct API)</h1>
      <p>Status: {status}</p>
      <button onClick={startRecording} disabled={status === "Recording…" || !sessionRef.current}>Talk</button>
      <button onClick={stopRecording} disabled={status !== "Recording…"}>Stop</button>
      <pre>{aiText}</pre>
    </div>
  );
}
