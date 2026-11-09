# Harmonizer

A TypeScript React + Express app that turns an MP3, M4A, or the audio from an MP4 into downloadable parallel harmony tracks.

## Run locally

Requires Node.js 22.13 or newer (Node 24 recommended). Account storage uses the built-in SQLite module.

```sh
npm install
npm run dev
```

Open http://127.0.0.1:5173. Vite proxies `/api` to Express on port 3001. The bundled `ffmpeg-static` binary is downloaded during installation; no API keys or paid services are needed. If the download is blocked, install FFmpeg separately and set `FFMPEG_PATH` to the full binary path before starting the server (install dependencies with `npm install --ignore-scripts` in that case).

```powershell
$env:FFMPEG_PATH = 'C:/ffmpeg/bin/ffmpeg.exe'
npm run dev
```

## Use

1. Upload or drop one MP3, MP4, or M4A (50 MB maximum, up to 10 minutes). M4A audio is automatically converted for MP3 harmony output.
2. Choose 2, 3, or 4 total parts, including the original.
3. Choose **Modern Pop** (default), **Neo-Soul / R&B**, or **Traditional / Hymn**, and major or minor harmony color. Leave your singing range on **Detect from my recording**, or select Bass, Baritone, Tenor, Alto, Mezzo-soprano, or Soprano manually. Then generate.
4. Preview the original and individual harmony tracks, listen together, and download each MP3.

Or click **Record audio**, allow microphone access, sing or play, then click **Stop recording**. The app converts your take to a real MP3 and automatically selects it as the input. You can preview it, then click **Generate harmonies**. Microphone recording requires localhost or HTTPS and a browser with MediaRecorder support. Recording stops automatically just before 10 minutes. Your microphone is released immediately when recording stops. If conversion fails, retry it or save the raw take without recording again.

### Accounts and saved projects

Use **Create account** with an email and a 12–128 character password, or **Sign in** to an existing account. Sign in **before generating**: successful projects save automatically, including the original MP3, harmony tracks, settings, and detected range. **My projects** opens your library, where you can reopen projects to play and download their audio. Only the owner can view a saved project or stream/download its files. Guests can still use the studio, with temporary projects.

Each account keeps its **latest 10 successful projects**, ordered by creation time. Completing an 11th removes the oldest project's metadata and audio; unfinished/failed jobs do not displace completed projects. The library explains this retention rule. Download projects you want to keep outside the latest 10. Saved projects and login sessions survive server restarts.

Metadata and accounts are stored in `.data/harmonizer.sqlite` (with SQLite WAL files); audio remains under `.data/jobs/`. Preserve/back up the entire data directory. This is persistent local storage for a single server instance; cloud object storage and distributed background workers remain future work. Interrupted in-progress projects are removed on restart; the last 10 successful projects remain.

Passwords use salted scrypt (N=32768, r=8, p=3), and opaque session tokens are stored as SHA-256 hashes. Browser sessions last 30 days in HttpOnly, SameSite=Lax cookies; logout revokes the current token. Auth requests are rate limited and cross-site mutations are rejected. Set `COOKIE_SECURE=true` and `APP_ORIGIN` to your public HTTPS frontend origin when deploying behind a proxy. Development allows the Vite origin `http://127.0.0.1:5173`; production (`NODE_ENV=production`) requires same-origin requests or an explicitly configured `APP_ORIGIN`. Email is an account identifier; email verification, password reset, and social sign-in are not included yet.

| Total parts | Generated tracks |
| --- | --- |
| 2 | `audio_tenor.mp3` |
| 3 | `audio_tenor.mp3`, `audio_alto.mp3` |
| 4 | `audio_tenor.mp3`, `audio_alto.mp3`, `audio_bass.mp3` |

The converted `audio_original.mp3` is also playable and downloadable. Existing filenames `audio_tenor.mp3`, `audio_alto.mp3`, and `audio_bass.mp3` identify the first, second, and third generated layers for compatibility; they do not claim a singer range or fixed musical interval. Track labels show the actual interval role.

### Harmony styles

| Style | 2 parts adds | 3 parts also adds | 4 parts also adds |
| --- | --- | --- | --- |
| Modern Pop (default) | Third | Sixth | Ninth |
| Neo-Soul / R&B | Third | Seventh | Ninth |
| Traditional / Hymn | Fifth | Third | Octave |

Modern Pop uses +4/+9/+14 semitones in major and +3/+8/+14 in minor before octave fitting. Neo-Soul uses +4/+11/+14 in major and +3/+10/+14 in minor. Traditional retains the previous −5, +4 (or +3), −12 stack. Range fitting chooses octave-equivalent notes, so a ninth may become a closer second, or a sixth a third below. Modern styles prefer their intended upper placement when the range permits; the range constraint takes priority. All presets keep the original audio unchanged. A two-part modern result is a third rather than a fifth; choose 3–4 parts to hear the extra sixth/seventh/ninth color.

These are voicing presets, not models trained on those genres. They change the audible interval palette but still follow the original melody in parallel; they do not create independent rhythmic lines or detect chord changes.

### Range detection

Generation analyzes up to 400 frames spread across the whole recording using a bounded [YIN-style fundamental frequency estimator](https://pubmed.ncbi.nlm.nih.gov/12002874/). Silence and low-confidence/unpitched frames are excluded. The 5th and 95th percentiles give the displayed sung-note range; the median maps to the nearest configured register center. The UI labels this an **estimated register**, with limited-sample feedback for short/narrow clips. A single recording cannot establish a singer's full range or classical voice type, and accompaniment can confuse detection. Use a clean solo recording and the manual override when needed.

Approximate editable presets in `app/shared/types.ts`: Bass E2–E4, Baritone G2–G4, Tenor C3–C5, Alto F3–F5, Mezzo A3–A5, Soprano C4–C6. These are application heuristics, not measured personal limits. Voicing penalizes notes outside the preset and chooses equivalent intervals in another octave; it does not transpose the original. If no constant shift can fit a whole part, its note range is shown with a warning. With no reliable detected pitch, the app reports that explicitly and uses upward intervals rather than assuming a low octave.

### Audio behavior and limits

This MVP produces **fixed-interval pitch-shifted copies with style and range-aware octave placement**, preserving duration. It does not analyze key or chord changes, compose independent vocal lines, synthesize different singers, or separate vocals from accompaniment. Best results come from a clean, monophonic vocal/melody. Parallel intervals, especially sevenths and ninths, can clash as chords change; a full mix also shifts all instruments. Major/minor changes the third and style-specific color tones. Traditional two-part results use the same fifth in either mode.

Processing uses FFmpeg's Rubber Band filter with preserved formants when available, otherwise sample-rate shifting with tempo compensation. See the [FFmpeg filter documentation](https://ffmpeg.org/ffmpeg-filters.html#rubberband). Playback together starts the browser audio elements concurrently; export tracks into a DAW for sample-accurate mixing. The waveform artwork in the empty state is decorative, not an analysis of the uploaded recording.

## Structure

```text
app/
  App.tsx              React studio interface
  main.tsx
  styles.css
  api/                 Express backend
    index.ts           Server entry point
    server.ts          Uploads, jobs, file streaming, cleanup
  shared/types.ts      Shared API types and limits
tools/audio.ts         FFmpeg conversion and pitch-shift tools
tools/pitch.ts         Pitch detection, register estimates, note names
tests/api.test.ts      Real audio conversion and API tests
```

`POST /api/jobs` accepts multipart `file`, `parts` (2–4), `mode` (`major`/`minor`), optional `voiceRange` (`auto` by default, or `bass`, `baritone`, `tenor`, `alto`, `mezzo`, `soprano`), and optional `style` (`modern-pop` by default, `neo-soul`, or `hymn`), returning a job with HTTP 202. Poll `GET /api/jobs/:id` for progress, selected style, pitch analysis, target range, and track URLs. Completed files support HTTP range playback; append `?download=1` for download. `GET /api/health` checks the processing engine.

`POST /api/recordings` accepts one multipart `file` in browser-recorded WebM, Ogg, MP4, or M4A format and returns an `audio/mpeg` MP3. It shares the two-worker processing limit, enforces the same upload/duration limits, and removes conversion files after responding. The frontend keeps the resulting MP3 as the selected file; generating harmonies uses the existing MP3 upload flow.

Temporary files live in ignored `.data/`. Guest projects expire after 24 hours; restarting the backend makes guest sessions inaccessible. Expired guest/abandoned files are cleaned hourly and at startup. Saved account projects are excluded from temporary cleanup and retained until they leave the account's latest 10. Two audio jobs can run at once; additional uploads receive HTTP 429.

Account API: `POST /api/auth/register` and `POST /api/auth/login` accept JSON `email` and `password` and set a session cookie. `GET /api/auth/session` returns the current user (or null); `POST /api/auth/logout` revokes the session. `GET /api/projects` requires authentication and returns only that account's latest 10 completed projects. Existing job and file endpoints check ownership for account projects and return 404 to other users.

## Build and verify

```sh
npm run typecheck
npm test
npm run build
npm start
```

`npm start` serves the built React app and API together at http://127.0.0.1:3001. `PORT`, `HOST`, `DATA_DIR`, `COOKIE_SECURE`, and `FFMPEG_PATH` can be set in the environment; `.env.example` documents defaults (the app does not automatically load `.env`). The server binds to loopback by default. Public deployment requires HTTPS with secure cookies, persistent disk, and appropriate upload quotas and a persistent worker queue; audio processing requires a Node host capable of running FFmpeg, not static hosting.

Tests generate real MP3, MP4, and M4A fixtures, exercise 2–4 parts, decode downloads to verify pitch and duration, check range streaming, and reject invalid uploads and overly long recordings.

## Later

- Durable object storage and background workers.
- Key/chord-aware harmonization and vocal isolation.

The shared job/track types and isolated audio tools provide seams for these additions. Accounts and the latest 10 saved projects per account are implemented using local SQLite and disk storage.
