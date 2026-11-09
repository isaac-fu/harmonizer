import { readFile } from 'node:fs/promises';
import { VOICE_RANGES, type PitchAnalysis, type VoiceRange } from '../app/shared/types.js';
import { runFfmpeg } from './audio.js';

const SAMPLE_RATE = 16000;
const FRAME_SIZE = 2048;

export function noteName(midi: number): string {
  const note = Math.round(midi);
  return `${['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'][((note % 12) + 12) % 12]}${Math.floor(note / 12) - 1}`;
}

/** Heuristic nearest tessitura center; this is a recording estimate, not a voice diagnosis. */
export function classifyRange(median: number): VoiceRange {
  return (Object.keys(VOICE_RANGES) as VoiceRange[]).reduce((best, range) => {
    const center = (key: VoiceRange) => (VOICE_RANGES[key].low + VOICE_RANGES[key].high) / 2;
    return Math.abs(median - center(range)) < Math.abs(median - center(best)) ? range : best;
  }, 'bass');
}

/** YIN cumulative mean normalized difference, bounded to roughly A1–C6. */
export function detectPitch(frame: Float32Array, sampleRate = SAMPLE_RATE): number | null {
  let energy = 0;
  let mean = 0;
  for (const sample of frame) mean += sample;
  mean /= frame.length;
  for (const sample of frame) energy += (sample - mean) ** 2;
  if (Math.sqrt(energy / frame.length) < .005) return null;
  const minLag = Math.max(2, Math.floor(sampleRate / 1100));
  const maxLag = Math.min(Math.ceil(sampleRate / 55), Math.floor(frame.length / 2) - 1);
  const window = frame.length - maxLag - 1;
  const difference = new Float64Array(maxLag + 2);
  let sum = 0;
  for (let lag = 1; lag <= maxLag + 1; lag++) {
    let value = 0;
    for (let i = 0; i < window; i++) value += (frame[i] - frame[i + lag]) ** 2;
    sum += value;
    difference[lag] = sum > 0 ? value * lag / sum : 1;
  }
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (difference[lag] >= .15) continue;
    while (lag < maxLag && difference[lag + 1] < difference[lag]) lag++;
    const left = difference[lag - 1], middle = difference[lag], right = difference[lag + 1];
    const denominator = 2 * (2 * middle - right - left);
    const refined = lag + (denominator ? (right - left) / denominator : 0);
    const hz = sampleRate / refined;
    return hz >= 55 && hz <= 1100 ? hz : null;
  }
  return null;
}

export function analyzeSamples(samples: Float32Array): PitchAnalysis {
  const pitches: number[] = [];
  // Sample across the entire recording; cap work even for ten-minute files.
  const frameCount = Math.min(400, Math.max(0, Math.floor(samples.length / FRAME_SIZE)));
  for (let i = 0; i < frameCount; i++) {
    const offset = frameCount === 1 ? 0 : Math.floor(i * (samples.length - FRAME_SIZE) / (frameCount - 1));
    const hz = detectPitch(samples.subarray(offset, offset + FRAME_SIZE));
    if (hz !== null) pitches.push(69 + 12 * Math.log2(hz / 440));
  }
  if (pitches.length < 5 || pitches.length / Math.max(1, frameCount) < .1) {
    return { detectedRange: null, voicedFrames: pitches.length, sampledFrames: frameCount, confidence: 'unavailable' };
  }
  pitches.sort((a, b) => a - b);
  const quantile = (fraction: number) => pitches[Math.floor((pitches.length - 1) * fraction)];
  const lowMidi = quantile(.05), highMidi = quantile(.95), medianMidi = quantile(.5);
  return {
    detectedRange: classifyRange(medianMidi), lowMidi, highMidi, medianMidi,
    lowNote: noteName(lowMidi), highNote: noteName(highMidi), voicedFrames: pitches.length, sampledFrames: frameCount,
    confidence: pitches.length >= 30 && highMidi - lowMidi >= 5 && pitches.length / frameCount >= .5 ? 'good' : 'limited',
  };
}

export async function analyzeVoice(input: string, pcmPath: string): Promise<PitchAnalysis> {
  await runFfmpeg(['-v', 'error', '-i', input, '-ac', '1', '-ar', String(SAMPLE_RATE), '-c:a', 'pcm_s16le', '-f', 's16le', pcmPath]);
  const bytes = await readFile(pcmPath);
  const samples = new Float32Array(Math.floor(bytes.length / 2));
  for (let i = 0; i < samples.length; i++) samples[i] = bytes.readInt16LE(i * 2) / 32768;
  return analyzeSamples(samples);
}
