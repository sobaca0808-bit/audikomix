const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const viewer = require('../viewer-controls.js');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness({ native = false, request, exit, fullscreenEnabled, onMasterChange } = {}) {
  class Target {
    constructor() { this.listeners = new Map(); }
    addEventListener(name, listener) {
      if (!this.listeners.has(name)) this.listeners.set(name, new Set());
      this.listeners.get(name).add(listener);
    }
    removeEventListener(name, listener) { this.listeners.get(name)?.delete(listener); }
    dispatch(name, event = {}) { return [...(this.listeners.get(name) || [])].map(listener => listener(event)); }
  }
  const document = new Target();
  class Element extends Target {
    constructor(id) {
      super(); this.id = id; this.value = ''; this.textContent = ''; this.attributes = {};
      this.disabled = false; this.hidden = false; this.isConnected = true;
      const classes = new Set();
      this.classList = { contains: name => classes.has(name), add: name => classes.add(name),
        toggle(name, value) { if (value) classes.add(name); else classes.delete(name); } };
      this.style = { properties: {}, setProperty(name, value) { this.properties[name] = value; } };
    }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name] ?? null; }
    focus() { document.activeElement = this; }
    getClientRects() { return this.hidden ? [] : [{}]; }
  }
  const ids = Object.fromEntries(['cinema-player', 'mute', 'volume-icon', 'master-volume', 'master-volume-value',
    'subtitle-size', 'subtitle-size-value', 'fullscreen', 'fullscreen-label', 'viewer-status'].map(id => [id, new Element(id)]));
  document.body = new Element('body');
  document.body.classList.add('site-theme');
  document.getElementById = id => ids[id] || null;
  document.fullscreenElement = null;
  document.fullscreenEnabled = fullscreenEnabled;
  const outside = new Element('outside');
  document.activeElement = outside;
  const player = ids['cinema-player'];
  player.classList.add('player');
  const focusables = [ids.mute, ids['master-volume'], ids['subtitle-size'], ids.fullscreen];
  player.querySelectorAll = () => focusables;
  player.contains = element => Object.values(ids).includes(element);
  const calls = { master: [], request: 0, exit: 0 };
  if (native) {
    player.requestFullscreen = () => {
      calls.request += 1;
      if (request) return request({ document, player, calls });
      document.fullscreenElement = player;
      document.dispatch('fullscreenchange');
      return Promise.resolve();
    };
    document.exitFullscreen = () => {
      calls.exit += 1;
      if (exit) return exit({ document, player, calls });
      document.fullscreenElement = null;
      document.dispatch('fullscreenchange');
      return Promise.resolve();
    };
  }
  let state = { volume: 1, muted: false }, remembered = 1;
  const audio = {
    getMasterState() { return { ...state, effectiveVolume: state.muted ? 0 : state.volume }; },
    setMasterVolume(value) {
      calls.master.push(['volume', value]);
      state.volume = value; state.muted = value === 0;
      if (value > 0) remembered = value;
    },
    toggleMuted() {
      calls.master.push(['toggle']);
      if (state.muted || state.volume === 0) {
        if (state.volume === 0) state.volume = remembered;
        state.muted = false;
      } else state.muted = true;
    }
  };
  for (const method of ['prepare', 'play', 'pause', 'stop', 'tick', 'setVolume']) {
    audio[method] = () => { throw new Error('Viewer controls must not call transport or individual tracks: ' + method); };
  }
  const controller = viewer.create({ document, window: {}, audio, onMasterChange });
  return {
    document, ids, player, audio, controller, calls, outside,
    async click(id) { if (!ids[id].disabled) await Promise.all(ids[id].dispatch('click')); },
    async input(id, value) { ids[id].value = String(value); await Promise.all(ids[id].dispatch('input')); },
    key(key, shiftKey = false) {
      const event = { key, shiftKey, prevented: false, preventDefault() { this.prevented = true; } };
      document.dispatch('keydown', event); return event;
    }
  };
}

test('browser export and default controls are ready before any audio context or playback', () => {
  const sandbox = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../viewer-controls.js'), 'utf8'), sandbox);
  assert.equal(typeof sandbox.window.AlleyViewerControls.create, 'function');
  const h = harness();
  assert.equal(h.ids['master-volume'].value, '100');
  assert.equal(h.ids['master-volume-value'].textContent, '100%');
  assert.equal(h.ids.mute.getAttribute('aria-pressed'), 'false');
  assert.equal(h.ids.mute.getAttribute('aria-label'), 'Отключить звук');
  assert.equal(h.ids['volume-icon'].getAttribute('data-muted'), 'false');
  assert.equal(h.player.style.properties['--subtitle-scale'], '1');
  assert.equal(h.ids.fullscreen.getAttribute('aria-pressed'), 'false');
  assert.deepEqual(h.calls.master, []);
  assert.equal(h.calls.request, 0);
  assert.equal(viewer.create({ document: h.document, audio: h.audio }), h.controller);
});

test('volume and repeated mute restore the chosen level without any transport calls', async () => {
  const h = harness();
  await h.input('master-volume', 37);
  assert.equal(h.audio.getMasterState().effectiveVolume, .37);
  await h.click('mute');
  assert.equal(h.ids['master-volume'].value, '0');
  assert.equal(h.ids['master-volume-value'].textContent, '0%');
  assert.equal(h.ids.mute.getAttribute('aria-pressed'), 'true');
  assert.equal(h.ids['volume-icon'].getAttribute('data-muted'), 'true');
  assert.equal(h.ids.mute.getAttribute('aria-label'), 'Включить звук');
  await h.click('mute');
  assert.equal(h.ids['master-volume'].value, '37');
  await h.input('master-volume', 0);
  await h.click('mute');
  assert.equal(h.ids['master-volume'].value, '37', 'zero slider restores the previous positive level');
  await h.click('mute');
  await h.input('master-volume', 80);
  assert.equal(h.ids.mute.getAttribute('aria-pressed'), 'false');
  assert.equal(h.audio.getMasterState().effectiveVolume, .8);
});

test('master callbacks receive one independent before/after snapshot per valid action', async () => {
  const changes = [];
  const h = harness({ onMasterChange: (next, previous) => changes.push({ next, previous }) });
  await h.input('master-volume', 25);
  await h.click('mute');
  await h.click('mute');
  assert.deepEqual(changes.map(change => [change.previous.effectiveVolume, change.next.effectiveVolume]), [[1, .25], [.25, 0], [0, .25]]);
  assert.equal(changes[0].next.volume, .25);
  await h.input('master-volume', -50);
  assert.equal(h.audio.getMasterState().effectiveVolume, 0);
  await h.input('master-volume', 200);
  assert.equal(h.audio.getMasterState().effectiveVolume, 1);
  const count = changes.length;
  for (const value of ['', ' ', 'NaN', 'Infinity']) await h.input('master-volume', value);
  assert.equal(changes.length, count);
  assert.equal(h.ids['master-volume'].value, '100');
});

test('an optional observer failure cannot break volume controls', async () => {
  for (const onMasterChange of [() => { throw new Error('observer'); }, () => Promise.reject(new Error('observer'))]) {
    const h = harness({ onMasterChange });
    await h.click('mute');
    assert.equal(h.ids['master-volume'].value, '0');
    await h.click('mute');
    assert.equal(h.ids['master-volume'].value, '100');
  }
});

test('subtitle size is bounded, accessible, and changes only the CSS scale', async () => {
  const h = harness();
  await h.input('subtitle-size', 125);
  assert.equal(h.player.style.properties['--subtitle-scale'], '1.25');
  assert.equal(h.ids['subtitle-size-value'].textContent, '125%');
  assert.equal(h.ids['subtitle-size'].getAttribute('aria-valuetext'), '125%');
  await h.input('subtitle-size', 84); assert.equal(h.ids['subtitle-size'].value, '85');
  await h.input('subtitle-size', 999); assert.equal(h.ids['subtitle-size'].value, '140');
  await h.input('subtitle-size', 108); assert.equal(h.ids['subtitle-size'].value, '110');
  for (const value of ['', ' ', 'invalid', 'Infinity']) await h.input('subtitle-size', value);
  assert.equal(h.player.style.properties['--subtitle-scale'], '1.1');
  assert.deepEqual(h.calls.master, []);
});

test('native fullscreen targets the whole player and tracks exit without affecting playback', async () => {
  const h = harness({ native: true });
  await h.click('fullscreen');
  assert.equal(h.document.fullscreenElement, h.player);
  assert.equal(h.ids.fullscreen.getAttribute('aria-pressed'), 'true');
  assert.equal(h.ids['fullscreen-label'].textContent, 'Выйти');
  assert.equal(h.ids.fullscreen.disabled, false);
  assert.equal(h.player.classList.contains('is-expanded'), false);
  await h.click('fullscreen');
  assert.equal(h.document.fullscreenElement, null);
  assert.equal(h.ids.fullscreen.getAttribute('aria-pressed'), 'false');
  assert.equal(h.document.activeElement, h.outside);
  assert.equal(h.calls.request, 1); assert.equal(h.calls.exit, 1);
  assert.deepEqual(h.calls.master, []);
});

test('external native fullscreen changes keep labels and focus correct', async () => {
  const h = harness({ native: true });
  await h.click('fullscreen');
  h.document.fullscreenElement = null;
  h.document.dispatch('fullscreenchange');
  assert.equal(h.ids.fullscreen.getAttribute('aria-pressed'), 'false');
  assert.equal(h.ids.fullscreen.disabled, false);
  assert.equal(h.document.activeElement, h.outside);
  assert.equal(h.player.classList.contains('is-expanded'), false);
  h.document.fullscreenElement = h.player;
  h.document.dispatch('fullscreenchange');
  assert.equal(h.ids.fullscreen.getAttribute('aria-pressed'), 'true');
  assert.equal(h.document.fullscreenElement, h.player);
  assert.equal(h.calls.exit, 0, 'an unrelated later entry is not a cancelled request');
});

test('unsupported fullscreen expands in the browser, traps Tab, and Escape restores focus', async () => {
  const h = harness({ native: true, fullscreenEnabled: false });
  await h.click('fullscreen');
  assert.equal(h.calls.request, 0);
  assert.equal(h.player.classList.contains('is-expanded'), true);
  assert.equal(h.document.body.classList.contains('viewer-expanded'), true);
  assert.equal(h.ids['fullscreen-label'].textContent, 'Свернуть');
  assert.match(h.ids['viewer-status'].textContent, /развёрнут/);
  h.ids.fullscreen.focus();
  assert.equal(h.key('Tab').prevented, true);
  assert.equal(h.document.activeElement, h.ids.mute);
  assert.equal(h.key('Tab', true).prevented, true);
  assert.equal(h.document.activeElement, h.ids.fullscreen);
  assert.equal(h.key('Escape').prevented, true);
  assert.equal(h.player.classList.contains('is-expanded'), false);
  assert.equal(h.document.body.classList.contains('viewer-expanded'), false);
  assert.equal(h.document.body.classList.contains('site-theme'), true);
  assert.equal(h.player.classList.contains('player'), true);
  assert.equal(h.document.activeElement, h.outside);
  await h.click('fullscreen'); await h.click('fullscreen');
  assert.equal(h.player.classList.contains('is-expanded'), false);
});

test('rejected or throwing native requests fall back with an accessible exit', async () => {
  for (const request of [() => Promise.reject(new Error('denied')), () => { throw new Error('denied'); }]) {
    const h = harness({ native: true, request });
    await h.click('fullscreen');
    assert.equal(h.player.classList.contains('is-expanded'), true);
    assert.equal(h.ids.fullscreen.disabled, false);
    assert.equal(h.ids.fullscreen.getAttribute('aria-pressed'), 'true');
    assert.match(h.ids['viewer-status'].textContent, /Полный экран недоступен/);
    await h.click('fullscreen');
    assert.equal(h.player.classList.contains('is-expanded'), false);
  }
});

test('rapid requests are guarded and Escape cancels a native entry that resolves later', async () => {
  const wait = deferred();
  const h = harness({ native: true, request: ({ document, player }) => wait.promise.then(() => {
    document.fullscreenElement = player; document.dispatch('fullscreenchange');
  }) });
  const first = h.click('fullscreen');
  assert.equal(h.ids.fullscreen.disabled, true);
  await h.click('fullscreen'); assert.equal(h.calls.request, 1);
  h.key('Escape');
  assert.equal(h.ids.fullscreen.disabled, false);
  wait.resolve(); await first; await Promise.resolve();
  assert.equal(h.document.fullscreenElement, null);
  assert.equal(h.player.classList.contains('is-expanded'), false);
  assert.equal(h.ids.fullscreen.getAttribute('aria-pressed'), 'false');
  assert.equal(h.calls.exit, 1);
});

test('fullscreenerror clears pending UI, and late completion cannot reopen a closed fallback', async () => {
  const wait = deferred();
  const h = harness({ native: true, request: ({ document, player }) => wait.promise.then(() => {
    document.fullscreenElement = player; document.dispatch('fullscreenchange');
  }) });
  const first = h.click('fullscreen');
  h.document.dispatch('fullscreenerror');
  assert.equal(h.ids.fullscreen.disabled, false);
  assert.equal(h.player.classList.contains('is-expanded'), true);
  h.key('Escape'); wait.resolve(); await first; await Promise.resolve();
  assert.equal(h.document.fullscreenElement, null);
  assert.equal(h.player.classList.contains('is-expanded'), false);
});

test('a rejected native exit stays usable and tells the viewer how to leave', async () => {
  const h = harness({ native: true, exit: () => Promise.reject(new Error('denied')) });
  await h.click('fullscreen'); await h.click('fullscreen');
  assert.equal(h.document.fullscreenElement, h.player);
  assert.equal(h.ids.fullscreen.disabled, false);
  assert.equal(h.ids.fullscreen.getAttribute('aria-pressed'), 'true');
  assert.match(h.ids['viewer-status'].textContent, /Esc/);
  assert.equal(h.player.classList.contains('is-expanded'), false);
});

test('destroy removes listeners and only its own fallback classes, with safe reinitialization', async () => {
  const h = harness();
  await h.click('fullscreen');
  h.controller.destroy(); h.controller.destroy();
  assert.equal(h.player.classList.contains('is-expanded'), false);
  assert.equal(h.document.body.classList.contains('viewer-expanded'), false);
  assert.equal(h.document.body.classList.contains('site-theme'), true);
  await h.click('mute');
  assert.deepEqual(h.calls.master, []);
  const next = viewer.create({ document: h.document, audio: h.audio });
  assert.notEqual(next, h.controller);
  await h.click('mute'); assert.deepEqual(h.calls.master, [['toggle']]);
});
