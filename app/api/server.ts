import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { encodeMp3, hasRubberband, harmonyVoices, normalizeAudio } from '../../tools/audio.js';
import { analyzeVoice, noteName } from '../../tools/pitch.js';
import { HARMONY_STYLES, MAX_DURATION_SECONDS, MAX_UPLOAD_BYTES, VOICE_RANGES, type AudioTrack, type HarmonyJob, type HarmonyStyle, type PartCount, type RangeSelection } from '../shared/types.js';
import { Store } from './store.js';
import { authRouter, sessionToken } from './auth.js';

const DAY = 24 * 60 * 60 * 1000;
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
// In compiled output server.ts sits under dist/server/app/api/.
const root = repositoryRoot.endsWith(`${path.sep}dist${path.sep}server${path.sep}`)
  ? path.resolve(repositoryRoot, '../..') : repositoryRoot;

export async function createApp(options: { dataDir?: string } = {}) {
  const dataDir = path.resolve(options.dataDir ?? process.env.DATA_DIR ?? path.join(root, '.data'));
  const uploadDir = path.join(dataDir, 'uploads');
  const jobDir = path.join(dataDir, 'jobs');
  await Promise.all([mkdir(uploadDir, { recursive: true }), mkdir(jobDir, { recursive: true })]);
  const store = new Store(path.join(dataDir, 'harmonizer.sqlite'));
  for (const id of store.recoverInterrupted()) await rm(path.join(jobDir, id), { recursive: true, force: true });
  const jobs = new Map<string, HarmonyJob>();
  const owners = new Map<string, string>();
  let activeJobs = 0;
  const app = express();
  const appOrigins = new Set((process.env.APP_ORIGIN ?? (process.env.NODE_ENV === 'production' ? '' : 'http://127.0.0.1:5173')).split(',').map(origin => origin.trim()).filter(Boolean));
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });
  app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.get('Origin');
      let allowed = !origin;
      try { if (origin) allowed = new URL(origin).origin === `${req.protocol}://${req.get('host')}` || appOrigins.has(origin); } catch { allowed = false; }
      if (!allowed || req.get('Sec-Fetch-Site') === 'cross-site') {
        res.status(403).json({ error: 'This request must come from the Harmonizer app.' }); return;
      }
    }
    res.locals.user = store.userForSession(sessionToken(req));
    next();
  });
  app.use(express.json({ limit: '8kb' }));
  app.use('/api/auth', authRouter(store));
  app.get('/api/projects', (_req, res) => {
    if (!res.locals.user) { res.status(401).json({ error: 'Sign in to view your projects.' }); return; }
    res.json({ projects: store.projects(res.locals.user.id), limit: 10 });
  });
  function accessibleJob(id: string, userId?: string): HarmonyJob | undefined {
    const saved = store.project(id);
    const owner = owners.get(id) ?? saved?.owner;
    if (owner && owner !== userId) return;
    return jobs.get(id) ?? saved?.job;
  }

  const upload = multer({
    storage: multer.diskStorage({ destination: uploadDir, filename: (_req, _file, cb) => cb(null, randomUUID()) }),
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 4, parts: 5, fieldSize: 100 },
    fileFilter: (_req, file, cb) => {
      if (!['.mp3', '.mp4', '.m4a'].includes(path.extname(file.originalname).toLowerCase())) {
        cb(new Error('Please upload an MP3, MP4, or M4A file.'));
      } else cb(null, true);
    },
  });

  const recordingFormats = { '.webm': 'matroska', '.ogg': 'ogg', '.mp4': 'mov', '.m4a': 'mov' } as const;
  const recordingUpload = multer({
    storage: multer.diskStorage({ destination: uploadDir, filename: (_req, _file, cb) => cb(null, randomUUID()) }),
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 0, parts: 1 },
    fileFilter: (_req, file, cb) => {
      if (!(path.extname(file.originalname).toLowerCase() in recordingFormats)) cb(new Error('Unsupported microphone recording format.'));
      else cb(null, true);
    },
  });

  app.post('/api/recordings', (_req, res, next) => {
    if (activeJobs >= 2) { res.status(429).json({ error: 'The studio is busy. Please try again in a moment.' }); return; }
    activeJobs++;
    let released = false;
    const release = () => {
      if (!released && !res.locals.recordingConverting) { released = true; activeJobs--; }
    };
    res.locals.releaseRecordingSlot = release;
    res.once('finish', release);
    res.once('close', release);
    next();
  }, recordingUpload.single('file'), async (req, res) => {
    if (!req.file) { res.status(400).json({ error: 'Record some audio before converting it.' }); return; }
    res.locals.recordingConverting = true;
    const directory = path.join(uploadDir, `recording-${randomUUID()}`);
    try {
      await mkdir(directory);
      const wav = path.join(directory, 'source.wav');
      const mp3 = path.join(directory, 'recording.mp3');
      const format = recordingFormats[path.extname(req.file.originalname).toLowerCase() as keyof typeof recordingFormats];
      const duration = await normalizeAudio(req.file.path, wav, format);
      if (duration > MAX_DURATION_SECONDS) {
        res.status(422).json({ error: 'Please keep your recording under 10 minutes.' }); return;
      }
      await encodeMp3(wav, mp3, duration);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Disposition', 'attachment; filename="recording.mp3"');
      res.type('audio/mpeg').send(await readFile(mp3));
    } catch (error) {
      console.error('Recording conversion failed:', error);
      res.status(422).json({ error: 'We could not convert this recording. Please record again.' });
    } finally {
      await Promise.all([rm(req.file.path, { force: true }), rm(directory, { recursive: true, force: true })]).catch(console.error);
      res.locals.recordingConverting = false;
      res.locals.releaseRecordingSlot();
    }
  });

  app.get('/api/health', async (_req, res) => {
    try { res.json({ ok: true, engine: await hasRubberband() ? 'rubberband' : 'ffmpeg' }); }
    catch { res.status(503).json({ error: 'FFmpeg is unavailable. Install dependencies or set FFMPEG_PATH.' }); }
  });

  const track = (id: string, name: string, label: string, semitones = 0): AudioTrack => ({
    name, label, semitones,
    url: `/api/jobs/${id}/files/${name}`,
    downloadUrl: `/api/jobs/${id}/files/${name}?download=1`,
  });

  async function processJob(job: HarmonyJob, input: string, directory: string, owner?: string) {
    const wav = path.join(directory, 'source.wav');
    const pcm = path.join(directory, 'analysis.pcm');
    try {
      job.stage = 'Preparing your original audio';
      const duration = await normalizeAudio(input, wav, /\.(mp4|m4a)$/i.test(job.sourceName) ? 'mov' : 'mp3');
      if (duration > MAX_DURATION_SECONDS) throw new Error('Please choose a recording no longer than 10 minutes.');
      job.duration = duration;
      job.stage = 'Detecting your sung range';
      job.progress = 15;
      job.analysis = await analyzeVoice(wav, pcm);
      job.targetRange = job.rangeSelection === 'auto' ? job.analysis.detectedRange ?? undefined : job.rangeSelection;
      await encodeMp3(wav, path.join(directory, 'audio_original.mp3'), duration);
      job.original = track(job.id, 'audio_original.mp3', 'Original');
      job.progress = 30;
      const voices = harmonyVoices(job.parts, job.mode, job.analysis, job.targetRange, job.style);
      for (const [index, { voice, label, semitones }] of voices.entries()) {
        job.stage = `Creating your ${label.toLowerCase()}`;
        const name = `audio_${voice}.mp3`;
        await encodeMp3(wav, path.join(directory, name), duration, semitones);
        const audioTrack = track(job.id, name, label, semitones);
        if (job.analysis.lowMidi !== undefined && job.analysis.highMidi !== undefined) {
          const low = job.analysis.lowMidi + semitones, high = job.analysis.highMidi + semitones;
          audioTrack.lowNote = noteName(low);
          audioTrack.highNote = noteName(high);
          if (job.targetRange) {
            const range = VOICE_RANGES[job.targetRange];
            audioTrack.outsideRange = low < range.low - .5 || high > range.high + .5;
          }
        }
        job.tracks.push(audioTrack);
        job.progress = Math.round(30 + ((index + 1) / voices.length) * 65);
      }
      job.stage = 'Your harmony is ready';
      job.progress = 100;
      job.status = 'complete';
      if (owner) {
        job.saved = true;
        const removed = store.completeProject(owner, job);
        for (const id of removed) {
          jobs.delete(id);
          owners.delete(id);
          await rm(path.join(jobDir, id), { recursive: true, force: true }).catch(console.error);
        }
      }
    } catch (error) {
      console.error(`Harmony job ${job.id} failed:`, error);
      job.status = 'failed';
      job.stage = 'Unable to create harmonies';
      job.error = error instanceof Error && /no longer than|timed out|no decodable/.test(error.message)
        ? error.message : 'We could not decode this recording. Try a valid MP3, M4A, or an MP4 with an audio track.';
      job.original = undefined;
      job.tracks = [];
      job.saved = false;
      job.expiresAt = new Date(Date.now() + DAY).toISOString();
      if (owner) store.deleteProject(job.id);
      await rm(directory, { recursive: true, force: true }).catch(console.error);
    } finally {
      await Promise.all([rm(input, { force: true }), rm(wav, { force: true }), rm(pcm, { force: true })]).catch(console.error);
      activeJobs--;
    }
  }

  app.post('/api/jobs', (req, res, next) => {
    if (activeJobs >= 2) { res.status(429).json({ error: 'The studio is busy. Please try again in a moment.' }); return; }
    activeJobs++; // Reserve before accepting a multipart body.
    upload.single('file')(req, res, (error) => {
      void (async () => {
        if (error) throw error;
        const parts = Number(req.body?.parts);
        const mode = req.body?.mode;
        const rangeSelection = req.body?.voiceRange ?? 'auto';
        const style = req.body?.style ?? 'modern-pop';
        if (!req.file || ![2, 3, 4].includes(parts) || !['major', 'minor'].includes(mode) || !['auto', ...Object.keys(VOICE_RANGES)].includes(rangeSelection) || !Object.hasOwn(HARMONY_STYLES, style)) {
          res.status(400).json({ error: 'Choose a supported audio file, 2–4 parts, a major or minor harmony, a valid voice range, and a supported harmony style.' });
          if (req.file) await rm(req.file.path, { force: true });
          activeJobs--;
          return;
        }
        const id = randomUUID();
        const directory = path.join(jobDir, id);
        await mkdir(directory);
        const now = Date.now();
        const owner: string | undefined = res.locals.user?.id;
        const job: HarmonyJob = {
          id, status: 'processing', stage: 'Reading your recording', progress: 5,
          parts: parts as PartCount, mode, style: style as HarmonyStyle, rangeSelection: rangeSelection as RangeSelection,
          sourceName: path.basename(req.file.originalname), createdAt: new Date(now).toISOString(),
          expiresAt: owner ? null : new Date(now + DAY).toISOString(), saved: false, tracks: [],
        };
        if (owner) { store.putProject(owner, job); owners.set(id, owner); }
        jobs.set(id, job);
        res.status(202).json(job);
        void processJob(job, req.file.path, directory, owner);
      })().catch(async (error) => {
        activeJobs--;
        if (req.file) await rm(req.file.path, { force: true }).catch(console.error);
        next(error);
      });
    });
  });

  app.get('/api/jobs/:id', (req, res) => {
    const job = accessibleJob(req.params.id, res.locals.user?.id);
    res.setHeader('Cache-Control', 'no-store');
    if (!job || (job.expiresAt && Date.parse(job.expiresAt) <= Date.now())) { res.status(404).json({ error: 'This project is unavailable or has expired. Sign in to its account or upload your recording again.' }); return; }
    res.json(job);
  });

  app.get('/api/jobs/:id/files/:name', (req, res, next) => {
    const job = accessibleJob(req.params.id, res.locals.user?.id);
    const file = job && [job.original, ...job.tracks].find((item) => item?.name === req.params.name);
    if (!job || job.status !== 'complete' || (job.expiresAt && Date.parse(job.expiresAt) <= Date.now()) || !file) {
      res.status(404).json({ error: 'This audio file is unavailable or has expired.' }); return;
    }
    const filename = path.join(jobDir, job.id, file.name);
    res.setHeader('Cache-Control', 'private, max-age=0');
    // The storage root is intentionally hidden (.data). Only allowlisted job files reach this point.
    if (req.query.download === '1') res.download(filename, file.name, { dotfiles: 'allow' }, (error) => { if (error) next(error); });
    else res.sendFile(filename, { dotfiles: 'allow' }, (error) => { if (error) next(error); });
  });

  app.use('/api', (_req, res) => { res.status(404).json({ error: 'API route not found.' }); });
  const clientDir = path.join(root, 'dist/client');
  if (existsSync(path.join(clientDir, 'index.html'))) {
    app.use(express.static(clientDir));
    app.get('/{*path}', (_req, res) => { res.sendFile(path.join(clientDir, 'index.html')); });
  }

  app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (res.headersSent) return;
    if (error instanceof multer.MulterError) {
      res.status(400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'Your file is too large. The limit is 50 MB.' : 'Upload one file with only parts, mode, voiceRange, and style options.' });
    } else {
      res.status(400).json({ error: error.message === 'Please upload an MP3, MP4, or M4A file.' ? error.message : 'The upload could not be completed. Please try again.' });
    }
  });

  async function cleanup() {
    store.cleanupSessions();
    for (const [id, job] of jobs) {
      if (job.status !== 'processing' && job.expiresAt && Date.parse(job.expiresAt) <= Date.now()) {
        await rm(path.join(jobDir, id), { recursive: true, force: true });
        jobs.delete(id);
        owners.delete(id);
      }
    }
    // Includes abandoned files from a previous server process.
    for (const parent of [uploadDir, jobDir]) {
      for (const entry of await readdir(parent, { withFileTypes: true })) {
        if (parent === jobDir && (jobs.get(entry.name)?.status === 'processing' || store.project(entry.name))) continue;
        const filename = path.join(parent, entry.name);
        if (Date.now() - (await stat(filename)).mtimeMs > DAY) await rm(filename, { recursive: entry.isDirectory(), force: true });
      }
    }
  }
  await cleanup();
  const timer = setInterval(() => { void cleanup().catch(console.error); }, 60 * 60 * 1000);
  timer.unref();
  return { app, dispose: () => { clearInterval(timer); store.close(); } };
}
