const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../audio-engine.js'), 'utf8');

// The fake audio clock evaluates native gain automation and natural buffer ends.
// No recording or audio fixture is added to the project by these tests.
function audioHarness(files = {}, { protocol = 'https:', deferred, loadTimeout = 10000, resume } = {}) {
  const contexts = [];
  const requests = [];
  class Parameter {
    constructor(context) { this.context = context; this.initial = 1; this.events = []; }
    get value() { return this.valueAt(this.context.currentTime); }
    set value(value) { this.initial = value; }
    cancelScheduledValues(time) { this.events = this.events.filter(event => event.time < time); }
    setValueAtTime(value, time) { this.events.push({ kind: 'set', value, time }); }
    linearRampToValueAtTime(value, time) { this.events.push({ kind: 'linear', value, time }); }
    valueAt(time) {
      let previous = { time: 0, value: this.initial };
      for (const event of this.events) {
        if (event.time > time) {
          if (event.kind === 'linear' && event.time !== previous.time) return previous.value + (event.value - previous.value) * (time - previous.time) / (event.time - previous.time);
          break;
        }
        previous = event;
      }
      return previous.value;
    }
  }
  class Node {
    constructor(context) { this.context = context; this.connections = []; }
    connect(destination) { this.connections.push(destination); return destination; }
    disconnect() { this.connections = []; }
  }
  class Gain extends Node {
    constructor(context) { super(context); this.gain = new Parameter(context); }
  }
  class BufferSource extends Node {
    constructor(context) { super(context); this.playbackRate = { value: 1 }; this.loop = false; this.stopped = false; this.started = false; }
    start(...args) {
      assert.equal(this.started, false, 'a BufferSource can only start once');
      this.started = true;
      this.args = args;
      this.when = args[0];
      this.offset = args[1];
    }
    stop() { this.stopped = true; }
  }
  class AudioContext {
    constructor() {
      this.currentTime = 0;
      this.state = 'suspended';
      this.destination = {};
      this.sources = [];
      this.gains = [];
      this.resumeCalls = 0;
      this.listeners = {};
      contexts.push(this);
    }
    resume() { this.resumeCalls += 1; if (resume) return resume(this); this.state = 'running'; return Promise.resolve(); }
    createGain() { const gain = new Gain(this); this.gains.push(gain); return gain; }
    createBufferSource() { const item = new BufferSource(this); this.sources.push(item); return item; }
    decodeAudioData(data) { return Promise.resolve({ duration: data.duration, label: data.label }); }
    addEventListener(name, listener) { this.listeners[name] = listener; }
    advance(seconds) {
      this.currentTime += seconds;
      for (const item of this.sources) {
        if (!item.started || item.stopped || item.loop || this.currentTime < item.when + item.buffer.duration - item.offset) continue;
        item.stopped = true;
        item.onended?.();
      }
    }
    get active() { return this.sources.filter(item => item.started && !item.stopped); }
  }
  const sandbox = {
    module: { exports: {} }, AudioContext, location: { protocol }, setTimeout, clearTimeout,
    fetch: async url => {
      requests.push(url);
      if (deferred) await deferred(url);
      const data = files[url];
      return { ok: Boolean(data), arrayBuffer: async () => ({ ...data, label: url }) };
    }
  };
  vm.runInNewContext(source, sandbox);
  const engine = new sandbox.module.exports({
    loadTimeout,
    crossfade: 2000,
    volumes: { voice: 1, ambience: .35, music: .2, effects: .3 },
    duck: { ambience: .3, music: .2, effects: .4, attack: 400, release: 800 },
    beds: {
      rain: { src: 'assets/audio/rain.mp3', channel: 'ambience', loop: true },
      room: { src: 'assets/audio/room.mp3', channel: 'ambience', loop: true },
      jazz: { src: 'assets/audio/jazz.mp3', channel: 'music', loop: true },
      dishes: { src: null, channel: 'effects', loop: true }
    }
  });
  return { engine, contexts, requests, get context() { return contexts[0]; } };
}

const panorama = () => ({ id: 'panorama', duration: 35000, audio: {
  voice: { src: 'assets/audio/Pereulok_voice_natural_v2.mp3', start: 2000, tail: 1500 },
  beds: [{ id: 'room', gain: 1 }, { id: 'jazz', gain: .7 }, { id: 'dishes', gain: .3 }], effects: []
} });
const outside = () => ({ id: 'alley', duration: 16000, audio: { voice: null, beds: [{ id: 'rain', gain: 1 }, { id: 'jazz', gain: .12 }], effects: [{ src: null, at: 1000, gain: 1 }] } });
const available = {
  'assets/audio/Pereulok_voice_natural_v2.mp3': { duration: 40 },
  'assets/audio/rain.mp3': { duration: 60 },
  'assets/audio/room.mp3': { duration: 60 },
  'assets/audio/jazz.mp3': { duration: 60 }
};
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} should equal ${expected}`);

test('prepare unlocks audio synchronously, caches local files and never autoplays', async () => {
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  const h = audioHarness(available, { deferred: () => pending });
  const scene = panorama();
  const preparation = h.engine.prepare([scene, outside()]);
  assert.equal(h.contexts.length, 1);
  assert.equal(h.context.resumeCalls, 1, 'resume occurs in the original click, before any await');
  assert.equal(h.engine.getStatus().state, 'loading');
  assert.equal(h.context.active.length, 0);
  h.engine.stop();
  resolve();
  await preparation;
  assert.equal(h.context.active.length, 0, 'late decode after stop cannot autoplay');
  await h.engine.prepare([scene]);
  assert.equal(h.context.resumeCalls, 2);
  assert.equal(h.requests.length, 4, 'one fetch per distinct non-null source');
  assert.equal(h.engine.getStatus().voice, 'ready');
  assert.equal(h.engine.getStatus().contextState, 'running');
});

test('metadata determines full voice duration, two-second lead and 1.5-second tail', async () => {
  const h = audioHarness(available);
  const scene = panorama();
  assert.equal(h.engine.durationFor(scene), 35000);
  await h.engine.prepare([scene]);
  assert.equal(h.engine.durationFor(scene), 43500, 'a longer-than-31-second recording is not truncated');
  h.engine.play(scene, 0);
  const voice = h.context.sources.find(item => item.buffer.label.includes('Pereulok'));
  assert.equal(voice.when, 2);
  assert.equal(voice.offset, 0);
  assert.equal(voice.playbackRate.value, 1);
  assert.equal(voice.args.length, 2, 'no duration argument trims the original buffer');
  assert.equal(voice.connections[0], h.engine._channels.voice.volume, 'voice bypasses ducking and processing nodes');
  assert.equal(h.engine.getStatus().voiceActive, false);
  h.context.advance(2);
  h.engine.tick(2000);
  assert.equal(h.engine.getStatus().voiceActive, true);
  h.engine.tick(50000);
  assert.equal(voice.stopped, false, 'the visual clock does not cut voice');
  h.context.advance(40);
  assert.equal(voice.stopped, true, 'voice ends naturally');
  assert.equal(h.engine.getStatus().voiceActive, false);
});

test('missing optional files preserve fallback duration, null slots and file URLs are safe', async () => {
  const h = audioHarness({}, { protocol: 'file:' });
  const scene = panorama();
  await h.engine.prepare([scene]);
  assert.equal(h.engine.durationFor(scene), 35000);
  assert.equal(h.engine.getStatus().voice, 'missing');
  assert.ok(h.engine.getStatus().message.includes('HTTP'));
  assert.equal(h.requests.length, 3);
  assert.equal(h.requests.includes(null), false);
  assert.equal(h.engine.play(scene), true);
  assert.equal(h.context.active.length, 0);
  assert.equal(h.engine.getStatus().activeSources, 0);
});

test('pause stops every scheduled source; resume retains voice, loop and effect offsets', async () => {
  const h = audioHarness({ ...available, 'assets/audio/step.mp3': { duration: 2 } });
  const scene = panorama();
  scene.audio.effects = [{ src: 'assets/audio/step.mp3', at: 3000, gain: .5 }];
  await h.engine.prepare([scene]);
  h.engine.play(scene);
  h.context.advance(4);
  h.engine.tick(4000);
  const old = [...h.context.active];
  h.engine.pause();
  assert.equal(h.context.active.length, 0);
  assert.equal(h.engine.getStatus().playing, false);
  h.context.advance(50);
  h.engine.play(scene, 4000);
  assert.ok(old.every(item => item.stopped));
  const resumed = h.context.active;
  near(resumed.find(item => item.buffer.label.includes('Pereulok')).offset, 2);
  near(resumed.find(item => item.buffer.label.includes('room')).offset, 4);
  near(resumed.find(item => item.buffer.label.includes('step')).offset, 1);
  h.context.advance(2);
  h.engine.tick(6000);
  h.engine.pause();
  h.engine.play(scene, 6000);
  assert.equal(h.context.active.some(item => item.buffer.label.includes('step')), false, 'an already-finished effect is not replayed');
  h.engine.stop();
  assert.equal(h.context.active.length, 0);
  assert.equal(h.engine.getStatus().elapsed, 0);
});

test('pause during the lead preserves remaining silence instead of restarting it', async () => {
  const h = audioHarness(available);
  const scene = panorama();
  await h.engine.prepare([scene]);
  h.engine.play(scene);
  h.context.advance(.7);
  h.engine.tick(700);
  h.engine.pause();
  h.context.advance(20);
  h.engine.play(scene, 700);
  const voice = h.context.active.find(item => item.buffer.label.includes('Pereulok'));
  near(voice.when - h.context.currentTime, 1.3);
  assert.equal(voice.offset, 0);
});

test('bar scenes share one continuous bed and crossfade street over two seconds', async () => {
  const h = audioHarness(available);
  const street = outside();
  const bar = panorama();
  const hero = { id: 'hero', duration: 10000, audio: { voice: null, beds: bar.audio.beds, effects: [] } };
  await h.engine.prepare([street, bar, hero]);
  h.engine.play(street);
  const jazz = h.context.active.find(item => item.buffer.label.includes('jazz'));
  const rain = h.context.active.find(item => item.buffer.label.includes('rain'));
  h.context.advance(16);
  h.engine.tick(16000);
  h.engine.play(bar, 0, { crossfade: true });
  const room = h.context.active.find(item => item.buffer.label.includes('room'));
  assert.equal(h.context.active.filter(item => item.buffer.label.includes('jazz')).length, 1);
  assert.equal(h.context.active.find(item => item.buffer.label.includes('jazz')), jazz);
  near(rain.connections[0].gain.value, 1);
  near(room.connections[0].gain.value, 0);
  h.context.advance(1);
  h.engine.tick(1000);
  near(rain.connections[0].gain.value, .5);
  near(room.connections[0].gain.value, .5);
  h.context.advance(1);
  h.engine.tick(2000);
  assert.equal(rain.stopped, true);
  near(room.connections[0].gain.value, 1);
  h.context.advance(41.5);
  h.engine.tick(43500);
  h.engine.play(hero, 0, { crossfade: true });
  assert.equal(h.context.active.find(item => item.buffer.label.includes('room')), room);
  assert.equal(h.context.active.find(item => item.buffer.label.includes('jazz')), jazz);
  assert.equal(h.context.active.length, 2);
});

test('ducking has smooth attack/release and never changes the original voice gain', async () => {
  const h = audioHarness(available);
  const scene = panorama();
  await h.engine.prepare([scene]);
  h.engine.play(scene);
  const channels = h.engine._channels;
  near(channels.ambience.duck.gain.valueAt(1.6), 1);
  near(channels.ambience.duck.gain.valueAt(1.8), .65);
  near(channels.ambience.duck.gain.valueAt(2), .3);
  near(channels.music.duck.gain.valueAt(12), .2);
  near(channels.effects.duck.gain.valueAt(12), .4);
  near(channels.voice.volume.gain.valueAt(12), 1);
  near(channels.ambience.duck.gain.valueAt(42), .3);
  near(channels.ambience.duck.gain.valueAt(42.4), .65);
  near(channels.ambience.duck.gain.valueAt(42.8), 1);
  h.context.advance(12);
  h.engine.tick(12000);
  h.engine.pause();
  h.context.advance(20);
  h.engine.play(scene, 12000);
  near(channels.music.duck.gain.value, .2);
  near(channels.voice.volume.gain.value, 1);
});

test('rapid navigation and duplicate play cannot leave overlapping sources or stale voice callbacks', async () => {
  const h = audioHarness(available);
  const bar = panorama();
  const street = outside();
  await h.engine.prepare([bar, street]);
  h.engine.play(bar);
  const count = h.context.active.length;
  h.engine.play(bar);
  assert.equal(h.context.active.length, count);
  const voice = h.context.active.find(item => item.buffer.label.includes('Pereulok'));
  const staleEnded = voice.onended;
  h.engine.play(street, 0);
  assert.equal(voice.stopped, true);
  h.engine.play(bar, 8000);
  const currentVoice = h.context.active.find(item => item.buffer.label.includes('Pereulok'));
  assert.notEqual(currentVoice, voice);
  assert.equal(currentVoice.offset, 6);
  staleEnded();
  assert.equal(h.engine._voice.source, currentVoice);
  assert.equal(h.context.active.filter(item => item.buffer.label.includes('Pereulok')).length, 1);
  h.engine.stop();
  assert.equal(h.context.active.length, 0);
});

test('four independent volume controls work before and during preparation and clamp invalid values', async () => {
  const h = audioHarness(available);
  h.engine.setVolume('voice', .8);
  h.engine.setVolume('music', .4);
  await h.engine.prepare([panorama()]);
  near(h.engine._channels.voice.volume.gain.value, .8);
  near(h.engine._channels.music.volume.gain.value, .4);
  h.engine.setVolume('ambience', .25);
  h.engine.setVolume('effects', 2);
  h.engine.setVolume('music', -4);
  near(h.engine._channels.ambience.volume.gain.value, .25);
  near(h.engine._channels.effects.volume.gain.value, 1);
  near(h.engine._channels.music.volume.gain.value, 0);
  near(h.engine._channels.voice.volume.gain.value, .8);
});

test('master volume is ready before audio creation and one muted output receives every channel', async () => {
  const h = audioHarness({ ...available, 'assets/audio/step.mp3': { duration: 2 } });
  assert.deepEqual({ ...h.engine.getMasterState() }, { volume: 1, muted: false, effectiveVolume: 1 });
  const stateCopy = h.engine.getMasterState(); stateCopy.volume = 0;
  assert.equal(h.engine.getMasterState().volume, 1);
  h.engine.setMasterVolume(.65);
  h.engine.setMuted(true);
  assert.equal(h.contexts.length, 0, 'choosing volume and mute never creates an audio context');
  const scene = panorama();
  scene.audio.effects = [{ src: 'assets/audio/step.mp3', at: 0, gain: .5 }];
  await h.engine.prepare([scene]);
  near(h.engine._master.gain.value, 0);
  assert.equal(h.context.active.length, 0, 'prepare never autoplays, even muted');
  assert.deepEqual(h.engine._master.connections, [h.context.destination]);
  for (const channel of ['voice', 'ambience', 'music', 'effects']) {
    assert.deepEqual(h.engine._channels[channel].volume.connections, [h.engine._master]);
  }
  assert.equal(h.context.gains.filter(gain => gain.connections.includes(h.context.destination)).length, 1,
    'no channel bypasses the master output');
  h.engine.play(scene);
  assert.equal(h.context.active.length, 4, 'voice, room, jazz and the effect keep their normal schedules');
  function reaches(node, destination) {
    return node === destination || (node.connections || []).some(next => reaches(next, destination));
  }
  assert.ok(h.context.active.every(source => reaches(source, h.engine._master)));
  near(h.engine._channels.voice.volume.gain.value, 1);
  h.engine.setMuted(false);
  near(h.engine._master.gain.value, .65);
});

test('mute and volume changes never stop, duplicate, seek or reschedule a playing source', async () => {
  const h = audioHarness({ ...available, 'assets/audio/step.mp3': { duration: 8 } });
  const scene = panorama();
  scene.audio.effects = [{ src: 'assets/audio/step.mp3', at: 3000, gain: .5 }];
  await h.engine.prepare([scene]);
  h.engine.play(scene);
  h.context.advance(4);
  h.engine.tick(4000);
  const originals = [...h.context.active];
  const scheduled = originals.map(source => [...source.args]);
  const originalGains = Object.fromEntries(Object.entries(h.engine._channels).map(([id, channel]) =>
    [id, { volume: channel.volume.gain.value, automation: [...channel.duck.gain.events] }]));
  const updates = []; h.engine.onStatus = update => updates.push(update);
  h.engine.setMasterVolume(.4);
  for (const muted of [true, false, true, false]) {
    h.engine.setMuted(muted);
    near(h.engine._master.gain.value, muted ? 0 : .4);
    assert.deepEqual(h.context.active, originals);
    assert.deepEqual(h.context.active.map(source => source.args), scheduled);
    assert.equal(h.engine.getStatus().elapsed, 4000);
    assert.equal(h.engine.getStatus().playing, true);
  }
  assert.equal(updates.length, 0, 'changing volume cannot trigger transport status callbacks');
  assert.equal(h.context.sources.length, originals.length);
  for (const [id, channel] of Object.entries(h.engine._channels)) {
    near(channel.volume.gain.value, originalGains[id].volume);
    assert.deepEqual(channel.duck.gain.events, originalGains[id].automation);
  }
  h.engine.setMuted(true);
  h.context.advance(1);
  h.engine.tick(5000);
  assert.equal(h.engine.getStatus().elapsed, 5000, 'the audio clock still advances while muted');
  assert.equal(h.engine.getStatus().playing, true);
  assert.deepEqual(h.context.active, originals);
});

test('mute restores the chosen nonzero volume, including after slider zero and clamped input', async () => {
  const h = audioHarness();
  h.engine.setMasterVolume(.73);
  assert.deepEqual({ ...h.engine.toggleMuted() }, { volume: .73, muted: true, effectiveVolume: 0 });
  assert.deepEqual({ ...h.engine.toggleMuted() }, { volume: .73, muted: false, effectiveVolume: .73 });
  assert.deepEqual({ ...h.engine.setMasterVolume(0) }, { volume: 0, muted: true, effectiveVolume: 0 });
  assert.deepEqual({ ...h.engine.toggleMuted() }, { volume: .73, muted: false, effectiveVolume: .73 });
  h.engine.setMasterVolume(-2);
  h.engine.setMuted(false);
  near(h.engine.getMasterState().volume, .73);
  h.engine.setMuted(true);
  h.engine.setMasterVolume('0.35');
  assert.deepEqual({ ...h.engine.getMasterState() }, { volume: .35, muted: false, effectiveVolume: .35 });
  h.engine.setMasterVolume(2);
  near(h.engine.getMasterState().volume, 1);
  h.engine.setMasterVolume(NaN);
  assert.deepEqual({ ...h.engine.getMasterState() }, { volume: 0, muted: true, effectiveVolume: 0 });
  h.engine.toggleMuted();
  near(h.engine.getMasterState().volume, 1);
  assert.equal(h.contexts.length, 0, 'all controls work before files and Web Audio exist');
});

test('master state survives navigation, crossfades, pause and stop without changing individual levels', async () => {
  const h = audioHarness(available);
  const street = outside(), bar = panorama();
  const hero = { id: 'hero', duration: 10000, audio: { voice: null, beds: bar.audio.beds, effects: [] } };
  h.engine.setMasterVolume(.42);
  h.engine.setVolume('voice', .8);
  h.engine.setVolume('music', .45);
  await h.engine.prepare([street, bar, hero]);
  near(h.engine._master.gain.value, .42);
  h.engine.play(street);
  h.context.advance(16); h.engine.tick(16000);
  h.engine.setMuted(true);
  h.engine.play(bar, 0, { crossfade: true });
  near(h.engine._master.gain.value, 0);
  h.context.advance(1); h.engine.tick(1000);
  const room = h.context.active.find(source => source.buffer.label.includes('room'));
  near(room.connections[0].gain.value, .5, 'crossfade still progresses while muted');
  h.engine.setVolume('ambience', .27);
  h.engine.pause();
  assert.equal(h.context.active.length, 0);
  assert.equal(h.engine.getMasterState().muted, true);
  h.engine.setMuted(false);
  assert.equal(h.context.active.length, 0, 'unmuting a paused scene cannot resume its sources');
  h.engine.play(bar, 1000);
  near(h.engine._master.gain.value, .42);
  near(h.engine._channels.voice.volume.gain.value, .8);
  near(h.engine._channels.music.volume.gain.value, .45);
  near(h.engine._channels.ambience.volume.gain.value, .27);
  h.engine.play(hero, 0, { crossfade: true });
  near(h.engine._master.gain.value, .42);
  h.engine.stop();
  assert.deepEqual({ ...h.engine.getMasterState() }, { volume: .42, muted: false, effectiveVolume: .42 });
  h.engine.setMuted(true);
  h.context.state = 'closed';
  await h.engine.prepare([bar]);
  assert.equal(h.contexts.length, 2);
  near(h.engine._master.gain.value, 0, 'recreated contexts receive the retained mute before playback');
  h.engine.setMuted(false);
  near(h.engine._master.gain.value, .42);
});

test('remote sources are never requested and an unavailable AudioContext leaves silent playback usable', async () => {
  const h = audioHarness(available);
  const scene = panorama();
  scene.audio.voice.src = 'https://example.com/voice.mp3';
  scene.audio.beds = [];
  await h.engine.prepare([scene]);
  assert.equal(h.requests.length, 0);
  assert.equal(h.engine.getStatus().voice, 'missing');
  assert.equal(h.engine.durationFor(scene), 35000);
  const sandbox = { module: { exports: {} } };
  vm.runInNewContext(source, sandbox);
  const silent = new sandbox.module.exports();
  await silent.prepare([scene]);
  assert.equal(silent.getStatus().state, 'unavailable');
  assert.equal(silent.play(scene), false);
  silent.pause();
  silent.stop();
});

test('context interruptions notify the player with truthful audio state', async () => {
  const h = audioHarness(available);
  const updates = [];
  h.engine.onStatus = state => updates.push(state);
  await h.engine.prepare([panorama()]);
  h.context.state = 'interrupted';
  h.context.listeners.statechange();
  assert.equal(updates.at(-1).contextState, 'interrupted');
  assert.equal(updates.at(-1).voiceActive, false);
});

test('a stalled file or browser resume cannot leave preparation pending or apply stale metadata', async () => {
  let finish;
  const wait = new Promise(resolve => { finish = resolve; });
  const h = audioHarness(available, { loadTimeout: 5, deferred: () => wait, resume: () => wait });
  const scene = panorama();
  await h.engine.prepare([scene]);
  assert.equal(h.engine.getStatus().state, 'ready');
  assert.equal(h.engine.getStatus().voice, 'missing');
  assert.equal(h.engine.durationFor(scene), 35000);
  assert.equal(h.engine.play(scene), false, 'a suspended context never pretends to play');
  finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.engine.getStatus().voice, 'missing', 'late decoded data cannot change a running fallback timeline');
  assert.equal(h.engine.durationFor(scene), 35000);
  assert.equal(h.context.active.length, 0);
});
