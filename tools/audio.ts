import { spawn } from 'node:child_process';
import ffmpegStatic from 'ffmpeg-static';
import { VOICE_RANGES, type HarmonyMode, type HarmonyStyle, type PartCount, type Voice, type PitchAnalysis, type VoiceRange } from '../app/shared/types.js';

export const ffmpegPath = process.env.FFMPEG_PATH || (ffmpegStatic as unknown as string | null);

/** Never invokes a shell; uploaded filenames cannot become executable arguments. */
export function runFfmpeg(args: string[], timeoutMs = 300_000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) return reject(new Error('FFmpeg is unavailable. Set FFMPEG_PATH to an installed binary.'));
    const child = spawn(ffmpegPath, ['-hide_banner', '-nostdin', '-y', ...args], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => { stdout = (stdout + chunk.toString()).slice(-32_000); });
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-32_000); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error('Audio processing timed out. Try a shorter recording.'));
      else if (code !== 0) reject(new Error(`FFmpeg could not process this audio: ${stderr.slice(-1500)}`));
      else resolve({ stdout, stderr });
    });
  });
}

let rubberbandAvailable: Promise<boolean> | undefined;
export function hasRubberband(): Promise<boolean> {
  return rubberbandAvailable ??= runFfmpeg(['-filters']).then(({ stdout }) => /\brubberband\b/.test(stdout));
}

export function harmonyVoices(parts: PartCount, mode: HarmonyMode, analysis?: PitchAnalysis, target?: VoiceRange, style: HarmonyStyle = 'modern-pop'): { voice: Voice; label: string; semitones: number }[] {
  // Parallel intervals, not pitch tracking or chord-aware composition.
  const voices = (style === 'hymn' ? [
    { voice: 'tenor' as const, label: 'Fifth harmony', semitones: -5 },
    { voice: 'alto' as const, label: 'Third harmony', semitones: mode === 'major' ? 4 : 3 },
    { voice: 'bass' as const, label: 'Octave harmony', semitones: -12 },
  ] : [
    { voice: 'tenor' as const, label: 'Third harmony', semitones: mode === 'major' ? 4 : 3 },
    { voice: 'alto' as const, label: style === 'neo-soul' ? 'Seventh harmony' : 'Sixth harmony', semitones: style === 'neo-soul' ? (mode === 'major' ? 11 : 10) : (mode === 'major' ? 9 : 8) },
    { voice: 'bass' as const, label: 'Ninth harmony', semitones: 14 },
  ]).slice(0, parts - 1);
  if (!analysis) return voices;
  const bounds = target ? VOICE_RANGES[target] : null;
  return voices.map(({ voice, label, semitones }) => {
    const options = [semitones - 24, semitones - 12, semitones, semitones + 12].filter(shift => shift !== 0 && Math.abs(shift) <= 14);
    if (semitones % 12 === 0) options.push(12);
    const candidates = [...new Set(options)];
    const low = analysis.lowMidi, high = analysis.highMidi;
    const score = (shift: number) => {
      if (low === undefined || high === undefined || !bounds) return style === 'hymn' ? (shift < 0 ? 100 + Math.abs(shift) : Math.abs(shift)) : Math.abs(shift - semitones);
      const outside = Math.max(0, bounds.low - .5 - (low + shift)) + Math.max(0, high + shift - bounds.high - .5);
      // Keep low recordings from being pushed further below their observed register.
      const belowRecording = Math.max(0, -shift - Math.max(0, low - bounds.low - 2));
      return outside * 100 + belowRecording * 2 + (style === 'hymn' ? 0 : Math.abs(shift - semitones) * .25) + Math.abs(shift) * .05;
    };
    return { voice, label, semitones: candidates.reduce((best, shift) => score(shift) < score(best) ? shift : best) };
  });
}

export function pitchFilter(semitones: number, rubberband: boolean): string {
  const ratio = 2 ** (semitones / 12);
  const tempo = 1 / ratio;
  // Some FFmpeg builds only allow atempo factors >= 0.5. A ninth exceeds an octave.
  const compensation = tempo < .5 || tempo > 2
    ? `atempo=${Math.sqrt(tempo)},atempo=${Math.sqrt(tempo)}` : `atempo=${tempo}`;
  return rubberband
    ? `rubberband=pitch=${ratio}:tempo=1:formant=preserved`
    : `asetrate=${Math.round(44100 * ratio)},aresample=44100,${compensation}`;
}

/** Decode at most 601 seconds so duration limits also bound decompressed storage. */
export async function normalizeAudio(input: string, output: string, format: 'mp3' | 'mov' | 'matroska' | 'ogg'): Promise<number> {
  const { stdout } = await runFfmpeg([
    '-v', 'error', '-protocol_whitelist', 'file,pipe', '-f', format, '-i', input, '-map', '0:a:0', '-vn', '-t', '601',
    '-ac', '2', '-ar', '44100', '-c:a', 'pcm_s16le', '-progress', 'pipe:1', output,
  ]);
  const times = [...stdout.matchAll(/out_time_us=(\d+)/g)];
  const duration = Number(times.at(-1)?.[1]) / 1_000_000;
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('The file has no decodable audio.');
  return duration;
}

export async function encodeMp3(input: string, output: string, duration: number, semitones = 0): Promise<void> {
  const filters = semitones ? `${pitchFilter(semitones, await hasRubberband())},apad,atrim=duration=${duration}` : `atrim=duration=${duration}`;
  await runFfmpeg([
    '-v', 'error', '-i', input, '-map', '0:a:0', '-vn', '-af', filters,
    '-map_metadata', '-1', '-c:a', 'libmp3lame', '-b:a', '192k', '-ar', '44100', output,
  ]);
}
