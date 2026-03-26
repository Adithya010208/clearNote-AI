/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { 
  Mic, 
  Square, 
  Save, 
  History, 
  Plus, 
  LogOut, 
  User as UserIcon, 
  FileText, 
  Trash2, 
  CheckCircle2, 
  AlertCircle,
  Loader2,
  ChevronRight,
  Stethoscope,
  Languages,
  Printer,
  Download,
  Search
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { GoogleGenAI, GenerateContentResponse } from "@google/genai";
import { 
  collection, 
  addDoc, 
  query, 
  where, 
  onSnapshot, 
  orderBy, 
  deleteDoc, 
  doc, 
  setDoc,
  getDocFromServer
} from 'firebase/firestore';
import { onAuthStateChanged, User } from 'firebase/auth';
import { db, auth, signIn, signOut } from './firebase';
import { cn } from './lib/utils';
import Markdown from 'react-markdown';

// --- Types ---

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId: string | undefined;
    email: string | null | undefined;
    emailVerified: boolean | undefined;
    isAnonymous: boolean | undefined;
    tenantId: string | null | undefined;
    providerInfo: {
      providerId: string;
      displayName: string | null;
      email: string | null;
      photoUrl: string | null;
    }[];
  }
}

interface SOAPNote {
  subjective: string;
  objective: string;
  assessment: string;
  plan: string;
}

interface Medication {
  name: string;
  dosage: string;
  frequency: string;
  duration: string;
}

interface ExtractedInfo {
  symptoms: string[];
  duration: string;
  diagnosis: string;
  medications: Medication[];
  predictedDisease?: string;
  icd10Code?: string;
  followUp?: string;
  patientSummary?: string;
}

interface PatientNote {
  id?: string;
  doctorId: string;
  patientName: string;
  patientAge: string;
  date: string;
  transcription: string;
  soapNote: SOAPNote;
  extractedInfo: ExtractedInfo;
}

// --- Utils ---

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData.map(provider => ({
        providerId: provider.providerId,
        displayName: provider.displayName,
        email: provider.email,
        photoUrl: provider.photoURL
      })) || []
    },
    operationType,
    path
  }
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

// --- Components ---

const ErrorBoundary = ({ children }: { children: React.ReactNode }) => {
  const [hasError, setHasError] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    const handleError = (event: ErrorEvent) => {
      try {
        const parsed = JSON.parse(event.error.message);
        if (parsed.error) {
          setErrorMsg(`Firestore Error: ${parsed.error} during ${parsed.operationType} on ${parsed.path}`);
        }
      } catch {
        setErrorMsg(event.error.message);
      }
      setHasError(true);
    };
    window.addEventListener('error', handleError);
    return () => window.removeEventListener('error', handleError);
  }, []);

  if (hasError) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-red-50 p-4">
        <div className="bg-white p-8 rounded-2xl shadow-xl max-w-md w-full border border-red-100">
          <AlertCircle className="w-12 h-12 text-red-500 mb-4" />
          <h2 className="text-2xl font-bold text-gray-900 mb-2">Something went wrong</h2>
          <p className="text-gray-600 mb-6">{errorMsg}</p>
          <button 
            onClick={() => window.location.reload()}
            className="w-full bg-red-600 text-white py-3 rounded-xl font-semibold hover:bg-red-700 transition-colors"
          >
            Reload Application
          </button>
        </div>
      </div>
    );
  }

  return <>{children}</>;
};

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isTranslating, setIsTranslating] = useState(false);
  const [exportLang, setExportLang] = useState('English');
  const [notes, setNotes] = useState<PatientNote[]>([]);
  const [currentNote, setCurrentNote] = useState<Partial<PatientNote> | null>(null);
  const [view, setView] = useState<'record' | 'history' | 'edit'>('record');
  const [showEditModal, setShowEditModal] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [recordingTime, setRecordingTime] = useState(0);
  const [consent, setConsent] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);
  const silenceTimerRef = useRef<number | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const silenceThreshold = 0.01; // Adjust based on testing
  const silenceDuration = 7000; // 7 seconds of silence to auto-stop

  // --- Auth & Firebase Init ---

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setIsAuthReady(true);
      if (u) {
        // Ensure user doc exists
        const userRef = doc(db, 'users', u.uid);
        setDoc(userRef, {
          uid: u.uid,
          email: u.email,
          displayName: u.displayName,
          photoURL: u.photoURL,
          role: 'doctor'
        }, { merge: true }).catch(e => handleFirestoreError(e, OperationType.WRITE, `users/${u.uid}`));
      }
    });

    // Connection test
    const testConnection = async () => {
      try {
        await getDocFromServer(doc(db, 'test', 'connection'));
      } catch (error) {
        if (error instanceof Error && error.message.includes('the client is offline')) {
          console.error("Please check your Firebase configuration.");
        }
      }
    };
    testConnection();

    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!user || !isAuthReady) return;

    const q = query(
      collection(db, 'notes'), 
      where('doctorId', '==', user.uid),
      orderBy('date', 'desc')
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const fetchedNotes = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      })) as PatientNote[];
      setNotes(fetchedNotes);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'notes');
    });

    return () => unsubscribe();
  }, [user, isAuthReady]);

  // --- Audio Recording ---

  const startRecording = async () => {
    if (!consent) {
      alert("Please obtain patient consent before recording.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
          sampleRate: 44100
        } 
      });

      // --- Noise Reduction Preprocessing ---
      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      const source = audioContext.createMediaStreamSource(stream);
      
      // High-pass filter to remove low-frequency hum/rumble (< 100Hz)
      const hpFilter = audioContext.createBiquadFilter();
      hpFilter.type = 'highpass';
      hpFilter.frequency.value = 100;

      // Low-pass filter to remove high-frequency hiss (> 8000Hz)
      const lpFilter = audioContext.createBiquadFilter();
      lpFilter.type = 'lowpass';
      lpFilter.frequency.value = 8000;

      // Dynamics compressor to normalize volume levels
      const compressor = audioContext.createDynamicsCompressor();
      compressor.threshold.setValueAtTime(-24, audioContext.currentTime);
      compressor.knee.setValueAtTime(40, audioContext.currentTime);
      compressor.ratio.setValueAtTime(12, audioContext.currentTime);
      compressor.attack.setValueAtTime(0, audioContext.currentTime);
      compressor.release.setValueAtTime(0.25, audioContext.currentTime);

      // Create a destination for the processed audio
      const destination = audioContext.createMediaStreamDestination();

      // Connect the chain: Source -> HP Filter -> LP Filter -> Compressor -> Destination
      source.connect(hpFilter);
      hpFilter.connect(lpFilter);
      lpFilter.connect(compressor);
      compressor.connect(destination);

      // --- Silence Detection ---
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      analyserRef.current = analyser;

      const bufferLength = analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);
      let lastSoundTime = Date.now();

      const checkSilence = () => {
        if (!isRecording) return;
        analyser.getByteTimeDomainData(dataArray);
        
        // Calculate RMS (volume)
        let sum = 0;
        for (let i = 0; i < bufferLength; i++) {
          const v = (dataArray[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / bufferLength);
        setAudioLevel(rms);

        if (rms > silenceThreshold) {
          lastSoundTime = Date.now();
        } else if (Date.now() - lastSoundTime > silenceDuration) {
          console.log("Silence detected, stopping recording...");
          stopRecording();
          return;
        }
        silenceTimerRef.current = requestAnimationFrame(checkSilence);
      };

      const mediaRecorder = new MediaRecorder(destination.stream);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        audioChunksRef.current.push(event.data);
      };

      mediaRecorder.onstop = async () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        processAudio(audioBlob);
        
        // Cleanup
        stream.getTracks().forEach(track => track.stop());
        audioContext.close();
        if (silenceTimerRef.current) cancelAnimationFrame(silenceTimerRef.current);
      };

      mediaRecorder.start();
      setIsRecording(true);
      setRecordingTime(0);
      timerRef.current = window.setInterval(() => {
        setRecordingTime(prev => prev + 1);
      }, 1000);
      silenceTimerRef.current = requestAnimationFrame(checkSilence);
    } catch (err) {
      console.error("Error accessing microphone:", err);
      alert("Could not access microphone. Please check permissions.");
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      if (timerRef.current) clearInterval(timerRef.current);
      if (silenceTimerRef.current) cancelAnimationFrame(silenceTimerRef.current);
    }
  };

  // --- AI Processing ---

  const processAudio = async (audioBlob: Blob) => {
    setIsProcessing(true);
    try {
      const reader = new FileReader();
      reader.readAsDataURL(audioBlob);
      reader.onloadend = async () => {
        const base64Audio = (reader.result as string).split(',')[1];
        
        const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
        
        const prompt = `
          You are a medical scribe. Listen to this doctor-patient conversation and:
          1. Transcribe the conversation accurately (it may be in English, Hindi, or Tamil).
          2. Generate a structured clinical note in SOAP format (Subjective, Objective, Assessment, Plan).
          3. Extract key information: Symptoms, Duration, Diagnosis (if mentioned).
          4. Extract detailed Medication information: Name, Dosage (amount), Frequency (how often), and Duration (how many days).
          5. Based on the symptoms and conversation, predict the most likely disease or condition and provide its corresponding ICD-10 code.
          6. Extract any follow-up instructions or dates mentioned.
          7. Generate a "Patient-Friendly Summary" - a 2-3 sentence explanation of the visit in simple, non-medical language for the patient.
          
          Return the response in JSON format with the following structure:
          {
            "transcription": "...",
            "soapNote": {
              "subjective": "...",
              "objective": "...",
              "assessment": "...",
              "plan": "..."
            },
            "extractedInfo": {
              "symptoms": ["..."],
              "duration": "...",
              "diagnosis": "...",
              "medications": [
                { "name": "...", "dosage": "...", "frequency": "...", "duration": "..." }
              ],
              "predictedDisease": "...",
              "icd10Code": "...",
              "followUp": "...",
              "patientSummary": "..."
            }
          }
        `;

        const response = await ai.models.generateContent({
          model: "gemini-3-flash-preview",
          contents: [
            { text: prompt },
            {
              inlineData: {
                mimeType: "audio/webm",
                data: base64Audio
              }
            }
          ],
          config: {
            responseMimeType: "application/json"
          }
        });

        const result = JSON.parse(response.text || '{}');
        setCurrentNote({
          doctorId: user?.uid,
          patientName: '',
          patientAge: '',
          date: new Date().toISOString(),
          transcription: result.transcription || '',
          soapNote: result.soapNote || { subjective: '', objective: '', assessment: '', plan: '' },
          extractedInfo: result.extractedInfo || { symptoms: [], duration: '', diagnosis: '', medications: [] }
        });
        setShowEditModal(true);
      };
    } catch (err) {
      console.error("AI Processing Error:", err);
      alert("Failed to process audio. Please try again.");
    } finally {
      setIsProcessing(false);
    }
  };

  const translateNote = async (targetLang: string) => {
    if (!currentNote) return;
    setIsTranslating(true);
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      const prompt = `
        Translate the following clinical note into ${targetLang}. 
        Keep the structure (Subjective, Objective, Assessment, Plan) and medical terms accurate.
        Return the translated note in the same JSON format:
        {
          "soapNote": {
            "subjective": "...",
            "objective": "...",
            "assessment": "...",
            "plan": "..."
          }
        }

        Note to translate:
        ${JSON.stringify(currentNote.soapNote)}
      `;

      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: [{ text: prompt }],
        config: { responseMimeType: "application/json" }
      });

      const result = JSON.parse(response.text || '{}');
      if (result.soapNote) {
        setCurrentNote({
          ...currentNote,
          soapNote: result.soapNote
        });
      }
    } catch (err) {
      console.error("Translation Error:", err);
      alert("Failed to translate note.");
    } finally {
      setIsTranslating(false);
    }
  };

  const printPrescription = () => {
    if (!currentNote) return;
    
    const printWindow = window.open('', '_blank');
    if (!printWindow) return;

    const html = `
      <html>
        <head>
          <title>Prescription - ${currentNote.patientName}</title>
          <style>
            body { font-family: 'Inter', sans-serif; padding: 40px; color: #1e293b; }
            .header { border-bottom: 2px solid #2563eb; padding-bottom: 20px; margin-bottom: 30px; display: flex; justify-content: space-between; align-items: center; }
            .hospital-name { font-size: 24px; font-weight: 800; color: #2563eb; }
            .doctor-info { text-align: right; font-size: 14px; }
            .patient-info { background: #f8fafc; padding: 20px; border-radius: 12px; margin-bottom: 30px; display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
            .section-title { font-size: 18px; font-weight: 700; margin-bottom: 15px; color: #0f172a; border-left: 4px solid #2563eb; padding-left: 10px; }
            .medication-list { list-style: none; padding: 0; }
            .medication-item { padding: 15px; border-bottom: 1px solid #e2e8f0; display: flex; justify-content: space-between; }
            .footer { margin-top: 50px; border-top: 1px solid #e2e8f0; padding-top: 20px; font-size: 12px; color: #64748b; text-align: center; }
            @media print { .no-print { display: none; } }
          </style>
        </head>
        <body>
          <div class="header">
            <div class="hospital-name">CLEARNOTE GENERAL HOSPITAL</div>
            <div class="doctor-info">
              <strong>Dr. ${user?.displayName || 'Medical Professional'}</strong><br>
              Reg No: 123456789<br>
              Date: ${new Date(currentNote.date!).toLocaleDateString()}
            </div>
          </div>
          
          <div class="patient-info">
            <div><strong>Patient:</strong> ${currentNote.patientName || 'N/A'}</div>
            <div><strong>Age/DOB:</strong> ${currentNote.patientAge || 'N/A'}</div>
            <div><strong>Diagnosis:</strong> ${currentNote.extractedInfo?.diagnosis || currentNote.extractedInfo?.predictedDisease || 'N/A'}</div>
          </div>

          <div class="section-title">PRESCRIPTION (Rx)</div>
          <table style="width: 100%; border-collapse: collapse; margin-top: 20px;">
            <thead>
              <tr style="background: #f1f5f9; text-align: left;">
                <th style="padding: 12px; border: 1px solid #e2e8f0;">Medicine</th>
                <th style="padding: 12px; border: 1px solid #e2e8f0;">Dosage</th>
                <th style="padding: 12px; border: 1px solid #e2e8f0;">Frequency</th>
                <th style="padding: 12px; border: 1px solid #e2e8f0;">Duration</th>
              </tr>
            </thead>
            <tbody>
              ${currentNote.extractedInfo?.medications.map(m => `
                <tr>
                  <td style="padding: 12px; border: 1px solid #e2e8f0; font-weight: 600;">${m.name}</td>
                  <td style="padding: 12px; border: 1px solid #e2e8f0;">${m.dosage}</td>
                  <td style="padding: 12px; border: 1px solid #e2e8f0;">${m.frequency}</td>
                  <td style="padding: 12px; border: 1px solid #e2e8f0;">${m.duration}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>

          <div class="footer">
            This is a computer-generated prescription. Please consult your doctor before taking any medication.
          </div>
          
          <script>
            window.onload = () => { window.print(); };
          </script>
        </body>
      </html>
    `;

    printWindow.document.write(html);
    printWindow.document.close();
  };

  const downloadNote = async () => {
    if (!currentNote) return;
    
    let noteToExport = currentNote;
    
    // If the export language is different from the current one, we might want to translate
    // But for simplicity and speed, we'll export the CURRENTLY VIEWED note.
    // The user can translate it first using the UI buttons.
    
    const content = `
CLEARNOTE AI - CLINICAL NOTE
---------------------------
Date: ${new Date(noteToExport.date!).toLocaleString()}
Patient: ${noteToExport.patientName || 'N/A'}
Age/DOB: ${noteToExport.patientAge || 'N/A'}

DIAGNOSIS / PREDICTION:
${noteToExport.extractedInfo?.diagnosis || noteToExport.extractedInfo?.predictedDisease || 'N/A'}

SOAP NOTE:
[SUBJECTIVE]
${noteToExport.soapNote?.subjective}

[OBJECTIVE]
${noteToExport.soapNote?.objective}

[ASSESSMENT]
${noteToExport.soapNote?.assessment}

[PLAN]
${noteToExport.soapNote?.plan}

EXTRACTED INFO:
Symptoms: ${noteToExport.extractedInfo?.symptoms.join(', ')}
Medications:
${noteToExport.extractedInfo?.medications.map(m => `- ${m.name}: ${m.dosage}, ${m.frequency} for ${m.duration}`).join('\n')}

---------------------------
Generated by ClearNote AI
    `.trim();

    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ClearNote_${noteToExport.patientName || 'Patient'}_${new Date().toISOString().split('T')[0]}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const printPatientLeaflet = () => {
    if (!currentNote) return;
    
    const printWindow = window.open('', '_blank');
    if (!printWindow) return;

    const html = `
      <html>
        <head>
          <title>Patient Summary - ${currentNote.patientName}</title>
          <style>
            body { font-family: 'Inter', sans-serif; padding: 40px; color: #1e293b; line-height: 1.6; }
            .header { border-bottom: 2px solid #10b981; padding-bottom: 20px; margin-bottom: 30px; }
            .hospital-name { font-size: 20px; font-weight: 800; color: #10b981; }
            .title { font-size: 28px; font-weight: 800; margin: 20px 0; color: #0f172a; }
            .card { background: #f0fdf4; padding: 25px; border-radius: 16px; margin-bottom: 30px; border: 1px solid #dcfce7; }
            .section-title { font-size: 16px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; color: #059669; margin-bottom: 10px; }
            .summary-text { font-size: 18px; color: #064e3b; }
            .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 30px; }
            .info-item { background: #f8fafc; padding: 15px; border-radius: 12px; border: 1px solid #e2e8f0; }
            .med-table { width: 100%; border-collapse: collapse; margin-top: 10px; }
            .med-table th { text-align: left; font-size: 12px; color: #64748b; padding: 8px; }
            .med-table td { padding: 12px 8px; border-bottom: 1px solid #e2e8f0; font-size: 14px; }
            .footer { margin-top: 50px; text-align: center; font-size: 12px; color: #94a3b8; }
          </style>
        </head>
        <body>
          <div class="header">
            <div class="hospital-name">CLEARNOTE GENERAL HOSPITAL</div>
          </div>
          
          <div class="title">Your Visit Summary</div>
          
          <div class="info-grid">
            <div class="info-item">
              <div class="section-title">Patient</div>
              <strong>${currentNote.patientName}</strong>
            </div>
            <div class="info-item">
              <div class="section-title">Date</div>
              <strong>${new Date(currentNote.date!).toLocaleDateString()}</strong>
            </div>
          </div>

          <div class="card">
            <div class="section-title">What we discussed</div>
            <div class="summary-text">${currentNote.extractedInfo?.patientSummary || 'No summary available.'}</div>
          </div>

          <div class="info-item" style="margin-bottom: 30px; border-left: 5px solid #ef4444;">
            <div class="section-title" style="color: #ef4444;">Follow-up Instructions</div>
            <strong style="font-size: 18px;">${currentNote.extractedInfo?.followUp || 'No specific follow-up mentioned.'}</strong>
          </div>

          <div class="section-title">Your Medications</div>
          <table class="med-table">
            <thead>
              <tr>
                <th>Medicine</th>
                <th>How much</th>
                <th>When</th>
                <th>For how long</th>
              </tr>
            </thead>
            <tbody>
              ${currentNote.extractedInfo?.medications.map(m => `
                <tr>
                  <td><strong>${m.name}</strong></td>
                  <td>${m.dosage}</td>
                  <td>${m.frequency}</td>
                  <td>${m.duration}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>

          <div class="footer">
            This summary is for your information. If you feel worse or have questions, please call us immediately.
          </div>
          
          <script>
            window.onload = () => { window.print(); };
          </script>
        </body>
      </html>
    `;

    printWindow.document.write(html);
    printWindow.document.close();
  };

  const saveNote = async () => {
    if (!currentNote || !user) return;
    try {
      const noteToSave = {
        ...currentNote,
        doctorId: user.uid,
        date: currentNote.date || new Date().toISOString()
      };
      
      if (currentNote.id) {
        await setDoc(doc(db, 'notes', currentNote.id), noteToSave);
      } else {
        await addDoc(collection(db, 'notes'), noteToSave);
      }
      
      setShowEditModal(false);
      setView('history');
      setCurrentNote(null);
      setConsent(false);
    } catch (e) {
      handleFirestoreError(e, OperationType.WRITE, 'notes');
    }
  };

  const deleteNote = async (id: string) => {
    if (!confirm("Are you sure you want to delete this note?")) return;
    try {
      await deleteDoc(doc(db, 'notes', id));
    } catch (e) {
      handleFirestoreError(e, OperationType.DELETE, `notes/${id}`);
    }
  };

  // --- UI Helpers ---

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  if (!isAuthReady) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-slate-50 p-4">
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-white p-10 rounded-3xl shadow-2xl max-w-md w-full text-center border border-slate-100"
        >
          <div className="w-20 h-20 bg-blue-600 rounded-2xl flex items-center justify-center mx-auto mb-6 shadow-lg shadow-blue-200">
            <Stethoscope className="w-12 h-12 text-white" />
          </div>
          <h1 className="text-4xl font-black text-slate-900 mb-2 tracking-tight">ClearNote AI</h1>
          <p className="text-slate-500 mb-10 text-lg">Intelligent clinical documentation for modern doctors.</p>
          <button 
            onClick={signIn}
            className="w-full flex items-center justify-center gap-3 bg-slate-900 text-white py-4 rounded-2xl font-bold text-lg hover:bg-slate-800 focus:ring-4 focus:ring-slate-200 outline-none transition-all active:scale-95 shadow-xl shadow-slate-200"
          >
            <UserIcon className="w-6 h-6" />
            Sign in as Doctor
          </button>
          <p className="mt-6 text-xs text-slate-400 uppercase tracking-widest font-semibold">Secure & HIPAA Compliant</p>
        </motion.div>
      </div>
    );
  }

  return (
    <ErrorBoundary>
      <div className="min-h-screen bg-slate-50 flex flex-col font-sans text-slate-900">
        {/* Header */}
        <header className="bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between sticky top-0 z-10">
          <div className="flex items-center gap-3 cursor-pointer" onClick={() => setView('record')}>
            <div className="w-10 h-10 bg-blue-600 rounded-xl flex items-center justify-center shadow-md shadow-blue-100">
              <Stethoscope className="w-6 h-6 text-white" />
            </div>
            <span className="text-xl font-black tracking-tighter">ClearNote AI</span>
          </div>
          
          <div className="flex items-center gap-4">
            <button 
              onClick={() => setView('history')}
              className={cn(
                "p-2 rounded-xl transition-all outline-none focus:ring-2 focus:ring-blue-200",
                view === 'history' ? "bg-blue-50 text-blue-600" : "text-slate-500 hover:bg-slate-100 hover:text-slate-700"
              )}
            >
              <History className="w-6 h-6" />
            </button>
            <div className="h-8 w-[1px] bg-slate-200 mx-1" />
            <button 
              onClick={signOut}
              className="flex items-center gap-2 text-slate-500 hover:text-red-600 transition-all font-semibold outline-none focus:text-red-600"
            >
              <LogOut className="w-5 h-5" />
              <span className="hidden sm:inline">Sign Out</span>
            </button>
          </div>
        </header>

        <main className="flex-1 max-w-5xl w-full mx-auto p-6 relative">
          <AnimatePresence mode="wait">
            {view === 'record' && (
              <motion.div 
                key="record"
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                className="h-full flex flex-col items-center justify-center py-12"
              >
                <div className="text-center mb-12">
                  <h2 className="text-3xl font-bold mb-3">New Consultation</h2>
                  <p className="text-slate-500">Record conversation to generate structured SOAP notes.</p>
                </div>

                <div className="relative mb-12 flex flex-col items-center">
                  <AnimatePresence>
                    {isRecording && (
                      <div className="absolute -top-20 flex items-end gap-1 h-16">
                        {[...Array(20)].map((_, i) => (
                          <motion.div
                            key={i}
                            animate={{ 
                              height: [10, Math.max(10, audioLevel * 200 * Math.random()), 10] 
                            }}
                            transition={{ 
                              repeat: Infinity, 
                              duration: 0.5, 
                              delay: i * 0.05 
                            }}
                            className="w-1.5 bg-blue-500 rounded-full"
                          />
                        ))}
                      </div>
                    )}
                  </AnimatePresence>
                  
                  <button 
                    onClick={isRecording ? stopRecording : startRecording}
                    disabled={isProcessing}
                    className={cn(
                      "relative w-40 h-40 rounded-full flex flex-col items-center justify-center gap-2 transition-all active:scale-95 shadow-2xl outline-none focus:ring-8",
                      isRecording 
                        ? "bg-red-500 text-white shadow-red-200 focus:ring-red-100" 
                        : "bg-blue-600 text-white shadow-blue-200 hover:bg-blue-700 focus:ring-blue-100",
                      isProcessing && "opacity-50 cursor-not-allowed"
                    )}
                  >
                    {isProcessing ? (
                      <Loader2 className="w-12 h-12 animate-spin" />
                    ) : isRecording ? (
                      <>
                        <Square className="w-12 h-12 fill-current" />
                        <span className="font-bold text-lg">{formatTime(recordingTime)}</span>
                        <div className="absolute -bottom-8 left-1/2 -translate-x-1/2 flex items-center gap-1.5 bg-green-100 text-green-700 px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest border border-green-200 shadow-sm whitespace-nowrap">
                          <CheckCircle2 className="w-3 h-3" />
                          Noise Reduction & Auto-Stop Active
                        </div>
                      </>
                    ) : (
                      <>
                        <Mic className="w-12 h-12" />
                        <span className="font-bold text-lg">Start</span>
                      </>
                    )}
                  </button>
                </div>

                <div className="max-w-md w-full bg-white p-6 rounded-2xl border border-slate-200 shadow-sm">
                  <label className="flex items-start gap-4 cursor-pointer group">
                    <div className="relative flex items-center">
                      <input 
                        type="checkbox" 
                        checked={consent}
                        onChange={(e) => setConsent(e.target.checked)}
                        className="peer sr-only"
                      />
                      <div className="w-6 h-6 border-2 border-slate-300 rounded-md peer-checked:bg-blue-600 peer-checked:border-blue-600 transition-all" />
                      <CheckCircle2 className="absolute w-4 h-4 text-white opacity-0 peer-checked:opacity-100 left-1 transition-opacity" />
                    </div>
                    <span className="text-sm text-slate-600 leading-tight group-hover:text-slate-900 transition-colors">
                      I have obtained explicit verbal consent from the patient to record this conversation for clinical documentation purposes.
                    </span>
                  </label>
                </div>
              </motion.div>
            )}

            {view === 'history' && (
              <motion.div 
                key="history"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                className="space-y-6 sm:space-y-8"
              >
                <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                  <div>
                    <h2 className="text-2xl sm:text-3xl font-bold">Consultation History</h2>
                    <p className="text-slate-500 text-sm sm:text-base">Access and manage all your past patient notes.</p>
                  </div>
                  <div className="flex flex-col sm:flex-row gap-3">
                    <div className="relative w-full sm:w-64">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                      <input 
                        type="text"
                        placeholder="Search patients..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="w-full pl-10 pr-4 py-2.5 sm:py-3 bg-white border border-slate-200 rounded-xl text-sm outline-none focus:ring-4 focus:ring-blue-50"
                      />
                    </div>
                    <button 
                      onClick={() => setView('record')}
                      className="flex items-center justify-center gap-2 px-6 py-2.5 sm:py-3 bg-blue-600 text-white rounded-xl font-bold hover:bg-blue-700 focus:ring-4 focus:ring-blue-100 transition-all shadow-lg shadow-blue-100 outline-none"
                    >
                      <Plus className="w-5 h-5" />
                      New Consultation
                    </button>
                  </div>
                </div>

                {/* Quick Stats */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
                  <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm">
                    <p className="text-xs font-black text-slate-400 uppercase tracking-widest mb-1">Total Notes</p>
                    <p className="text-3xl font-bold text-slate-900">{notes.length}</p>
                  </div>
                  <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm">
                    <p className="text-xs font-black text-slate-400 uppercase tracking-widest mb-1">This Week</p>
                    <p className="text-3xl font-bold text-blue-600">
                      {notes.filter(n => {
                        const date = new Date(n.date);
                        const now = new Date();
                        const diff = (now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24);
                        return diff <= 7;
                      }).length}
                    </p>
                  </div>
                  <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm">
                    <p className="text-xs font-black text-slate-400 uppercase tracking-widest mb-1">Avg. Duration</p>
                    <p className="text-3xl font-bold text-emerald-600">4.2m</p>
                  </div>
                </div>

                {notes.length === 0 ? (
                  <div className="bg-white p-20 rounded-3xl border border-dashed border-slate-300 text-center">
                    <History className="w-16 h-16 text-slate-200 mx-auto mb-4" />
                    <h3 className="text-xl font-bold text-slate-400">No notes found</h3>
                    <p className="text-slate-400">Start a new consultation to see notes here.</p>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-6">
                    {notes
                      .filter(n => 
                        n.patientName.toLowerCase().includes(searchQuery.toLowerCase()) ||
                        n.extractedInfo?.diagnosis.toLowerCase().includes(searchQuery.toLowerCase()) ||
                        n.extractedInfo?.predictedDisease?.toLowerCase().includes(searchQuery.toLowerCase())
                      )
                      .map((note) => (
                      <motion.div 
                        key={note.id}
                        layout
                        className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm hover:shadow-md transition-shadow group"
                      >
                        <div className="flex justify-between items-start mb-4">
                          <div>
                            <h3 className="text-xl font-bold text-slate-900">
                              {note.patientName || 'Unnamed Patient'}
                            </h3>
                            <p className="text-sm text-slate-500 font-medium">
                              {new Date(note.date).toLocaleDateString()} • {new Date(note.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                            </p>
                          </div>
                          <button 
                            onClick={() => deleteNote(note.id!)}
                            className="p-2 text-slate-300 hover:text-red-500 hover:bg-red-50 rounded-lg transition-all outline-none focus:ring-2 focus:ring-red-100"
                          >
                            <Trash2 className="w-5 h-5" />
                          </button>
                        </div>

                        <div className="space-y-3 mb-6">
                          <div className="flex items-center gap-2 text-sm text-slate-600">
                            <AlertCircle className="w-4 h-4 text-blue-500" />
                            <span className="font-semibold">Assessment:</span>
                            <span className="truncate">{note.soapNote.assessment}</span>
                          </div>
                          <div className="flex items-center gap-2 text-sm text-slate-600">
                            <CheckCircle2 className="w-4 h-4 text-green-500" />
                            <span className="font-semibold">Plan:</span>
                            <span className="truncate">{note.soapNote.plan}</span>
                          </div>
                        </div>

                        <button 
                          onClick={() => { setCurrentNote(note); setShowEditModal(true); }}
                          className="w-full flex items-center justify-center gap-2 py-3 bg-slate-50 text-slate-900 rounded-xl font-bold group-hover:bg-blue-600 group-hover:text-white transition-all outline-none focus:ring-2 focus:ring-blue-100"
                        >
                          View Details
                          <ChevronRight className="w-4 h-4" />
                        </button>
                      </motion.div>
                    ))}
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>

          {/* Processing Overlay */}
          <AnimatePresence>
            {isProcessing && (
              <motion.div 
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="fixed inset-0 z-50 bg-white/80 backdrop-blur-md flex flex-col items-center justify-center p-6 text-center"
              >
                <div className="relative mb-8">
                  <motion.div 
                    animate={{ rotate: 360 }}
                    transition={{ repeat: Infinity, duration: 2, ease: "linear" }}
                    className="w-24 h-24 border-4 border-blue-100 border-t-blue-600 rounded-full"
                  />
                  <Stethoscope className="absolute inset-0 m-auto w-10 h-10 text-blue-600" />
                </div>
                <motion.h2 
                  animate={{ opacity: [0.5, 1, 0.5] }}
                  transition={{ repeat: Infinity, duration: 1.5 }}
                  className="text-2xl font-bold text-slate-900 mb-2"
                >
                  Analyzing Conversation...
                </motion.h2>
                <p className="text-slate-500 max-w-xs">Our AI is transcribing and structuring your clinical notes. This usually takes less than 5 seconds.</p>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Edit Modal (Final Approval) */}
          <AnimatePresence>
            {showEditModal && currentNote && (
              <motion.div 
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center p-4 sm:p-6"
              >
                <motion.div 
                  initial={{ scale: 0.95, y: 20 }}
                  animate={{ scale: 1, y: 0 }}
                  exit={{ scale: 0.95, y: 20 }}
                  className="bg-slate-50 w-full max-w-5xl max-h-[90vh] rounded-3xl shadow-2xl overflow-hidden flex flex-col"
                >
                  {/* Modal Header */}
                  <div className="bg-white border-b border-slate-200 px-4 sm:px-8 py-4 sm:py-6 flex flex-col md:flex-row md:items-center justify-between shrink-0 gap-4">
                    <div>
                      <h2 className="text-xl sm:text-2xl font-bold flex items-center gap-2">
                        <FileText className="w-5 h-5 sm:w-6 h-6 text-blue-600" />
                        Final Clinical Report
                      </h2>
                      <p className="text-slate-500 text-xs sm:text-sm">Please review and approve the generated note before saving.</p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 sm:gap-3">
                      <div className="flex items-center bg-white border border-slate-200 rounded-xl px-2">
                        <Languages className="w-4 h-4 text-slate-400 mr-2" />
                        <select 
                          value={exportLang}
                          onChange={(e) => {
                            setExportLang(e.target.value);
                            translateNote(e.target.value);
                          }}
                          className="bg-transparent py-2 text-xs font-bold outline-none cursor-pointer"
                        >
                          <option value="English">English</option>
                          <option value="Hindi">Hindi</option>
                          <option value="Tamil">Tamil</option>
                          <option value="Telugu">Telugu</option>
                          <option value="Malayalam">Malayalam</option>
                          <option value="Kannada">Kannada</option>
                          <option value="Bengali">Bengali</option>
                          <option value="Marathi">Marathi</option>
                        </select>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <button 
                          onClick={downloadNote}
                          title="Export .txt"
                          className="flex items-center gap-2 px-3 sm:px-4 py-2 bg-white border border-slate-200 text-slate-700 rounded-xl font-bold hover:bg-slate-50 transition-all outline-none focus:ring-2 focus:ring-slate-100 text-xs sm:text-sm"
                        >
                          <Download className="w-4 h-4 sm:w-5 h-5" />
                          <span className="hidden sm:inline">Export</span>
                        </button>
                        <button 
                          onClick={printPrescription}
                          title="Print Rx"
                          className="flex items-center gap-2 px-3 sm:px-4 py-2 bg-white border border-slate-200 text-slate-700 rounded-xl font-bold hover:bg-slate-50 transition-all outline-none focus:ring-2 focus:ring-slate-100 text-xs sm:text-sm"
                        >
                          <Printer className="w-4 h-4 sm:w-5 h-5" />
                          <span className="hidden sm:inline">Print Rx</span>
                        </button>
                        <button 
                          onClick={printPatientLeaflet}
                          title="Patient Leaflet"
                          className="flex items-center gap-2 px-3 sm:px-4 py-2 bg-emerald-50 border border-emerald-100 text-emerald-700 rounded-xl font-bold hover:bg-emerald-100 transition-all outline-none focus:ring-2 focus:ring-emerald-100 text-xs sm:text-sm"
                        >
                          <FileText className="w-4 h-4 sm:w-5 h-5" />
                          <span className="hidden sm:inline">Leaflet</span>
                        </button>
                      </div>
                      <div className="flex gap-2 ml-auto">
                        <button 
                          onClick={() => { setShowEditModal(false); setCurrentNote(null); }}
                          className="px-3 sm:px-5 py-2 rounded-xl font-semibold text-slate-600 hover:bg-slate-100 hover:text-slate-900 transition-all outline-none focus:ring-2 focus:ring-slate-200 text-xs sm:text-sm"
                        >
                          Discard
                        </button>
                        <button 
                          onClick={saveNote}
                          className="flex items-center gap-2 px-4 sm:px-8 py-2 bg-blue-600 text-white rounded-xl font-bold hover:bg-blue-700 focus:ring-4 focus:ring-blue-100 transition-all shadow-lg shadow-blue-100 outline-none text-xs sm:text-sm"
                        >
                          <CheckCircle2 className="w-4 h-4 sm:w-5 h-5" />
                          <span className="hidden sm:inline">Approve & Save</span>
                          <span className="sm:hidden">Save</span>
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="flex-1 overflow-y-auto p-4 sm:p-8">
                    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 sm:gap-8">
                      {/* Left Column */}
                      <div className="space-y-6">
                        <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm space-y-4">
                          <h3 className="font-bold text-slate-400 uppercase text-xs tracking-widest">Patient Details</h3>
                          <div className="space-y-4">
                            <div>
                              <label className="block text-sm font-semibold text-slate-600 mb-1">Name</label>
                              <input 
                                type="text" 
                                value={currentNote.patientName}
                                onChange={(e) => setCurrentNote({...currentNote, patientName: e.target.value})}
                                placeholder="Enter patient name"
                                className="w-full p-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 outline-none transition-all"
                              />
                            </div>
                            <div>
                              <label className="block text-sm font-semibold text-slate-600 mb-1">Age / DOB</label>
                              <input 
                                type="text" 
                                value={currentNote.patientAge}
                                onChange={(e) => setCurrentNote({...currentNote, patientAge: e.target.value})}
                                placeholder="e.g. 45y"
                                className="w-full p-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 outline-none transition-all"
                              />
                            </div>
                          </div>
                        </div>

                        <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm space-y-4">
                          <h3 className="font-bold text-slate-400 uppercase text-xs tracking-widest">Extracted Highlights</h3>
                          <div className="space-y-4">
                            <div>
                              <label className="block text-sm font-semibold text-slate-600 mb-1">Symptoms</label>
                              <div className="flex flex-wrap gap-2">
                                {currentNote.extractedInfo?.symptoms.map((s, i) => (
                                  <span key={i} className="px-3 py-1 bg-blue-50 text-blue-700 rounded-lg text-xs font-bold">{s}</span>
                                ))}
                              </div>
                            </div>
                            <div>
                              <label className="block text-sm font-semibold text-slate-600 mb-1">Predicted Disease & ICD-10</label>
                              <div className="p-3 bg-red-50 border border-red-100 text-red-700 rounded-xl font-bold text-sm flex flex-col gap-1">
                                <div className="flex items-center gap-2">
                                  <AlertCircle className="w-4 h-4" />
                                  {currentNote.extractedInfo?.predictedDisease || 'Analyzing...'}
                                </div>
                                {currentNote.extractedInfo?.icd10Code && (
                                  <span className="text-[10px] opacity-70 ml-6">ICD-10: {currentNote.extractedInfo.icd10Code}</span>
                                )}
                              </div>
                            </div>
                            <div>
                              <label className="block text-sm font-semibold text-slate-600 mb-1">Follow-up Instructions</label>
                              <div className="p-3 bg-blue-50 border border-blue-100 text-blue-700 rounded-xl font-bold text-sm flex items-center gap-2">
                                <ChevronRight className="w-4 h-4" />
                                {currentNote.extractedInfo?.followUp || 'No follow-up mentioned.'}
                              </div>
                            </div>
                            <div>
                              <label className="block text-sm font-semibold text-slate-600 mb-1">Patient-Friendly Summary</label>
                              <div className="p-4 bg-emerald-50 border border-emerald-100 text-emerald-800 rounded-xl text-sm italic leading-relaxed">
                                "{currentNote.extractedInfo?.patientSummary || 'Generating summary...'}"
                              </div>
                            </div>
                            <div>
                              <label className="block text-sm font-semibold text-slate-600 mb-1">Medications</label>
                              <div className="overflow-x-auto">
                                <table className="w-full text-sm text-left text-slate-700 border-collapse">
                                  <thead>
                                    <tr className="bg-slate-100 text-[10px] uppercase font-black tracking-widest text-slate-400">
                                      <th className="p-2 border border-slate-200">Name</th>
                                      <th className="p-2 border border-slate-200">Dose</th>
                                      <th className="p-2 border border-slate-200">Freq</th>
                                      <th className="p-2 border border-slate-200">Days</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {currentNote.extractedInfo?.medications.map((m, i) => (
                                      <tr key={i} className="hover:bg-slate-50 transition-colors">
                                        <td className="p-2 border border-slate-200 font-bold">{m.name}</td>
                                        <td className="p-2 border border-slate-200">{m.dosage}</td>
                                        <td className="p-2 border border-slate-200">{m.frequency}</td>
                                        <td className="p-2 border border-slate-200">{m.duration}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* Right Column */}
                      <div className="lg:col-span-2 space-y-6">
                        <div className="bg-white p-8 rounded-2xl border border-slate-200 shadow-sm space-y-8">
                          {(['subjective', 'objective', 'assessment', 'plan'] as const).map((part) => (
                            <div key={part} className="space-y-2">
                              <label className="block text-sm font-black text-slate-400 uppercase tracking-widest">{part}</label>
                              <textarea 
                                value={currentNote.soapNote?.[part]}
                                onChange={(e) => setCurrentNote({
                                  ...currentNote, 
                                  soapNote: { ...currentNote.soapNote!, [part]: e.target.value }
                                })}
                                rows={3}
                                className="w-full p-4 bg-slate-50 border border-slate-200 rounded-2xl focus:ring-2 focus:ring-blue-500 outline-none transition-all resize-none"
                              />
                            </div>
                          ))}
                        </div>

                        <div className="bg-slate-900 text-slate-300 p-8 rounded-2xl">
                          <h3 className="text-white font-bold mb-4 flex items-center gap-2">
                            <Mic className="w-5 h-5" />
                            Full Transcription
                          </h3>
                          <div className="max-h-40 overflow-y-auto pr-4 text-sm leading-relaxed opacity-70">
                            {currentNote.transcription}
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </motion.div>
              </motion.div>
            )}
          </AnimatePresence>
        </main>

        {/* Footer info */}
        <footer className="p-6 text-center text-slate-400 text-xs uppercase tracking-widest font-semibold">
          ClearNote AI • Secure Clinical Documentation System
        </footer>
      </div>
    </ErrorBoundary>
  );
}
