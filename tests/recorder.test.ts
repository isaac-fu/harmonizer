import { after, afterEach, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import App from '../app/App.js';
import PracticeStudio from '../app/PracticeStudio.js';
import type { HarmonyJob } from '../app/shared/types.js';

let dom: JSDOM;
let root: Root;
let container: HTMLDivElement;
let released = 0;
let permissionDenied = false;
let conversionFails = false;
let conversions = 0;
let latestRecorder: FakeRecorder;
let practiceJob: HarmonyJob;
let saveFails = false;
const played: string[] = [];
const originals = new Map<string, PropertyDescriptor | undefined>();
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

class FakeRecorder {
  static isTypeSupported(type: string) { return type.startsWith('audio/webm'); }
  state = 'inactive';
  mimeType = 'audio/webm;codecs=opus';
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() { latestRecorder = this; }
  start() { this.state = 'recording'; }
  stop() {
    this.state = 'inactive';
    queueMicrotask(() => {
      this.ondataavailable?.({ data: new Blob(['simulated microphone audio'], { type: this.mimeType }) });
      this.onstop?.();
    });
  }
}

function setGlobal(name: string, value: unknown) {
  originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

before(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost' });
  setGlobal('window', dom.window);
  setGlobal('document', dom.window.document);
  setGlobal('HTMLAudioElement', dom.window.HTMLAudioElement);
  setGlobal('navigator', { mediaDevices: { getUserMedia: async () => {
    if (permissionDenied) throw new DOMException('Denied', 'NotAllowedError');
    const track = { stop: () => { released++; }, onended: null };
    return { getTracks: () => [track], getAudioTracks: () => [track] };
  } } });
  setGlobal('MediaRecorder', FakeRecorder);
  setGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  setGlobal('fetch', async (url: string, options: RequestInit) => {
    if (url === '/api/auth/session') return Response.json({ user: null });
    if (url.startsWith('/api/jobs/practice/takes/')) {
      if (saveFails) return Response.json({ error: 'Could not save this take.' }, { status: 500 });
      const sourceTrackName = url.split('/').at(-1)!;
      const existing = practiceJob.takes ?? [];
      practiceJob = { ...practiceJob, takes: [...existing.filter(take => take.sourceTrackName !== sourceTrackName), {
        name: `self_${sourceTrackName}`, label: 'Your take', sourceTrackName, semitones: 0,
        url: `/self_${sourceTrackName}?v=${conversions}`, downloadUrl: `/self_${sourceTrackName}?download=1`,
      }] };
      return Response.json(practiceJob);
    }
    assert.equal(url, '/api/recordings');
    assert.equal(options.method, 'POST');
    const input = (options.body as FormData).get('file') as File;
    assert.match(input.name, /\.webm$/);
    assert.ok(input.size > 0);
    conversions++;
    return conversionFails ? Response.json({ error: 'The studio is busy. Please retry.' }, { status: 429 })
      : new Response(new Blob(['converted MP3'], { type: 'audio/mpeg' }), { status: 200 });
  });
  URL.createObjectURL = () => 'blob:recording-preview';
  URL.revokeObjectURL = () => {};
  dom.window.HTMLMediaElement.prototype.pause = function () { Object.defineProperty(this, 'paused', { configurable: true, value: true }); };
  dom.window.HTMLMediaElement.prototype.play = async function () {
    played.push(this.src);
    Object.defineProperty(this, 'paused', { configurable: true, value: false });
    this.dispatchEvent(new dom.window.Event('play'));
  };
});

beforeEach(async () => {
  released = 0; conversions = 0; permissionDenied = false; conversionFails = false;
  saveFails = false; played.length = 0;
  container = dom.window.document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(React.createElement(App)));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

after(() => {
  dom.window.close();
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
});

function button(label: string) {
  const element = [...container.querySelectorAll('button')].find(item => item.textContent?.trim() === label);
  assert.ok(element, `Button missing: ${label}`);
  return element;
}

test('Record → Stop releases the microphone, converts to MP3, and automatically selects the take', async () => {
  await act(async () => button('Record audio').click());
  assert.equal(latestRecorder.state, 'recording');
  assert.equal(button('Stop recording').disabled, false);
  assert.equal(button('Generate harmonies').disabled, true);
  assert.equal(container.querySelector<HTMLInputElement>('input[type=file]')!.disabled, true);
  await act(async () => button('Stop recording').click());
  assert.ok(released > 0);
  assert.equal(conversions, 1);
  assert.match(container.querySelector('.file-name')!.textContent!, /^recording-.*\.mp3$/);
  assert.ok(container.querySelector('audio[aria-label="Uploaded recording preview"]'));
  assert.equal(button('Generate harmonies').disabled, false);
});

test('permission denial shows an actionable error and restores the input controls', async () => {
  permissionDenied = true;
  await act(async () => button('Record audio').click());
  assert.match(container.querySelector('[role=alert]')!.textContent!, /Microphone access was denied/);
  assert.equal(button('Record audio').disabled, false);
  assert.equal(container.querySelector<HTMLInputElement>('input[type=file]')!.disabled, false);
  assert.equal(conversions, 0);
});

test('failed conversion keeps the take and retry selects the converted MP3', async () => {
  conversionFails = true;
  await act(async () => button('Record audio').click());
  await act(async () => button('Stop recording').click());
  assert.match(container.querySelector('[role=alert]')!.textContent!, /studio is busy/);
  assert.ok(button('Save raw take'));
  conversionFails = false;
  await act(async () => button('Retry conversion').click());
  assert.equal(conversions, 2);
  assert.match(container.querySelector('.file-name')!.textContent!, /\.mp3$/);
  assert.equal(button('Generate harmonies').disabled, false);
  assert.equal(container.querySelector('.recording-recovery'), null);
});

test('leaving the app while recording releases the microphone without converting', async () => {
  await act(async () => button('Record audio').click());
  await act(async () => root.render(null));
  assert.equal(latestRecorder.state, 'inactive');
  assert.ok(released > 0);
  assert.equal(conversions, 0);
});

async function renderPractice() {
  practiceJob = {
    id: 'practice', status: 'complete', stage: 'Ready', progress: 100, parts: 3, mode: 'major', style: 'modern-pop', rangeSelection: 'auto', sourceName: 'melody.mp3', createdAt: new Date().toISOString(), expiresAt: null, saved: true,
    tracks: [
      { name: 'audio_tenor.mp3', label: 'Third harmony', url: '/guide-third.mp3', downloadUrl: '/guide-third.mp3?download=1', semitones: 4 },
      { name: 'audio_alto.mp3', label: 'Sixth harmony', url: '/guide-sixth.mp3', downloadUrl: '/guide-sixth.mp3?download=1', semitones: 9 },
    ],
  };
  function Harness() {
    const [job, update] = React.useState(practiceJob);
    return React.createElement(PracticeStudio, { job, onUpdate: update, onBusyChange: () => {}, stopGenerated: () => {} });
  }
  await act(async () => root.render(React.createElement(Harness)));
}

test('each part can be recorded/downloaded and group playback uses only self-recorded takes', async () => {
  await renderPractice();
  assert.equal(button('Play my recorded harmonies together').disabled, true);
  await act(async () => button('Record Third harmony').click());
  assert.equal(button('Record Sixth harmony').disabled, true);
  await act(async () => button('Stop recording').click());
  assert.ok(container.querySelector('a[aria-label="Download your Third harmony take"]'));
  await act(async () => button('Record Sixth harmony').click());
  await act(async () => button('Stop recording').click());
  assert.ok(container.querySelector('a[aria-label="Download your Sixth harmony take"]'));
  assert.match(container.textContent!, /2\/2 parts recorded/);
  await act(async () => button('Play my recorded harmonies together').click());
  assert.equal(played.length, 2);
  assert.ok(played.every(url => url.includes('/self_')));
  const players = [...container.querySelectorAll<HTMLAudioElement>('.self-take audio')];
  Object.defineProperty(players[0], 'ended', { configurable: true, value: true });
  await act(async () => { players[0].pause(); players[0].dispatchEvent(new dom.window.Event('ended')); });
  assert.equal(players[1].paused, false); // A shorter part must not cut off the longer one.
  assert.ok(button('Pause my recorded harmonies'));
  await act(async () => button('Pause my recorded harmonies').click());
  assert.ok(players.every(player => player.paused));
});

test('failed take saving can retry without changing the original input and a guide interrupts the self mix', async () => {
  await renderPractice();
  saveFails = true;
  await act(async () => button('Record Third harmony').click());
  await act(async () => button('Stop recording').click());
  assert.match(container.querySelector('[role=alert]')!.textContent!, /Could not save/);
  assert.equal(container.querySelector('.self-take'), null);
  saveFails = false;
  await act(async () => button('Retry conversion').click());
  await act(async () => button('Play my recorded harmonies together').click());
  const guide = container.querySelector<HTMLAudioElement>('audio[aria-label="Third harmony practice guide"]')!;
  await act(async () => guide.play());
  assert.equal(container.querySelector<HTMLAudioElement>('.self-take audio')!.paused, true);
  assert.ok(button('Play my recorded harmonies together'));
});
