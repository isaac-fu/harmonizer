import { after, afterEach, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createApp } from '../app/api/server.js';
import { runFfmpeg } from '../tools/audio.js';
import type { HarmonyJob } from '../app/shared/types.js';

let root: string;
let dataDir: string;
let service: Awaited<ReturnType<typeof createApp>>;
let fixture: Buffer;
const password = 'a long test password 123!';

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'harmonizer-accounts-'));
  const mp3 = path.join(root, 'melody.mp3');
  await runFfmpeg(['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=130.81:duration=0.8', '-c:a', 'libmp3lame', mp3]);
  fixture = await readFile(mp3);
});
beforeEach(async () => {
  dataDir = await mkdtemp(path.join(root, 'data-'));
  service = await createApp({ dataDir });
});
afterEach(async () => { service.dispose(); });
after(async () => { await rm(root, { recursive: true, force: true }); });

async function register(email: string) {
  const result = await request(service.app).post('/api/auth/register').send({ email, password }).expect(201);
  const cookie = result.headers['set-cookie'][0].split(';')[0];
  return { cookie, user: result.body.user };
}
async function finish(id: string, cookie?: string): Promise<HarmonyJob> {
  for (let i = 0; i < 150; i++) {
    const query = request(service.app).get(`/api/jobs/${id}`);
    if (cookie) query.set('Cookie', cookie);
    const result = await query.expect(200);
    if (result.body.status !== 'processing') return result.body;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Project timed out');
}
async function generate(cookie?: string, name = 'melody.mp3') {
  const upload = request(service.app).post('/api/jobs');
  if (cookie) upload.set('Cookie', cookie);
  const response = await upload.field('parts', '2').field('mode', 'major').attach('file', fixture, name).expect(202);
  const job = await finish(response.body.id, cookie);
  assert.equal(job.status, 'complete', job.error);
  return job;
}

test('accounts normalize email, hash passwords, rotate sessions, and revoke logout', async () => {
  const { cookie, user } = await register('  Alice@Example.com  ');
  assert.equal(user.email, 'alice@example.com');
  assert.deepEqual(Object.keys(user).sort(), ['email', 'id']);
  const session = await request(service.app).get('/api/auth/session').set('Cookie', cookie).expect(200);
  assert.equal(session.body.user.id, user.id);
  await request(service.app).post('/api/auth/register').send({ email: 'alice@example.com', password }).expect(409);
  await request(service.app).post('/api/auth/login').send({ email: 'alice@example.com', password: 'incorrect password 123!' }).expect(401);
  const login = await request(service.app).post('/api/auth/login').set('Cookie', cookie).send({ email: 'ALICE@example.com', password }).expect(200);
  assert.match(login.headers['set-cookie'][0], /HttpOnly/);
  assert.match(login.headers['set-cookie'][0], /SameSite=Lax/);
  const rotated = login.headers['set-cookie'][0].split(';')[0];
  assert.notEqual(rotated, cookie);
  assert.equal((await request(service.app).get('/api/auth/session').set('Cookie', cookie)).body.user, null);
  await request(service.app).post('/api/auth/logout').set('Cookie', rotated).expect(200);
  assert.equal((await request(service.app).get('/api/auth/session').set('Cookie', rotated)).body.user, null);
});

test('account projects and audio are inaccessible to guests and other accounts', async () => {
  const alice = await register('alice@example.com');
  const bob = await register('bob@example.com');
  const job = await generate(alice.cookie);
  assert.equal(job.saved, true);
  assert.equal(job.expiresAt, null);
  await request(service.app).get('/api/projects').expect(401);
  const list = await request(service.app).get('/api/projects').set('Cookie', alice.cookie).expect(200);
  assert.equal(list.body.projects[0].id, job.id);
  assert.equal((await request(service.app).get('/api/projects').set('Cookie', bob.cookie)).body.projects.length, 0);
  await request(service.app).get(`/api/jobs/${job.id}`).expect(404);
  await request(service.app).get(`/api/jobs/${job.id}`).set('Cookie', bob.cookie).expect(404);
  for (const track of [job.original!, ...job.tracks]) {
    await request(service.app).get(track.url).expect(404);
    await request(service.app).get(track.downloadUrl).set('Cookie', bob.cookie).expect(404);
    await request(service.app).get(track.url).set('Cookie', alice.cookie).set('Range', 'bytes=0-99').expect(206);
  }
});

test('account sessions, project settings, and audio survive a server restart', async () => {
  const alice = await register('alice@example.com');
  const job = await generate(alice.cookie);
  service.dispose();
  service = await createApp({ dataDir });
  assert.equal((await request(service.app).get('/api/auth/session').set('Cookie', alice.cookie)).body.user.id, alice.user.id);
  const reopened = await request(service.app).get(`/api/jobs/${job.id}`).set('Cookie', alice.cookie).expect(200);
  assert.equal(reopened.body.style, 'modern-pop');
  assert.equal(reopened.body.saved, true);
  await request(service.app).get(job.tracks[0].downloadUrl).set('Cookie', alice.cookie).expect(200);
  const list = await request(service.app).get('/api/projects').set('Cookie', alice.cookie).expect(200);
  assert.equal(list.body.projects[0].id, job.id);
});

test('only the latest 10 successful projects are kept, with audio removed and owners isolated', async () => {
  const alice = await register('alice@example.com');
  const bob = await register('bob@example.com');
  const bobJob = await generate(bob.cookie);
  const jobs: HarmonyJob[] = [];
  for (let i = 0; i < 11; i++) jobs.push(await generate(alice.cookie, `take-${i}.mp3`));
  const result = await request(service.app).get('/api/projects').set('Cookie', alice.cookie).expect(200);
  assert.equal(result.body.projects.length, 10);
  assert.deepEqual(result.body.projects.map((job: HarmonyJob) => job.id), jobs.slice(1).reverse().map(job => job.id));
  await request(service.app).get(`/api/jobs/${jobs[0].id}`).set('Cookie', alice.cookie).expect(404);
  for (let i = 0; i < 100; i++) {
    const exists = await stat(path.join(dataDir, 'jobs', jobs[0].id)).then(() => true, () => false);
    if (!exists) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  await assert.rejects(stat(path.join(dataDir, 'jobs', jobs[0].id)));
  await request(service.app).get(bobJob.tracks[0].url).set('Cookie', bob.cookie).expect(200);
});

test('guest projects remain temporary and are not included in an account library', async () => {
  const guest = await generate();
  assert.equal(guest.saved, false);
  assert.ok(guest.expiresAt);
  const alice = await register('alice@example.com');
  assert.equal((await request(service.app).get('/api/projects').set('Cookie', alice.cookie)).body.projects.length, 0);
  service.dispose();
  service = await createApp({ dataDir });
  await request(service.app).get(`/api/jobs/${guest.id}`).expect(404);
});

test('auth validates input and blocks cross-site mutations and repeated guessing', async () => {
  await request(service.app).post('/api/auth/register').set('Origin', 'http://127.0.0.1:5173').send({ email: 'preview@example.com', password }).expect(201);
  await request(service.app).post('/api/auth/register').send({ email: 'bad', password: 'short' }).expect(400);
  await request(service.app).post('/api/auth/register').set('Origin', 'https://attacker.example').send({ email: 'alice@example.com', password }).expect(403);
  await request(service.app).post('/api/auth/logout').set('Sec-Fetch-Site', 'cross-site').expect(403);
  for (let i = 0; i < 20; i++) await request(service.app).post('/api/auth/login').send({ email: 'bad', password: 'short' });
  await request(service.app).post('/api/auth/login').send({ email: 'bad', password: 'short' }).expect(429);
});
