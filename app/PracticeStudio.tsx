import { useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, Headphones, Pause, Play } from 'lucide-react';
import AudioRecorder from './AudioRecorder';
import type { HarmonyJob } from './shared/types';

export default function PracticeStudio({ job, onUpdate, onBusyChange, stopGenerated, disabled = false }: {
  job: HarmonyJob;
  onUpdate: (job: HarmonyJob) => void;
  onBusyChange: (busy: boolean) => void;
  stopGenerated: () => void;
  disabled?: boolean;
}) {
  const [activePart, setActivePart] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState('');
  const takes = useRef(new Map<string, HTMLAudioElement>());
  const guides = useRef(new Map<string, HTMLAudioElement>());
  const playbackRun = useRef(0);
  const recorded = job.tracks.map(guide => job.takes?.find(take => take.sourceTrackName === guide.name)).filter(take => !!take);

  function stopTakes() {
    playbackRun.current++;
    takes.current.forEach(player => player.pause());
    setPlaying(false);
  }
  function stopGuides() { guides.current.forEach(player => player.pause()); }

  useEffect(() => { if (disabled) { stopTakes(); stopGuides(); } }, [disabled]);

  useEffect(() => {
    const pauseForReference = (event: Event) => {
      const audio = event.target;
      if (audio instanceof HTMLAudioElement && ![...takes.current.values()].includes(audio)) stopTakes();
    };
    document.addEventListener('play', pauseForReference, true);
    return () => {
      document.removeEventListener('play', pauseForReference, true);
      playbackRun.current++;
      takes.current.forEach(player => player.pause());
      guides.current.forEach(player => player.pause());
      onBusyChange(false);
    };
  }, []);

  async function playTogether() {
    if (playing) { stopTakes(); return; }
    stopGenerated(); stopGuides(); setError('');
    const run = ++playbackRun.current;
    // Only self-recorded takes are registered in this map; guides/original are excluded.
    const players = recorded.map(take => takes.current.get(take.sourceTrackName!)).filter(player => !!player);
    try {
      players.forEach(player => { player.currentTime = 0; player.volume = 1 / Math.max(1, players.length); });
      await Promise.all(players.map(player => player.play()));
      if (run === playbackRun.current) setPlaying(true);
    } catch {
      stopTakes(); setError('Your takes could not play together. Try the individual players.');
    }
  }

  async function saveTake(name: string, file: File, signal: AbortSignal) {
    const data = new FormData(); data.append('file', file);
    const response = await fetch(`/api/jobs/${job.id}/takes/${name}`, { method: 'POST', body: data, signal });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Your take could not be saved. Please retry.');
    if (!signal.aborted) onUpdate(result);
  }

  return <section className="practice-studio" aria-labelledby="practice-title">
    <div className="practice-heading"><div><div className="eyebrow">03 · YOUR TURN</div><h2 id="practice-title">Turn the harmonies into your own performance.</h2><p>Listen to each guide, imitate the part, then record your voice and download your take.</p></div><span className="practice-count">{recorded.length}/{job.tracks.length} parts recorded</span></div>
    <p className="practice-tip"><Headphones size={15} /> Use headphones to keep guides out of your microphone. Start each take with the same timing; playback starts every take from the beginning.</p>
    <div className="practice-grid">{job.tracks.map((guide, index) => {
      const take = job.takes?.find(item => item.sourceTrackName === guide.name);
      return <article key={guide.name} className="practice-part" aria-label={`Practice ${guide.label}`}>
        <div className="practice-part-title"><span>{String(index + 1).padStart(2, '0')}</span><h3>{guide.label}</h3></div>
        <label className="practice-audio-label" htmlFor={`guide-${guide.name}`}>Listen to the generated guide</label>
        <audio id={`guide-${guide.name}`} aria-label={`${guide.label} practice guide`} controls preload="metadata" src={guide.url} ref={player => { if (player) guides.current.set(guide.name, player); else guides.current.delete(guide.name); }} onPlay={() => { stopTakes(); stopGenerated(); guides.current.forEach((player, name) => { if (name !== guide.name) player.pause(); }); }} />
        <AudioRecorder purpose="practice" partLabel={guide.label} disabled={disabled || (activePart !== null && activePart !== guide.name)} onRecorded={(file, signal) => saveTake(guide.name, file, signal)} onError={setError} onBusyChange={busy => {
          setActivePart(busy ? guide.name : null); onBusyChange(busy);
          if (busy) { stopTakes(); stopGuides(); stopGenerated(); }
        }} />
        {take ? <div className="self-take"><div><strong>Your recorded take</strong><a href={take.downloadUrl} download={take.name} aria-label={`Download your ${guide.label} take`}><ArrowDownToLine size={14} /> MP3</a></div><audio aria-label={`Your recorded ${guide.label}`} controls preload="metadata" src={take.url} ref={player => { if (player) takes.current.set(guide.name, player); else takes.current.delete(guide.name); }} onPlay={() => { stopGuides(); stopGenerated(); }} onEnded={() => { if ([...takes.current.values()].every(player => player.ended || player.paused)) setPlaying(false); }} /></div> : <p className="no-take">Your own recording will appear here.</p>}
      </article>;
    })}</div>
    <div className="self-mix"><button className="generate-button" disabled={disabled || recorded.length === 0 || activePart !== null} onClick={() => void playTogether()}>{playing ? <Pause size={16} /> : <Play size={16} />}{playing ? 'Pause my recorded harmonies' : 'Play my recorded harmonies together'}</button><p>{recorded.length === 0 ? 'Record at least one part to begin.' : `${recorded.length} self-recorded ${recorded.length === 1 ? 'part' : 'parts'} only. No generated guides or original track.`}</p><p>{job.saved ? 'Your takes are saved with this project in your account.' : 'Guest takes are temporary. Download your recordings to keep them.'}</p></div>
    {error && <p className="account-error" role="alert">{error}</p>}
  </section>;
}
