import { useEffect, useRef, useState, type DragEvent } from 'react';
import { ArrowDownToLine, ArrowRight, AudioLines, Check, ChevronRight, CircleHelp, FileAudio, Headphones, Layers3, LoaderCircle, Music2, Pause, Play, Plus, Sparkles, Upload, X } from 'lucide-react';
import { HARMONY_STYLES, MAX_UPLOAD_BYTES, VOICE_RANGES, type AccountUser, type AudioTrack, type HarmonyJob, type HarmonyMode, type HarmonyStyle, type PartCount, type RangeSelection } from './shared/types';
import AudioRecorder from './AudioRecorder';
import AccountPanel from './AccountPanel';
import PracticeStudio from './PracticeStudio';

const partNames = { 2: 'A little company', 3: 'Find your balance', 4: 'The full ensemble' };
const voiceColors = ['#8c9c83', '#bc9778', '#9692b2', '#729ba0'];

function Waveform({ seed = 1, color = '#8c9c83' }: { seed?: number; color?: string }) {
  return <div className="waveform" aria-hidden="true">{Array.from({ length: 72 }, (_, i) => {
    const envelope = Math.sin((i / 71) * Math.PI) * 0.7 + 0.2;
    const height = (12 + Math.abs(Math.sin(i * 1.81 + seed) * Math.cos(i * .37 + seed)) * 80) * envelope;
    return <i key={i} style={{ height: `${height}%`, background: color }} />;
  })}</div>;
}

async function readResponse(response: Response): Promise<HarmonyJob> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'The studio could not be reached. Please try again.');
  return body as HarmonyJob;
}

function TrackCard({ track, index, register, onEnded }: { track: AudioTrack; index: number; register: (el: HTMLAudioElement | null) => void; onEnded: () => void }) {
  return <article className="track-card">
    <div className="track-icon" style={{ color: voiceColors[index], background: `${voiceColors[index]}18` }}><AudioLines size={22} /></div>
    <div className="track-content">
      <div className="track-heading"><div><h3>{track.label}<span>{index === 0 ? 'YOUR MELODY' : `${track.semitones > 0 ? '+' : ''}${track.semitones} SEMITONES`}</span></h3><p>{track.name}</p></div>
        <a className="icon-button download" href={track.downloadUrl} download={track.name} aria-label={`Download ${track.label} MP3`}><ArrowDownToLine size={18} /></a>
      </div>
      <audio controls preload="metadata" src={track.url} ref={register} onEnded={onEnded} aria-label={`${track.label} audio`} />
      {track.lowNote && <p className={`track-range ${track.outsideRange ? 'range-warning' : ''}`}>{track.lowNote}–{track.highNote}{track.outsideRange ? ' · May extend beyond your selected range' : ''}</p>}
    </div>
  </article>;
}

export default function App() {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState('');
  const [parts, setParts] = useState<PartCount>(3);
  const [mode, setMode] = useState<HarmonyMode>('major');
  const [style, setStyle] = useState<HarmonyStyle>('modern-pop');
  const [voiceRange, setVoiceRange] = useState<RangeSelection>('auto');
  const [job, setJob] = useState<HarmonyJob | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const [playingAll, setPlayingAll] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [recorderBusy, setRecorderBusy] = useState(false);
  const [practiceBusy, setPracticeBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const players = useRef<(HTMLAudioElement | null)[]>([]);
  const requestController = useRef<AbortController | null>(null);
  const busy = uploading || job?.status === 'processing';
  const complete = job?.status === 'complete';

  useEffect(() => {
    if (!file) { setPreview(''); return; }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  useEffect(() => () => requestController.current?.abort(), []);

  useEffect(() => {
    if (!job || job.status !== 'processing') return;
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout>;
    let failures = 0;
    const poll = async () => {
      try {
        const nextJob = await readResponse(await fetch(`/api/jobs/${job.id}`, { signal: controller.signal }));
        if (controller.signal.aborted) return;
        failures = 0;
        setJob(nextJob);
        if (nextJob.status === 'failed') setError(nextJob.error || 'Generation failed. Please try again.');
        if (nextJob.status === 'processing') timeout = setTimeout(poll, 1000);
      } catch (err) {
        if (controller.signal.aborted) return;
        if (++failures < 5) { timeout = setTimeout(poll, 2000); return; }
        setError(err instanceof Error ? err.message : 'Connection lost. Please try again.');
        setJob(null);
      }
    };
    timeout = setTimeout(poll, 500);
    return () => { controller.abort(); clearTimeout(timeout); };
  }, [job?.id, job?.status]);

  function stopAll() {
    players.current.forEach(player => player?.pause());
    setPlayingAll(false);
  }
  function stopReferencePlayback() {
    stopAll();
    document.querySelector<HTMLAudioElement>('.source-preview audio')?.pause();
  }

  function accountChanged(user: AccountUser | null) {
    if (!user && job?.saved) { stopAll(); setJob(null); setFile(null); }
  }

  function openProject(project: HarmonyJob) {
    if (busy || recorderBusy || practiceBusy) return;
    stopAll(); setFile(null); setJob(project); setError('');
    setParts(project.parts); setMode(project.mode); setStyle(project.style); setVoiceRange(project.rangeSelection);
  }

  function selectFile(candidate?: File, fromRecording = false) {
    if (!candidate || busy || practiceBusy || (recorderBusy && !fromRecording)) return;
    if (!/\.(mp3|mp4|m4a)$/i.test(candidate.name)) { setError('Choose an MP3, MP4, or M4A file.'); return; }
    if (candidate.size > MAX_UPLOAD_BYTES) { setError('This file is too large. Please choose a file under 50 MB.'); return; }
    if (candidate.size === 0) { setError('This file is empty. Please choose another recording.'); return; }
    stopAll();
    setFile(candidate);
    setJob(null);
    setError('');
  }

  function dropFile(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    if (event.dataTransfer.files.length > 1) { setError('Please choose one recording at a time.'); return; }
    selectFile(event.dataTransfer.files[0]);
  }

  async function generate() {
    if (!file || busy || recorderBusy || practiceBusy) return;
    stopAll();
    document.querySelector<HTMLAudioElement>('.source-preview audio')?.pause();
    setError('');
    setJob(null);
    setUploading(true);
    const controller = new AbortController();
    requestController.current = controller;
    try {
      const data = new FormData();
      data.append('file', file);
      data.append('parts', String(parts));
      data.append('mode', mode);
      data.append('style', style);
      data.append('voiceRange', voiceRange);
      setJob(await readResponse(await fetch('/api/jobs', { method: 'POST', body: data, signal: controller.signal })));
    } catch (err) {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : 'Upload failed. Please try again.');
    } finally { setUploading(false); }
  }

  async function toggleAll() {
    if (playingAll) { stopAll(); return; }
    setError('');
    try {
      const active = players.current.filter((player): player is HTMLAudioElement => !!player);
      active.forEach(player => { player.currentTime = 0; player.volume = 1 / Math.max(1, active.length); });
      await Promise.all(active.map(player => player.play()));
      setPlayingAll(true);
    } catch { stopAll(); setError('Playback could not start. Try the individual track players.'); }
  }

  const resultTracks = complete && job.original ? [job.original, ...job.tracks] : [];

  return <div className="app-shell">
    <header className="topbar">
      <a className="brand" href="/" aria-label="Harmonizer home"><span className="brand-mark"><AudioLines size={24} /></span>harmonizer<span className="beta">BETA</span></a>
      <div className="topbar-right"><span className="local-badge"><span /> Your personal harmony studio</span><button className="help-button" onClick={() => setShowInfo(!showInfo)} aria-expanded={showInfo}><CircleHelp size={17} /> How it works</button></div>
    </header>

    <main>
      <div className="intro"><div><div className="eyebrow"><span /> ONE MELODY. MORE POSSIBILITY.</div><h1>Room for more voices.</h1><p>Give your melody a little company. Create layered harmonies<br className="desktop-break" /> from a single recording, one voice at a time.</p></div><div className="intro-art" aria-hidden="true"><div className="art-lines"><Waveform seed={4} /><Waveform seed={9} color="#bf9d83" /><Waveform seed={13} color="#a8a0bd" /></div><span><Music2 size={15} /> Better together.</span></div></div>

      {showInfo && <aside className="info-panel"><div><h2>A few notes before you start</h2><p>Upload a solo vocal or melody, choose your total voices, then generate. We estimate your sung register and choose octaves for your selected harmony style to fit your selected singing range. These are parallel pitch-shifted versions of your recording, so they may not fit every chord. Full mixes will shift the instruments too.</p><p>MP4 audio is extracted automatically. Sign in before generating to save your latest 10 projects. Guest files last 24 hours or until the server restarts. Download anything you want to keep longer.</p></div><button className="icon-button" onClick={() => setShowInfo(false)} aria-label="Close instructions"><X size={18} /></button></aside>}

      <AccountPanel disabled={!!busy || recorderBusy || practiceBusy} completedProject={complete && job.saved ? job.id : ''} onUserChange={accountChanged} onOpen={openProject} />
      <div className="workspace">
        <section className="setup-panel" aria-labelledby="create-title">
          <div className="panel-top"><h2 id="create-title">Create your harmony</h2><span className="small-label">THE STARTING POINT</span></div>
          <div className="step-heading"><span className="step-number">01</span><h3>Bring your melody</h3></div>
          <input ref={fileInput} className="visually-hidden" type="file" accept=".mp3,.mp4,.m4a,audio/mpeg,video/mp4,audio/mp4,audio/x-m4a" disabled={busy || recorderBusy || practiceBusy} onChange={e => { selectFile(e.target.files?.[0]); e.target.value = ''; }} aria-label="Upload MP3, MP4, or M4A" />
          <button className={`upload-zone ${dragging ? 'dragging' : ''} ${file ? 'has-file' : ''}`} disabled={busy || recorderBusy || practiceBusy} onClick={() => fileInput.current?.click()} onDragOver={e => { e.preventDefault(); if (!busy && !recorderBusy && !practiceBusy) setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={dropFile}>
            <span className="upload-icon">{file ? <FileAudio size={25} /> : <Upload size={24} />}</span>
            {file ? <><strong className="file-name">{file.name}</strong><span>{(file.size / 1024 / 1024).toFixed(1)} MB <span className="dot-separator">·</span> Click to replace</span><span className="file-ready"><Check size={13} /> Ready to harmonize</span></> : <><strong>Drop your recording here</strong><span>or <u>browse files</u> to get started</span><span className="format-label">MP3, MP4, or M4A <span className="dot-separator">·</span> Up to 50 MB / 10 min</span></>}
          </button>
          {file && preview && <div className="source-preview"><span>Listen to your original</span><audio controls src={preview} preload="metadata" aria-label="Uploaded recording preview" /></div>}
          <p className="field-note"><Headphones size={14} /> For the clearest harmonies, start with a solo voice.</p>
          <AudioRecorder disabled={!!busy || practiceBusy} onRecorded={recording => selectFile(recording, true)} onBusyChange={recording => {
            setRecorderBusy(recording);
            if (recording) { stopAll(); document.querySelector<HTMLAudioElement>('.source-preview audio')?.pause(); }
          }} onError={setError} />

          <div className="step-heading second-step"><span className="step-number">02</span><h3>Build your ensemble</h3></div>
          <div className="field-label">Total voices <span>including your original</span></div>
          <div className="parts-picker" role="group" aria-label="Total harmony parts">{([2, 3, 4] as PartCount[]).map(count => <button key={count} className={parts === count ? 'selected' : ''} disabled={busy} onClick={() => setParts(count)} aria-pressed={parts === count}>
            {parts === count && <span className="selection-check"><Check size={10} /></span>}
            <span className="voice-bars" aria-hidden="true">{Array.from({ length: count }, (_, i) => <i key={i} style={{ height: `${15 + (i % 2 ? 10 : i * 4)}px` }} />)}</span><strong>{count} parts</strong><span>{count - 1} new {count === 2 ? 'harmony' : 'harmonies'}</span>
          </button>)}</div>
          <div className="style-picker"><label htmlFor="harmony-style">Harmony style</label><select id="harmony-style" value={style} disabled={!!busy} onChange={e => setStyle(e.target.value as HarmonyStyle)}>{Object.entries(HARMONY_STYLES).map(([value, preset]) => <option key={value} value={value}>{preset.label}</option>)}</select><p>{HARMONY_STYLES[style].description} {style === 'hymn' ? 'Two parts starts with a fifth.' : 'Two parts adds a third; more parts add color.'}</p></div>
          <div className="mood-row"><div><label htmlFor="harmony-mode">Harmony color</label><p>Choose the color of your stack</p></div><select id="harmony-mode" value={mode} disabled={busy} onChange={e => setMode(e.target.value as HarmonyMode)}><option value="major">Major · brighter</option><option value="minor">Minor · softer</option></select></div>
          <div className="range-picker"><label htmlFor="voice-range">Your singing range</label><select id="voice-range" value={voiceRange} disabled={!!busy} onChange={e => setVoiceRange(e.target.value as RangeSelection)}><option value="auto">Detect from my recording</option>{Object.entries(VOICE_RANGES).map(([value, range]) => <option key={value} value={value}>{range.label}</option>)}</select><p>We detect your sung notes when you generate and choose harmony octaves to suit your range. Choose your range manually if you already know it.</p></div>
          {job?.analysis && <aside className="range-analysis" aria-label="Voice range analysis"><strong>{job.analysis.detectedRange ? `Estimated register: ${VOICE_RANGES[job.analysis.detectedRange].label}` : 'No clear solo pitch detected'}</strong>{job.analysis.lowNote && <span>Sung notes: {job.analysis.lowNote}–{job.analysis.highNote}</span>}{job.targetRange && <span>Harmonies fitted to: {VOICE_RANGES[job.targetRange].label}{job.rangeSelection !== 'auto' ? ' (manual)' : ''}</span>}<p>{job.analysis.confidence === 'unavailable' ? 'Try a clean solo vocal or choose your range manually. Using upward intervals because no reliable pitch range was found.' : job.analysis.confidence === 'limited' ? 'Limited sample. This estimates the register of this take, not your full vocal range. You can override it and regenerate.' : 'A recording estimates your sung register, not your full vocal range. Override it if needed.'}</p></aside>}
          {parts === 2 && <p className="two-part-note">{style === 'hymn' ? 'Two parts adds a fifth. Major/minor affects the third in 3–4 parts.' : 'Modern Pop and Neo-Soul start with a third. Choose 3–4 parts to hear their different colors.'}</p>}
          <button className="generate-button" disabled={!file || busy || recorderBusy || practiceBusy} onClick={() => void generate()}>{busy ? <LoaderCircle className="spin" size={18} /> : <Sparkles size={18} />}<span>{uploading ? 'Uploading your recording…' : busy ? 'Finding your harmony…' : 'Generate harmonies'}</span>{!busy && <ArrowRight size={18} />}</button>
          <p className="generation-note">{busy ? 'You can stay here while your tracks take shape.' : `${partNames[parts]}. ${parts - 1} separate MP3 ${parts === 2 ? 'track' : 'tracks'}.`}</p>
        </section>

        <section className={`results-panel ${complete ? 'has-results' : ''}`} aria-labelledby="results-title">
          <div className="panel-top"><h2 id="results-title">Your ensemble</h2><span className={`status-pill ${complete ? 'ready' : ''}`}><span />{busy ? 'IN THE MAKING' : complete ? `${job.parts} VOICES, ONE MELODY` : 'WAITING FOR YOUR MELODY'}</span></div>
          <div role="status" aria-live="polite" className="visually-hidden">{busy ? uploading ? 'Uploading recording' : `${job?.stage}, ${job?.progress} percent` : complete ? `${job.tracks.length} harmony tracks ready` : ''}</div>
          {busy ? <div className="processing-state"><div className="processing-disc"><AudioLines size={42} /></div><span className="small-label">A LITTLE STUDIO MAGIC</span><h3>{uploading ? 'Making room for your melody' : job?.stage}</h3><p>Good things come in layers.</p><div className="progress-track" role="progressbar" aria-label="Harmony generation" aria-valuemin={0} aria-valuemax={100} aria-valuenow={job?.progress ?? 0}><div style={{ width: `${job?.progress ?? 2}%` }} /></div><span className="progress-caption">{uploading ? 'Uploading' : `${job?.progress}% complete`}</span></div>
            : complete ? <div className="results-content"><div className="results-intro"><span className="result-check"><Check size={18} /></span><div><h3>Sounds like good company.</h3><p>{job.tracks.length} new {job.tracks.length === 1 ? 'harmony' : 'harmonies'} · {Math.floor((job.duration ?? 0) / 60)}:{String(Math.floor((job.duration ?? 0) % 60)).padStart(2, '0')} · {HARMONY_STYLES[job.style].label} · {job.mode}</p></div></div><div className="track-list">{resultTracks.map((track, index) => <TrackCard key={track.url} track={track} index={index} register={el => { players.current[index] = el; }} onEnded={stopAll} />)}</div><button className="play-together" disabled={practiceBusy} onClick={() => void toggleAll()}>{playingAll ? <Pause size={16} /> : <Play size={16} />}{playingAll ? 'Pause generated preview' : 'Preview generated ensemble'}<span>Original + generated guides</span></button><p className="results-footnote">Your tracks are ready to take with you.<br />{job.saved ? "Saved to your account. Your latest 10 projects are kept." : "Guest project: download within 24 hours or before the server restarts."}</p></div>
            : <div className="empty-state"><div className="ensemble-illustration" aria-hidden="true"><div className="illustration-card card-back"><Waveform seed={2} color="#c6b6d0" /></div><div className="illustration-card card-mid"><Waveform seed={6} color="#c7a88d" /></div><div className="illustration-card card-front"><div className="mini-track"><span><Music2 size={15} /></span><div><i /><i /></div><span className="mini-play"><Play size={10} fill="currentColor" /></span></div><Waveform seed={3} /></div><span className="illustration-plus"><Plus size={19} /></span></div><h3>A solo, soon to be an ensemble.</h3><p>Your original melody and new harmony tracks<br />will come together right here.</p><div className="empty-tags"><span><Play size={12} /> Preview each voice</span><span><ArrowDownToLine size={13} /> Download MP3s</span></div></div>}
          <div className="results-bottom"><Layers3 size={17} /><span>Individual voices. Endless possibilities.</span><Music2 size={15} /></div>
        </section>
      </div>
      {complete && <PracticeStudio key={job.id} job={job} onUpdate={setJob} onBusyChange={setPracticeBusy} stopGenerated={stopReferencePlayback} disabled={recorderBusy} />}
      {error && <div className="error-message" role="alert"><span>{error}</span><button className="icon-button" onClick={() => setError('')} aria-label="Dismiss error"><X size={17} /></button></div>}
      <section className="how-strip" aria-label="How it works"><div><span className="how-number">1</span><p><strong>Start with one voice</strong><span>A melody, a vocal, a little inspiration.</span></p></div><ChevronRight size={17} /><div><span className="how-number">2</span><p><strong>Add a new dimension</strong><span>Layer up to three harmony tracks.</span></p></div><ChevronRight size={17} /><div><span className="how-number">3</span><p><strong>Make it your own</strong><span>Listen, download, keep creating.</span></p></div></section>
    </main>
    <footer><span className="footer-brand"><AudioLines size={16} /> Made for the music in you.</span><span>A little harmony goes a long way.</span></footer>
  </div>;
}
