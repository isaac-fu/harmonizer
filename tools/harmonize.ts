import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { CHORDS, KEY_NAMES, SCALES, VOICE_RANGES, defaultMusic, type HarmonyMode, type HarmonyNote, type HarmonyStyle, type MusicSettings, type VoiceRange } from '../app/shared/types.js';
import { detectPitch } from './pitch.js';
import { hasRubberband, runFfmpeg } from './audio.js';

export interface MelodyFrame { start: number; end: number; midi: number | null; }
const pc = (note: number) => ((note % 12) + 12) % 12;

export function parseMusic(raw: unknown, mode: HarmonyMode): MusicSettings {
  if (raw === undefined) return defaultMusic(mode === 'minor');
  let value: unknown;
  try { value = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { throw new Error('Invalid musical settings.'); }
  const v = value as MusicSettings | null;
  if (!v || !Number.isInteger(v.key) || v.key < 0 || v.key > 11 || !Object.hasOwn(SCALES, v.scale) || !['scale', 'chords'].includes(v.strategy) || !['style', 'third', 'fifth', 'sixth'].includes(v.dyad) || !['auto', 'above', 'below'].includes(v.direction) || !Array.isArray(v.chords) || v.chords.length > 32) throw new Error('Invalid musical settings.');
  for (let i = 0; i < v.chords.length; i++) {
    const chord = v.chords[i];
    if (!chord || !Number.isFinite(chord.start) || chord.start < 0 || chord.start >= 600 || !Number.isInteger(chord.root) || chord.root < 0 || chord.root > 11 || !Object.hasOwn(CHORDS, chord.quality) || (i > 0 && chord.start <= v.chords[i - 1].start)) throw new Error('Chord changes need increasing start times and valid chord names.');
  }
  if (v.strategy === 'chords' && (!v.chords.length || v.chords[0].start !== 0)) throw new Error('Start your chord progression at 0 seconds.');
  return { key: v.key, scale: v.scale, strategy: v.strategy, dyad: v.dyad, direction: v.direction, chords: v.chords.map(chord => ({ start: chord.start, root: chord.root, quality: chord.quality })) };
}

/** Track a clean solo melody at 100 ms intervals; yield CPU so job polling stays responsive. */
export async function trackMelody(pcmPath: string, duration: number): Promise<MelodyFrame[]> {
  const bytes = await readFile(pcmPath);
  const samples = new Float32Array(bytes.length / 2);
  for (let i = 0; i < samples.length; i++) samples[i] = bytes.readInt16LE(i * 2) / 32768;
  const frames: MelodyFrame[] = [];
  for (let start = 0, index = 0; start < duration; start += .1, index++) {
    const offset = Math.max(0, Math.min(samples.length - 2048, Math.round((start + .05) * 16000) - 1024));
    const hz = samples.length >= 2048 ? detectPitch(samples.subarray(offset, offset + 2048)) : null;
    frames.push({ start: Number(start.toFixed(3)), end: Math.min(duration, Number((start + .1).toFixed(3))), midi: hz === null ? null : 69 + 12 * Math.log2(hz / 440) });
    if (index % 24 === 0) await setImmediate();
  }
  // Reject isolated one-frame octave errors without smearing sustained note changes.
  return frames.map((frame, i) => {
    const before = frames[i - 1]?.midi, after = frames[i + 1]?.midi;
    if (frame.midi !== null && before != null && after != null && Math.abs(before - after) < .5 && Math.abs(frame.midi - before) > 5) return { ...frame, midi: (before + after) / 2 };
    return frame;
  });
}

export function planHarmonies(melody: MelodyFrame[], music: MusicSettings, style: HarmonyStyle, count: number, range?: VoiceRange): HarmonyNote[][] {
  const scaleNotes = Array.from({ length: 141 }, (_, note) => note).filter(note => SCALES[music.scale].notes.some(interval => pc(music.key + interval) === pc(note)));
  const nearestDegree = (midi: number) => scaleNotes.reduce((best, note, i) => Math.abs(note - midi) < Math.abs(scaleNotes[best] - midi) ? i : best, 0);
  const steps = style === 'hymn' ? [4, 2, 7] : style === 'neo-soul' ? [2, 6, 8] : [2, 5, 8];
  if (music.dyad !== 'style') steps[0] = { third: 2, fifth: 4, sixth: 5 }[music.dyad];
  const bounds = range ? VOICE_RANGES[range] : { low: 33, high: 88 };
  const plans: HarmonyNote[][] = Array.from({ length: count }, () => []);
  const previous: (number | undefined)[] = Array(count).fill(undefined);
  const timedFrames = melody.flatMap(frame => {
    const boundaries = [frame.start, ...music.chords.filter(chord => music.strategy === 'chords' && chord.start > frame.start && chord.start < frame.end).map(chord => chord.start), frame.end];
    return boundaries.slice(0, -1).map((start, i) => ({ ...frame, start, end: boundaries[i + 1] }));
  });
  for (const frame of timedFrames) {
    if (frame.midi === null) continue;
    const source = Math.round(frame.midi);
    const degree = nearestDegree(source);
    const chord = music.strategy === 'chords' ? music.chords.filter(change => change.start <= frame.start).at(-1) : undefined;
    const allowed = chord ? CHORDS[chord.quality].notes.map(note => pc(note + chord.root)) : null;
    const used: number[] = [];
    for (let voice = 0; voice < count; voice++) {
      const sign = music.direction === 'below' ? -1 : 1;
      const index = Math.max(0, Math.min(scaleNotes.length - 1, degree + steps[voice] * sign));
      const ideal = scaleNotes[index];
      const candidates = Array.from({ length: 85 }, (_, i) => i + 24).filter(note => {
        if (Math.abs(note - source) > 24 || note === source || used.includes(note)) return false;
        if (music.direction === 'above' && note <= source) return false;
        if (music.direction === 'below' && note >= source) return false;
        return allowed ? allowed.includes(pc(note)) : pc(note) === pc(ideal);
      });
      if (!candidates.length) continue;
      const score = (note: number) => {
        const outside = Math.max(0, bounds.low - note) + Math.max(0, note - bounds.high);
        const duplicate = used.some(other => pc(other) === pc(note)) ? 100 : 0;
        const melodyDoubling = pc(note) === pc(source) && voice < 2 ? 25 : 0;
        const movement = previous[voice] === undefined ? 0 : Math.abs(note - previous[voice]!);
        return outside * 1000 + duplicate + melodyDoubling + Math.abs(note - ideal) * .6 + Math.abs(note - source) * .1 + movement * .35;
      };
      const target = candidates.reduce((best, note) => score(note) < score(best) ? note : best);
      used.push(target); previous[voice] = target;
      const chordLabel = chord ? `${KEY_NAMES[chord.root].split(' / ')[0]} ${CHORDS[chord.quality].label}` : undefined;
      const last = plans[voice].at(-1);
      if (last && last.target === target && last.source === source && last.chord === chordLabel && Math.abs(last.end - frame.start) < .002) last.end = frame.end;
      else plans[voice].push({ start: frame.start, end: frame.end, source, target, ...(chordLabel ? { chord: chordLabel } : {}) });
    }
  }
  return plans;
}

/** Runtime Rubber Band commands vary the shift note by note, retaining breaths/consonants. */
export async function renderHarmony(input: string, output: string, duration: number, plan: HarmonyNote[], directory: string, voice: number) {
  if (!await hasRubberband()) throw new Error('Note-aware harmony needs an FFmpeg build with the Rubber Band filter. Set FFMPEG_PATH to a compatible build.');
  const initial = 2 ** (((plan[0]?.target ?? 0) - (plan[0]?.source ?? 0)) / 12);
  const commands: { time: number; value: string }[] = [];
  for (const note of plan) {
    const ratio = 2 ** ((note.target - note.source) / 12);
    commands.push({ time: note.start, value: `rubberband@harmony pitch ${ratio.toFixed(8)}` });
  }
  commands.sort((a, b) => a.time - b.time);
  const filename = `harmony-${voice}.cmd`;
  await writeFile(path.join(directory, filename), commands.map(command => `${command.time.toFixed(3)} ${command.value};`).join('\n'));
  await runFfmpeg(['-v', 'error', '-i', input, '-af', `asetnsamples=n=441:p=1,asendcmd=f=${filename},rubberband@harmony=pitch=${initial}:tempo=1:formant=preserved,apad,atrim=duration=${duration}`, '-map_metadata', '-1', '-c:a', 'libmp3lame', '-b:a', '192k', output], 300_000, directory);
}
