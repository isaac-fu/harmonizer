import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSamples, detectPitch, noteName } from '../tools/pitch.js';
import { harmonyVoices } from '../tools/audio.js';
import type { VoiceRange } from '../app/shared/types.js';

function tone(midi: number, seconds = 2, harmonics = false): Float32Array {
  const hz = 440 * 2 ** ((midi - 69) / 12);
  return Float32Array.from({ length: 16000 * seconds }, (_, i) => {
    const phase = 2 * Math.PI * hz * i / 16000;
    return harmonics ? .12 * Math.sin(phase) + .2 * Math.sin(phase * 2) + .08 * Math.sin(phase * 3) : .3 * Math.sin(phase);
  });
}

test('pitch detection identifies low bass fundamentals even with a stronger second harmonic', () => {
  for (const midi of [33, 40, 45, 60, 72, 84]) {
    const hz = detectPitch(tone(midi, 1, true).subarray(0, 2048));
    assert.ok(hz !== null);
    const detectedMidi = 69 + 12 * Math.log2(hz / 440);
    assert.ok(Math.abs(detectedMidi - midi) < .3, `${midi}: detected ${detectedMidi}`);
  }
  assert.equal(noteName(40), 'E2');
  assert.equal(noteName(60), 'C4');
});

test('recording register estimates cover all six labels without claiming a full range', () => {
  for (const [midi, expected] of [[52, 'bass'], [55, 'baritone'], [60, 'tenor'], [65, 'alto'], [69, 'mezzo'], [72, 'soprano']] as [number, VoiceRange][]) {
    const result = analyzeSamples(tone(midi));
    assert.equal(result.detectedRange, expected);
    assert.equal(result.confidence, 'limited');
    assert.ok(Math.abs(result.medianMidi! - midi) < .3);
  }
});

test('silence and unpitched noise do not invent a singer range', () => {
  assert.equal(analyzeSamples(new Float32Array(16000)).detectedRange, null);
  let seed = 123;
  const noise = Float32Array.from({ length: 16000 }, () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    return seed / 2147483648 * .2;
  });
  assert.equal(analyzeSamples(noise).detectedRange, null);
});

test('low bass harmonies move upward, high soprano thirds move down, and manual range changes voicing', () => {
  const low = analyzeSamples(tone(40));
  const lowPlan = harmonyVoices(4, 'major', low, 'bass', 'hymn');
  assert.deepEqual(lowPlan.map(voice => voice.semitones), [7, 4, 12]);
  const high = analyzeSamples(tone(83));
  assert.equal(harmonyVoices(3, 'major', high, 'soprano')[0].semitones, -8);
  const middle = analyzeSamples(tone(60));
  assert.equal(harmonyVoices(3, 'major', middle, 'bass')[0].semitones, 4);
  assert.equal(harmonyVoices(3, 'major', middle, 'alto')[0].semitones, 4);
  assert.notEqual(harmonyVoices(2, 'major', middle, 'bass', 'hymn')[0].semitones, harmonyVoices(2, 'major', middle, 'soprano', 'hymn')[0].semitones);
});

test('modern and neo-soul styles retain their color tones when range fitting changes octaves', () => {
  const analysis = analyzeSamples(tone(69));
  for (const style of ['modern-pop', 'neo-soul'] as const) {
    const plan = harmonyVoices(4, 'major', analysis, 'mezzo', style);
    assert.deepEqual(plan.map(item => ((item.semitones % 12) + 12) % 12), style === 'modern-pop' ? [4, 9, 2] : [4, 11, 2]);
    assert.ok(plan.every(item => item.semitones !== 0 && Math.abs(item.semitones) !== 12));
  }
});
