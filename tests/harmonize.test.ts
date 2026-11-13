import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defaultMusic, SCALES } from '../app/shared/types.js';
import { parseMusic, planHarmonies, renderHarmony, trackMelody, type MelodyFrame } from '../tools/harmonize.js';
import { normalizeAudio, runFfmpeg } from '../tools/audio.js';
import { analyzeVoice } from '../tools/pitch.js';

const melody: MelodyFrame[] = [60, 62, 64].map((midi, i) => ({ start: i, end: i + 1, midi }));
let directory: string;
before(async () => { directory = await mkdtemp(path.join(tmpdir(), 'harmonizer-notes-')); });
after(async () => { await rm(directory, { recursive: true, force: true }); });

test('diatonic thirds vary their semitone distance instead of transposing the whole melody', () => {
  const plan = planHarmonies(melody, { ...defaultMusic(), direction: 'above' }, 'modern-pop', 1, 'tenor')[0];
  assert.deepEqual(plan.map(note => note.target), [64, 65, 67]); // C D E -> E F G
  assert.deepEqual(plan.map(note => note.target - note.source), [4, 3, 3]);
  const sixths = planHarmonies(melody, { ...defaultMusic(), dyad: 'sixth', direction: 'above' }, 'modern-pop', 1, 'tenor')[0];
  assert.deepEqual(sixths.map(note => note.target), [69, 71, 72]);
});

test('every selected scale and key constrains all generated target pitch classes', () => {
  for (let key = 0; key < 12; key++) for (const scale of Object.keys(SCALES) as (keyof typeof SCALES)[]) {
    const settings = { ...defaultMusic(), key, scale };
    const plans = planHarmonies(melody, settings, 'neo-soul', 3, 'tenor');
    const allowed = SCALES[scale].notes.map(note => (note + key) % 12);
    assert.ok(plans.flat().every(note => allowed.includes(note.target % 12)));
  }
});

test('four-part sixths keep one register across a scale instead of jumping at the range ceiling', () => {
  const sources = [60, 62, 64, 65, 67, 69, 71, 72, 71, 69, 67, 65, 64, 62, 60];
  const frames = sources.map((midi, i) => ({ start: i, end: i + 1, midi }));
  const plans = planHarmonies(frames, defaultMusic(), 'modern-pop', 3, 'tenor');
  const sixth = plans[1];
  assert.equal(sixth.length, sources.length);
  assert.deepEqual(sixth.slice(0, 8).map(note => note.target), [57, 59, 60, 62, 64, 65, 67, 69]);
  for (const plan of plans) {
    assert.equal(plan.length, sources.length);
    assert.ok(plan.every(note => note.target >= 48 && note.target <= 72));
    assert.ok(plan.slice(1).every((note, i) => Math.abs(note.target - plan[i].target) <= 2));
  }
  const above = planHarmonies(frames, { ...defaultMusic(), direction: 'above' }, 'modern-pop', 3, 'tenor')[1];
  assert.ok(above.every(note => note.target > note.source));
});

test('small pitch fluctuations around a semitone boundary do not modulate a held harmony', () => {
  const frames = [60.45, 60.55, 60.48, 60.54, 61, 61].map((midi, i) => ({ start: i * .1, end: (i + 1) * .1, midi }));
  const plans = planHarmonies(frames, defaultMusic(), 'modern-pop', 3, 'alto');
  for (const plan of plans) {
    assert.equal(plan[0].source, 60);
    assert.ok(Math.abs(plan[0].end - .4) < .001);
    assert.equal(plan[1].source, 61);
  }
});

test('a sixth dyad override still leaves three distinct parts in four-part mode', () => {
  const plans = planHarmonies(melody, { ...defaultMusic(), dyad: 'sixth' }, 'modern-pop', 3, 'tenor');
  assert.ok(plans.every(plan => plan.length === melody.length));
  for (let i = 0; i < melody.length; i++) assert.equal(new Set(plans.map(plan => plan[i].target)).size, 3);
});

test('global register fitting never collapses a hymn octave onto the melody', () => {
  const frames = [60, 64, 67, 72].map((midi, i) => ({ start: i, end: i + 1, midi }));
  const octave = planHarmonies(frames, defaultMusic(), 'hymn', 3, 'tenor')[2];
  assert.equal(octave.length, frames.length);
  assert.ok(octave.every(note => Math.abs(note.target - note.source) === 12));
});

test('timed chords override scale tones, split frames at chord changes, and avoid duplicate harmony notes', () => {
  const settings = { ...defaultMusic(), strategy: 'chords' as const, chords: [{ start: 0, root: 0, quality: 'maj' as const }, { start: .65, root: 1, quality: 'maj' as const }] };
  const plans = planHarmonies([{ start: 0, end: 2, midi: 60 }], settings, 'modern-pop', 3, 'tenor');
  for (const plan of plans) {
    assert.equal(plan[1].start, .65);
    assert.ok([0, 4, 7].includes(plan[0].target % 12));
    assert.ok([1, 5, 8].includes(plan[1].target % 12));
  }
  assert.equal(new Set(plans.map(plan => plan[1].target)).size, 3);
});

test('musical settings reject missing first chords, unsorted times, invalid roots, and malformed JSON', () => {
  assert.throws(() => parseMusic('{bad', 'major'), /Invalid musical/);
  assert.throws(() => parseMusic({ ...defaultMusic(), key: 12 }, 'major'));
  assert.throws(() => parseMusic({ ...defaultMusic(), strategy: 'chords', chords: [{ start: 2, root: 0, quality: 'maj' }] }, 'major'), /0 seconds/);
  assert.throws(() => parseMusic({ ...defaultMusic(), strategy: 'chords', chords: [{ start: 0, root: 0, quality: 'maj' }, { start: 0, root: 5, quality: 'maj' }] }, 'major'), /increasing/);
});

function frequency(bytes: Buffer, start: number, end: number) {
  let crossings = 0;
  const low = Math.round(start * 44100), high = Math.round(end * 44100);
  for (let i = low + 1; i < high; i++) if (bytes.readInt16LE((i - 1) * 2) <= 0 && bytes.readInt16LE(i * 2) > 0) crossings++;
  return crossings / (end - start);
}

test('real C-D-E audio is rendered as E-F-G with changing pitch commands and preserved duration', async () => {
  const source = path.join(directory, 'melody.mp3');
  const input = path.join(directory, 'source.wav');
  const pcm = path.join(directory, 'analysis.pcm');
  const output = path.join(directory, 'third.mp3');
  await runFfmpeg(['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=261.625565:duration=0.8', '-f', 'lavfi', '-i', 'sine=frequency=293.664768:duration=0.8', '-f', 'lavfi', '-i', 'sine=frequency=329.627557:duration=0.8', '-filter_complex', '[0:a][1:a][2:a]concat=n=3:v=0:a=1', '-c:a', 'libmp3lame', source]);
  const duration = await normalizeAudio(source, input, 'mp3');
  await analyzeVoice(input, pcm);
  const frames = await trackMelody(pcm, duration);
  const plan = planHarmonies(frames, { ...defaultMusic(), direction: 'above' }, 'modern-pop', 1, 'tenor')[0];
  await renderHarmony(input, output, duration, plan, directory, 0);
  const decoded = path.join(directory, 'decoded.pcm');
  await runFfmpeg(['-v', 'error', '-i', output, '-ac', '1', '-ar', '44100', '-f', 's16le', decoded]);
  const bytes = await readFile(decoded);
  assert.ok(Math.abs(bytes.length / 2 / 44100 - duration) < .08);
  for (const [start, end, expected] of [[.3, .6, 329.63], [1.1, 1.4, 349.23], [1.9, 2.2, 392]]) {
    const measured = frequency(bytes, start, end);
    assert.ok(Math.abs(measured - expected) < 9, `${start}s: ${measured} Hz, expected ${expected}`);
  }
});

test('rendered four-part sixth follows C-E-F-E without octave flips and stays aligned', async () => {
  const input = path.join(directory, 'sixth-source.wav');
  const pcm = path.join(directory, 'sixth-analysis.pcm');
  const output = path.join(directory, 'sixth.mp3');
  const decoded = path.join(directory, 'sixth-decoded.pcm');
  const args = [261.625565, 329.627557, 349.228231, 329.627557].flatMap(hz => ['-f', 'lavfi', '-i', `sine=frequency=${hz}:duration=0.8`]);
  await runFfmpeg(['-v', 'error', ...args, '-filter_complex', '[0:a][1:a][2:a][3:a]concat=n=4:v=0:a=1', '-ar', '44100', input]);
  await analyzeVoice(input, pcm);
  const frames = await trackMelody(pcm, 3.2);
  const plan = planHarmonies(frames, defaultMusic(), 'modern-pop', 3, 'tenor')[1];
  await renderHarmony(input, output, 3.2, plan, directory, 1);
  await runFfmpeg(['-v', 'error', '-i', output, '-ac', '1', '-ar', '44100', '-f', 's16le', decoded]);
  const bytes = await readFile(decoded);
  assert.ok(Math.abs(bytes.length / 2 / 44100 - 3.2) < .03);
  for (const [start, end, expected] of [[.3, .6, 220], [1.1, 1.4, 261.63], [1.9, 2.2, 293.66], [2.7, 3, 261.63]]) {
    const measured = frequency(bytes, start, end);
    assert.ok(Math.abs(measured - expected) < 9, `${start}s: ${measured} Hz, expected ${expected}`);
  }
});
