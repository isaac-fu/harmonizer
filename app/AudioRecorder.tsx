import { useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, LoaderCircle, Mic, Square } from 'lucide-react';
import { MAX_DURATION_SECONDS, MAX_UPLOAD_BYTES } from './shared/types';

type RecorderState = 'idle' | 'requesting' | 'recording' | 'converting';
const recordingTypes = [
  { mime: 'audio/webm;codecs=opus', extension: 'webm' },
  { mime: 'audio/ogg;codecs=opus', extension: 'ogg' },
  { mime: 'audio/mp4', extension: 'mp4' },
];

export default function AudioRecorder({ disabled, onRecorded, onBusyChange, onError, purpose = 'source', partLabel = '' }: {
  disabled: boolean;
  onRecorded: (file: File, signal: AbortSignal) => void | Promise<void>;
  onBusyChange: (busy: boolean) => void;
  onError: (message: string) => void;
  purpose?: 'source' | 'practice';
  partLabel?: string;
}) {
  const [state, setState] = useState<RecorderState>('idle');
  const [seconds, setSeconds] = useState(0);
  const [pending, setPending] = useState<{ blob: Blob; extension: string } | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const callbacks = useRef({ onRecorded, onBusyChange, onError });
  callbacks.current = { onRecorded, onBusyChange, onError };

  function releaseMicrophone() {
    clearInterval(timer.current);
    stream.current?.getTracks().forEach(track => track.stop());
    stream.current = null;
  }

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
      if (recorder.current?.state !== 'inactive') recorder.current?.stop();
      releaseMicrophone();
    };
  }, []);

  async function convert(recording: { blob: Blob; extension: string }) {
    setState('converting');
    callbacks.current.onBusyChange(true);
    const abort = new AbortController();
    controller.current = abort;
    try {
      const data = new FormData();
      data.append('file', recording.blob, `recording.${recording.extension}`);
      const response = await fetch('/api/recordings', { method: 'POST', body: data, signal: abort.signal });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || 'Could not convert your recording. Please try again.');
      }
      const mp3 = await response.blob();
      if (!mounted.current) return;
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      await callbacks.current.onRecorded(new File([mp3], `recording-${stamp}.mp3`, { type: 'audio/mpeg' }), abort.signal);
      if (!mounted.current) return;
      setPending(null);
    } catch (error) {
      if (!abort.signal.aborted && mounted.current) callbacks.current.onError(error instanceof Error ? error.message : 'Recording conversion failed.');
    } finally {
      if (mounted.current) { setState('idle'); callbacks.current.onBusyChange(false); }
    }
  }

  function stop() {
    if (recorder.current?.state === 'recording') {
      setState('converting');
      recorder.current.stop();
      releaseMicrophone();
    }
  }

  async function start() {
    if (disabled || state !== 'idle') return;
    callbacks.current.onError('');
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      callbacks.current.onError('Microphone recording needs a supported browser on localhost or HTTPS.'); return;
    }
    const format = recordingTypes.find(type => MediaRecorder.isTypeSupported(type.mime));
    if (!format) { callbacks.current.onError('Your browser cannot record a supported audio format. Try Chrome, Edge, Firefox, or Safari.'); return; }
    setState('requesting');
    callbacks.current.onBusyChange(true);
    try {
      const microphone = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!mounted.current) { microphone.getTracks().forEach(track => track.stop()); return; }
      stream.current = microphone;
      const capture = new MediaRecorder(microphone, { mimeType: format.mime, audioBitsPerSecond: 128000 });
      recorder.current = capture;
      const chunks: Blob[] = [];
      let bytes = 0;
      let failed = false;
      capture.ondataavailable = event => {
        if (event.data.size > 0) { chunks.push(event.data); bytes += event.data.size; }
        if (bytes >= MAX_UPLOAD_BYTES && capture.state === 'recording') stop();
      };
      capture.onerror = () => {
        failed = true;
        releaseMicrophone();
        if (capture.state !== 'inactive') capture.stop();
        if (mounted.current) {
          setState('idle'); callbacks.current.onBusyChange(false);
          callbacks.current.onError('The microphone stopped unexpectedly. Please try recording again.');
        }
      };
      capture.onstop = () => {
        releaseMicrophone();
        if (!mounted.current || failed) return;
        if (bytes === 0 || bytes > MAX_UPLOAD_BYTES) {
          setState('idle'); callbacks.current.onBusyChange(false);
          callbacks.current.onError(bytes === 0 ? 'No audio was captured. Please try recording again.' : 'The recording exceeded 50 MB. Please record a shorter take.');
          return;
        }
        const recording = { blob: new Blob(chunks, { type: capture.mimeType }), extension: format.extension };
        setPending(recording);
        void convert(recording);
      };
      microphone.getAudioTracks().forEach(track => { track.onended = stop; });
      capture.start(1000);
      setPending(null);
      setSeconds(0);
      setState('recording');
      const startedAt = Date.now();
      timer.current = setInterval(() => {
        const elapsed = Math.floor((Date.now() - startedAt) / 1000);
        setSeconds(Math.min(elapsed, MAX_DURATION_SECONDS));
        // Leave a little headroom for the encoder's final audio frame.
        if (elapsed >= MAX_DURATION_SECONDS - 1) stop();
      }, 250);
    } catch (error) {
      releaseMicrophone();
      if (!mounted.current) return;
      setState('idle'); callbacks.current.onBusyChange(false);
      const name = error instanceof Error ? error.name : '';
      callbacks.current.onError(name === 'NotAllowedError' ? 'Microphone access was denied. Allow microphone access in your browser, then try again.'
        : name === 'NotFoundError' ? 'No microphone was found. Connect one and try again.'
        : 'The microphone could not be started. Check that it is connected and available.');
    }
  }

  async function downloadTake() {
    if (!pending) return;
    const url = URL.createObjectURL(pending.blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `recording.${pending.extension}`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return <div className={`recorder ${state === 'recording' ? 'is-recording' : ''}`}>
    {purpose === 'source' && <div className="recording-divider"><span />or record it here<span /></div>}
    <div className="recorder-controls">
      <div className="recorder-description"><strong>{state === 'recording' ? <><span className="recording-dot" /> Recording</> : purpose === 'practice' ? 'Sing this part yourself' : 'Have a melody in mind?'}</strong><span>{state === 'recording' ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} / 10:00` : state === 'requesting' ? 'Waiting for microphone permission…' : state === 'converting' ? 'Preparing your MP3…' : 'Use your microphone. Up to 10 minutes.'}</span></div>
      <button type="button" className={`record-button ${state === 'recording' ? 'stop-button' : ''}`} disabled={disabled || state === 'requesting' || state === 'converting'} onClick={() => state === 'recording' ? stop() : void start()}>
        {state === 'recording' ? <Square size={13} fill="currentColor" /> : state === 'idle' ? <Mic size={15} /> : <LoaderCircle className="spin" size={15} />}{state === 'recording' ? 'Stop recording' : state === 'requesting' ? 'Connecting…' : state === 'converting' ? 'Converting…' : purpose === 'practice' ? `Record ${partLabel}` : 'Record audio'}
      </button>
    </div>
    <p className="recorder-note" role="status">{purpose === 'practice' ? state === 'recording' ? 'Click Stop when you’re done. This saves your own voice for this part.' : state === 'converting' ? 'Preparing and saving your unshifted vocal take…' : 'Listen to the guide, then record. A new take replaces your previous take for this part.' : state === 'recording' ? 'Click Stop when you’re done. Your take will become the selected MP3.' : state === 'converting' ? 'Converting your take to MP3 and selecting it automatically.' : 'After you stop, your recording is converted to MP3 automatically.'}</p>
    {pending && state === 'idle' && <div className="recording-recovery"><span>Your take is still available.</span><button type="button" disabled={disabled} onClick={() => void convert(pending)}>Retry conversion</button><button type="button" onClick={() => void downloadTake()}><ArrowDownToLine size={12} /> Save raw take</button></div>}
  </div>;
}
