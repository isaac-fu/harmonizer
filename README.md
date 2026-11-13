# Harmonizer

A TypeScript React + Express app that turns a solo vocal MP3, M4A, or MP4 audio track into downloadable, note-aware harmony parts.

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
3. Choose **Modern Pop**, **Neo-Soul / R&B**, or **Traditional / Hymn**. Set the song's **key and scale**, choose scale guidance or enter timed chords, and optionally adjust the dyad interval and placement. Leave your voice on **Detect from my recording**, or choose your vocal register. Then generate.
4. Preview the original and individual harmony tracks, listen together, and download each MP3.

After generation, **Your turn** provides one practice card per generated harmony. Listen to its guide, click **Record [part]**, imitate the part, and click **Stop recording**. Your own unshifted recording is converted to MP3 and gets its own player and download link. Re-recording replaces only that part's take. **Play my recorded harmonies together** plays all available self-recorded takes from the beginning; it excludes the original and generated guides. Shorter takes can finish without cutting off longer ones. Use consistent starting timing across takes; browser playback does not align different performance entrances automatically. Use headphones if you listen to a guide while recording to avoid microphone bleed.

For signed-in projects, your takes save with the project and reopen from **My projects**, under the same private ownership and latest-10 retention rules. Guest takes use the guest project's temporary lifetime. Failed conversion/upload keeps the raw take available for retry or download.

Or click **Record audio**, allow microphone access, sing or play, then click **Stop recording**. The app converts your take to a real MP3 and automatically selects it as the input. You can preview it, then click **Generate harmonies**. Microphone recording requires localhost or HTTPS and a browser with MediaRecorder support. Recording stops automatically just before 10 minutes. Your microphone is released immediately when recording stops. If conversion fails, retry it or save the raw take without recording again.

### Accounts and saved projects

Use **Create account** with an email and a 12–128 character password, or **Sign in** to an existing account. Sign in **before generating**: successful projects save automatically, including the original MP3, harmony tracks, settings, and detected range. **My projects** opens your library, where you can reopen projects to play/download audio or reuse the saved original and regenerate with different key, scale, dyad, or chord settings. Only the owner can view a saved project or stream/download its files. Guests can still use the studio, with temporary projects.

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

Styles now select **scale-degree targets**, not fixed semitone shifts. Modern Pop favors thirds/sixths/ninths, Neo-Soul thirds/sevenths/ninths, and Hymn fifths/thirds/octaves. The dyad control overrides the first part with a diatonic third, fifth, or sixth. In chord mode, these become voicing preferences: actual targets must belong to the active chord. Scale-mode register fitting chooses a consistent octave for each complete harmony line to avoid abrupt octave jumps at range boundaries. Chord-mode voicing uses a movement penalty to discourage unnecessary leaps. Small pitch fluctuations around note boundaries are held stable while preserving vibrato in the source audio. Explicit Above/Below settings constrain the direction; parts that cannot fit the selected vocal range show a warning.

These are voicing presets, not genre-trained models or independent rhythmic arrangements. Chord changes come from the timeline you enter; there is no automatic chord recognition.

### Key, scale, dyads, and chord changes

The engine tracks the solo melody roughly every 100 ms with YIN and plans each harmony note individually. **Scale mode** constrains pitches to the selected key and Major, Natural minor, Harmonic minor, Dorian, or Mixolydian scale. For example, a third over C–D–E in C major produces E–F–G: the shifts vary (+4, +3, +3 semitones). Source-note rounding retains the original singer's local intonation/vibrato rather than hard-tuning the lead. The original audio itself is never retuned.

**Chord mode** constrains the generated parts to the chord active at each time. Enter up to 32 changes with increasing start times in seconds, beginning at 0, all within the recording. Each chord lasts until the next; the last holds to the end. Major/minor triads, major/minor/dominant sevenths, major/minor ninths, suspended and diminished chords are supported. Chord tones override the scale, allowing borrowed chords. A passing/non-chord tone in the original melody is preserved and may still create tension.

The default is **C major, scale guidance**. Set the actual song key: a solo melody does not uniquely establish a key or backing progression, and the app does not guess them automatically. Each result shows the musical settings and an expandable **View note targets** table. Settings and target plans persist with account projects. Older saved projects retain their original audio and are labeled as earlier fixed-interval projects.

### Range detection

Generation analyzes up to 400 frames spread across the whole recording using a bounded [YIN-style fundamental frequency estimator](https://pubmed.ncbi.nlm.nih.gov/12002874/). Silence and low-confidence/unpitched frames are excluded. The 5th and 95th percentiles give the displayed sung-note range; the median maps to the nearest configured register center. The UI labels this an **estimated register**, with limited-sample feedback for short/narrow clips. A single recording cannot establish a singer's full range or classical voice type, and accompaniment can confuse detection. Use a clean solo recording and the manual override when needed.

Approximate editable presets in `app/shared/types.ts`: Bass E2–E4, Baritone G2–G4, Tenor C3–C5, Alto F3–F5, Mezzo A3–A5, Soprano C4–C6. These are application heuristics, not measured personal limits. Note planning penalizes targets outside the preset; it does not transpose the original. If a part extends outside the preset, its note range shows a warning. Audio without a clear solo melody fails with a useful message instead of silently falling back to fixed shifts.

### Audio behavior and limits

This version produces **note-aware diatonic or chord-constrained vocal harmonies**, preserving duration and the source's phrasing. It does not isolate vocals, automatically recognize keys/chords, synthesize different singers, or compose independent rhythms. Use clean, monophonic audio. Tracking mistakes, wrong key/chord choices, unresolved tones in the unchanged lead, and full instrumental mixes can still sound dissonant. Pitch changes have roughly 100 ms analysis resolution, so fast ornaments/transitions can contain artifacts.

Processing uses time-varying commands to FFmpeg's Rubber Band filter with preserved formants. A build with Rubber Band is required for harmony generation; the bundled binary supports it. There is no fixed-shift fallback for note-aware generation. Breaths and consonants retain the most recent pitch setting rather than being cut out. See the [FFmpeg filter documentation](https://ffmpeg.org/ffmpeg-filters.html#rubberband). Group playback starts browser audio elements concurrently; export tracks into a DAW for sample-accurate mixing. Decorative waveform artwork is not an analysis of the uploaded recording.

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
tools/harmonize.ts     Melody tracking, scale/chord targets, time-varying rendering
tests/api.test.ts      Real audio conversion and API tests
```

`POST /api/jobs` accepts multipart `file`, `parts` (2–4), `mode` (`major`/`minor`), optional `voiceRange` (`auto` by default, or `bass`, `baritone`, `tenor`, `alto`, `mezzo`, `soprano`), and optional `style` (`modern-pop` by default, `neo-soul`, or `hymn`), returning a job with HTTP 202. Poll `GET /api/jobs/:id` for progress, selected style, pitch analysis, target range, and track URLs. Completed files support HTTP range playback; append `?download=1` for download. `GET /api/health` checks the processing engine.

The optional multipart `music` field is JSON: `{ "key": 0, "scale": "major", "strategy": "scale", "dyad": "third", "direction": "auto", "chords": [] }`. Keys are pitch classes 0=C through 11=B; scales are `major`, `minor`, `harmonicMinor`, `dorian`, `mixolydian`; strategy is `scale` or `chords`; dyad is `style`, `third`, `fifth`, `sixth`; direction is `auto`, `above`, `below`. For chord mode use `chords: [{"start":0,"root":0,"quality":"maj7"},{"start":4,"root":9,"quality":"min7"}]`. Supported quality codes are defined in `CHORDS` in the shared types. Older API callers without `music` get C major/C natural minor from `mode`. New tracks include `tuning` and `notePlan`; their legacy `semitones` field is only the first event's shift, not a constant offset for the file.

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
- Automatic chord recognition and vocal isolation.

The shared job/track types and isolated audio tools provide seams for these additions. Accounts and the latest 10 saved projects per account are implemented using local SQLite and disk storage.
