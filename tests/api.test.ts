import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../app/api/server.js';
import { harmonyVoices, pitchFilter, runFfmpeg } from '../tools/audio.js';
import type { HarmonyJob, PartCount } from '../app/shared/types.js';

let directory: string;
let service: Awaited<ReturnType<typeof createApp>>;
let mp3: string;
let mp4: string;

before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'harmonizer-test-'));
  service = await createApp({ dataDir: path.join(directory, '.data') });
  mp3 = path.join(directory, 'melody.mp3');
  mp4 = path.join(directory, 'melody.mp4');
  await runFfmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.2:sample_rate=44100', '-c:a', 'libmp3lame', mp3]);
  await runFfmpeg(['-f', 'lavfi', '-i', 'color=c=black:s=32x32:d=1.2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.2', '-c:v', 'mpeg4', '-c:a', 'aac', '-shortest', mp4]);
});

after(async () => {
  service?.dispose();
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function finish(id: string): Promise<HarmonyJob> {
  for (let i = 0; i < 200; i++) {
    const response = await request(service.app).get(`/api/jobs/${id}`).expect(200);
    const job = response.body as HarmonyJob;
    if (job.status !== 'processing') return job;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Generation did not finish in time');
}

test('voice plans default to modern colors and preserve hymn intervals as an option', () => {
  assert.equal(harmonyVoices(2, 'major').length, 1);
  assert.deepEqual(harmonyVoices(4, 'minor').map(item => item.semitones), [3, 8, 14]);
  assert.deepEqual(harmonyVoices(4, 'major').map(item => item.semitones), [4, 9, 14]);
  assert.deepEqual(harmonyVoices(4, 'minor', undefined, undefined, 'hymn').map(item => item.semitones), [-5, 3, -12]);
  assert.deepEqual(harmonyVoices(4, 'major', undefined, undefined, 'neo-soul').map(item => item.semitones), [4, 11, 14]);
  assert.match(pitchFilter(-12, false), /atempo=2/);
});

test('MP3 generates 1–3 playable, downloadable harmony files with the intended pitch and duration', async () => {
  for (const parts of [2, 3, 4] as PartCount[]) {
    const response = await request(service.app).post('/api/jobs').field('parts', parts).field('mode', 'major').attach('file', mp3).expect(202);
    const job = await finish(response.body.id);
    assert.equal(job.status, 'complete', job.error);
    assert.equal(job.tracks.length, parts - 1);
    assert.ok(job.duration && Math.abs(job.duration - 1.2) < .08);
    for (const item of [job.original!, ...job.tracks]) {
      const audio = await request(service.app).get(item.downloadUrl).expect(200);
      assert.match(audio.headers['content-type'], /audio\/mpeg/);
      assert.match(audio.headers['content-disposition'], new RegExp(item.name.replace('.', '\\.')));
      const filename = path.join(directory, item.name);
      await writeFile(filename, audio.body);
      const pcm = path.join(directory, 'decoded.pcm');
      await runFfmpeg(['-v', 'error', '-i', filename, '-ac', '1', '-ar', '44100', '-f', 's16le', pcm]);
      const bytes = await readFile(pcm);
      const duration = bytes.length / 2 / 44100;
      assert.ok(Math.abs(duration - job.duration!) < .06, `Duration mismatch: ${duration}`);
      // Measure positive zero crossings in the middle, away from encoder transients.
      let crossings = 0;
      const start = Math.round(.25 * 44100), end = Math.round(.95 * 44100);
      for (let sample = start + 1; sample < end; sample++) {
        if (bytes.readInt16LE((sample - 1) * 2) <= 0 && bytes.readInt16LE(sample * 2) > 0) crossings++;
      }
      const frequency = crossings / ((end - start) / 44100);
      const expected = 440 * 2 ** (item.semitones / 12);
      assert.ok(Math.abs(frequency - expected) < 5, `${item.name}: ${frequency} Hz, expected ${expected}`);
      await request(service.app).get(item.url).set('Range', 'bytes=0-99').expect(206);
    }
  }
});

test('MP4 is converted to an original MP3 and minor harmony tracks', async () => {
  const response = await request(service.app).post('/api/jobs').field('parts', '3').field('mode', 'minor').attach('file', mp4).expect(202);
  const job = await finish(response.body.id);
  assert.equal(job.status, 'complete', job.error);
  assert.equal(job.original?.name, 'audio_original.mp3');
  assert.deepEqual(job.tracks.map(track => track.name), ['audio_tenor.mp3', 'audio_alto.mp3']);
  assert.equal(job.tracks[0].tuning, 'diatonic');
});

test('invalid options, extensions, missing uploads, and missing jobs are rejected', async () => {
  await request(service.app).post('/api/jobs').field('parts', '8').field('mode', 'major').attach('file', mp3).expect(400);
  await request(service.app).post('/api/jobs').field('parts', '2').field('mode', 'major').attach('file', Buffer.from('text'), 'file.txt').expect(400);
  await request(service.app).post('/api/jobs').field('parts', '2').field('mode', 'major').expect(400);
  await request(service.app).get('/api/jobs/missing').expect(404);
  await request(service.app).get('/api/jobs/missing/files/audio_bass.mp3').expect(404);
});

test('M4A uploads with AAC or ALAC audio produce playable MP3 harmonies, including uppercase extensions', async () => {
  for (const codec of ['aac', 'alac']) {
    const filename = path.join(directory, `melody-${codec}.M4A`);
    await runFfmpeg(['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.2', '-c:a', codec, filename]);
    const response = await request(service.app).post('/api/jobs').field('parts', '3').field('mode', 'major').attach('file', filename).expect(202);
    const job = await finish(response.body.id);
    assert.equal(job.status, 'complete', job.error);
    assert.equal(job.tracks.length, 2);
    assert.ok(Math.abs(job.duration! - 1.2) < .1);
    for (const track of [job.original!, ...job.tracks]) {
      const audio = await request(service.app).get(track.downloadUrl).expect(200);
      assert.match(audio.headers['content-type'], /audio\/mpeg/);
      const mp3 = path.join(directory, `m4a-${codec}-${track.name}`);
      await writeFile(mp3, audio.body);
      await runFfmpeg(['-v', 'error', '-i', mp3, '-f', 'null', '-']);
    }
  }
});

test('a low bass recording is detected and creates upward, playable harmonies with note ranges', async () => {
  const filename = path.join(directory, 'low-bass.mp3');
  await runFfmpeg(['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=82.4069:duration=2', '-c:a', 'libmp3lame', filename]);
  const response = await request(service.app).post('/api/jobs').field('parts', '4').field('mode', 'major').field('voiceRange', 'auto').attach('file', filename).expect(202);
  const job = await finish(response.body.id);
  assert.equal(job.status, 'complete', job.error);
  assert.equal(job.analysis?.detectedRange, 'bass');
  assert.equal(job.targetRange, 'bass');
  assert.equal(job.analysis?.lowNote, 'E2');
  assert.equal(job.style, 'modern-pop');
  assert.deepEqual(job.tracks.map(track => track.semitones), [3, 8, 13]);
  assert.ok(job.tracks.every(track => track.lowNote && track.highNote && !track.outsideRange));
  for (const track of job.tracks) await request(service.app).get(track.url).expect(200);
  const manual = await request(service.app).post('/api/jobs').field('parts', '2').field('mode', 'major').field('voiceRange', 'baritone').attach('file', filename).expect(202);
  assert.equal((await finish(manual.body.id)).targetRange, 'baritone');
  await request(service.app).post('/api/jobs').field('parts', '2').field('mode', 'major').field('voiceRange', 'invalid').attach('file', filename).expect(400);
});

test('hymn and neo-soul selections generate distinct interval colors and labeled downloads', async () => {
  for (const style of ['hymn', 'neo-soul']) {
    const response = await request(service.app).post('/api/jobs').field('parts', '4').field('mode', 'major').field('voiceRange', 'auto').field('style', style).attach('file', mp3).expect(202);
    const job = await finish(response.body.id);
    assert.equal(job.status, 'complete', job.error);
    assert.equal(job.style, style);
    assert.equal(job.tracks.length, 3);
    assert.ok(job.tracks.every(track => track.tuning === 'diatonic' && track.notePlan?.every(note => [0, 2, 4, 5, 7, 9, 11].includes(note.target % 12))));
    assert.deepEqual(job.tracks.map(track => track.label), style === 'hymn' ? ['Fifth harmony', 'Third harmony', 'Octave harmony'] : ['Third harmony', 'Seventh harmony', 'Ninth harmony']);
    for (const track of job.tracks) await request(service.app).get(track.downloadUrl).expect(200);
  }
  await request(service.app).post('/api/jobs').field('parts', '3').field('mode', 'major').field('style', 'invalid').attach('file', mp3).expect(400);
});

test('the FFmpeg fallback supports modern ninths without changing track length', async () => {
  const output = path.join(directory, 'ninth-fallback.pcm');
  await runFfmpeg(['-v', 'error', '-i', mp3, '-af', `${pitchFilter(14, false)},apad,atrim=duration=1.2`, '-ar', '44100', '-ac', '1', '-f', 's16le', output]);
  const bytes = await readFile(output);
  assert.ok(Math.abs(bytes.length / 2 / 44100 - 1.2) < .03);
  let crossings = 0;
  for (let i = 11026; i < 41895; i++) if (bytes.readInt16LE((i - 1) * 2) <= 0 && bytes.readInt16LE(i * 2) > 0) crossings++;
  assert.ok(Math.abs(crossings / .7 - 440 * 2 ** (14 / 12)) < 6);
});

test('the chord timeline renders different chord tones over a held melody and validates musical settings', async () => {
  const music = { key: 0, scale: 'major', strategy: 'chords', dyad: 'third', direction: 'above', chords: [{ start: 0, root: 0, quality: 'maj' }, { start: .6, root: 1, quality: 'maj' }] };
  const response = await request(service.app).post('/api/jobs').field('parts', '2').field('mode', 'major').field('music', JSON.stringify(music)).attach('file', mp3).expect(202);
  const job = await finish(response.body.id);
  assert.equal(job.status, 'complete', job.error);
  assert.equal(job.tracks[0].tuning, 'chord-aware');
  assert.ok(job.tracks[0].notePlan!.some(note => note.start >= .6 && note.target % 12 === 1));
  const audio = await request(service.app).get(job.tracks[0].downloadUrl).expect(200);
  const filename = path.join(directory, 'chord-aware.mp3');
  const pcm = path.join(directory, 'chord-aware.pcm');
  await writeFile(filename, audio.body);
  await runFfmpeg(['-v', 'error', '-i', filename, '-ac', '1', '-ar', '44100', '-f', 's16le', pcm]);
  const bytes = await readFile(pcm);
  for (const [start, end, expected] of [[.15, .4, 523.25], [.85, 1.05, 554.37]]) {
    let count = 0;
    for (let i = Math.round(start * 44100) + 1; i < Math.round(end * 44100); i++) if (bytes.readInt16LE((i - 1) * 2) <= 0 && bytes.readInt16LE(i * 2) > 0) count++;
    assert.ok(Math.abs(count / (end - start) - expected) < 10);
  }
  await request(service.app).post('/api/jobs').field('parts', '2').field('mode', 'major').field('music', '{bad').attach('file', mp3).expect(400);
});

test('a disguised non-audio file fails cleanly without publishing any files', async () => {
  const response = await request(service.app).post('/api/jobs').field('parts', '2').field('mode', 'major').attach('file', Buffer.from('not audio'), 'bad.mp3').expect(202);
  const job = await finish(response.body.id);
  assert.equal(job.status, 'failed');
  assert.deepEqual(job.tracks, []);
  assert.ok(job.error);
  await request(service.app).get(`/api/jobs/${job.id}/files/audio_original.mp3`).expect(404);
});

test('recordings longer than ten minutes are rejected rather than silently truncated', async () => {
  const long = path.join(directory, 'long.mp3');
  await runFfmpeg(['-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=8000:cl=mono', '-t', '601', '-c:a', 'libmp3lame', '-b:a', '8k', long]);
  const response = await request(service.app).post('/api/jobs').field('parts', '2').field('mode', 'major').attach('file', long).expect(202);
  const job = await finish(response.body.id);
  assert.equal(job.status, 'failed');
  assert.match(job.error!, /10 minutes/);
});

test('browser recording formats convert to real MP3s that can be harmonized', async () => {
  for (const [extension, codec] of [['webm', 'libopus'], ['ogg', 'libopus'], ['mp4', 'aac']] as const) {
    const source = path.join(directory, `microphone.${extension}`);
    await runFfmpeg(['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.2', '-c:a', codec, source]);
    const converted = await request(service.app).post('/api/recordings').attach('file', source).expect(200);
    assert.match(converted.headers['content-type'], /audio\/mpeg/);
    assert.match(converted.headers['content-disposition'], /recording.mp3/);
    const jobResponse = await request(service.app).post('/api/jobs').field('parts', '2').field('mode', 'major').attach('file', converted.body, 'recording.mp3').expect(202);
    const job = await finish(jobResponse.body.id);
    assert.equal(job.status, 'complete', job.error);
    assert.equal(job.tracks.length, 1);
    assert.ok(Math.abs(job.duration! - 1.2) < .1);
  }
});

test('recording conversion rejects missing, corrupt, unsupported, and overly long takes', async () => {
  await request(service.app).post('/api/recordings').expect(400);
  await request(service.app).post('/api/recordings').attach('file', Buffer.from('bad'), 'take.txt').expect(400);
  await request(service.app).post('/api/recordings').attach('file', Buffer.from('bad'), 'take.webm').expect(422);
  const long = path.join(directory, 'long.webm');
  await runFfmpeg(['-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=8000:cl=mono', '-t', '601', '-c:a', 'libopus', long]);
  const response = await request(service.app).post('/api/recordings').attach('file', long).expect(422);
  assert.match(response.body.error, /10 minutes/);
  // Cleanup runs just after the response finishes.
  for (let i = 0; i < 50; i++) {
    if ((await readdir(path.join(directory, '.data/uploads'))).length === 0) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('Recording conversion left temporary files behind');
});
