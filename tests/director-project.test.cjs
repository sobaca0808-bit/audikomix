const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const model = require('../director-project.js');
const baseline = JSON.parse(JSON.stringify(require('../scenes.js')));
const copy = value => JSON.parse(JSON.stringify(value));
const fresh = () => model.fromStory(baseline);
const media = (id = 'voice-one', durationMs = 40000) => ({ id, name: 'Запись.wav', type: 'audio/wav', size: 80, durationMs });
const track = (assetId = 'voice-one', kind = 'voice') => ({ id: 'layer-one', kind, assetId, startMs: 2000, volume: .6, loop: false });
function frozen(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value); }
  return value;
}

test('browser/CommonJS API builds an isolated project from all five approved scenes', () => {
  const sandbox = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../director-project.js'), 'utf8'), sandbox);
  assert.equal(typeof sandbox.window.AlleyDirectorProject.compile, 'function');
  const source = frozen(copy(baseline));
  const project = model.fromStory(source);
  assert.deepEqual(project.scenes.map(scene => scene.id), ['alley', 'panorama', 'hero', 'dasha', 'revelation']);
  assert.deepEqual(project.scenes.map(scene => scene.durationMs), [16000, 35000, 10000, 12000, 8000]);
  assert.deepEqual(project.scenes[1].phrases.map(p => [p.startMs, p.typingMs, p.endMs]), [[2000,3500,8500],[9000,2500,15500],[16000,2500,23500],[24000,3000,35000]]);
  assert.equal(project.scenes[4].phrases.length, 0);
  assert.equal(project.media.length, 0);
  project.scenes[0].phrases[0].text = 'Черновик';
  assert.notEqual(source.scenes[0].phrases[0].text, 'Черновик');
});

test('default compile preserves approved text, timing, images, audio and focus without mutating sources', () => {
  const source = frozen(copy(baseline)), project = frozen(model.fromStory(source));
  const story = model.compile(project, source);
  assert.deepEqual(story.audio, source.audio);
  for (let index = 0; index < 5; index++) {
    const scene = story.scenes[index], original = source.scenes[index];
    for (const key of ['id', 'image', 'alt', 'speaker', 'duration', 'text', 'phrases', 'textDelay', 'textDuration', 'holdLastPhrase', 'audio', 'focus']) {
      assert.deepEqual(scene[key], original[key], `${original.id}: ${key}`);
    }
    assert.equal(scene.transitionMs, 200);
    assert.deepEqual(scene.directorEffects, { smoke: 0, flicker: 0 });
    assert.equal(scene.zoom.start, original.zoom.start);
    assert.ok(Math.abs(scene.zoom.delta - original.zoom.delta) < 1e-12);
  }
});

test('reordering and authored scene edits compile from fixed images and return independent objects', () => {
  const project = fresh();
  project.scenes.reverse();
  const hero = project.scenes.find(scene => scene.id === 'hero');
  hero.durationMs = 18000;
  hero.transitionMs = 800;
  hero.phrases[0] = { text: '<b>Это текст, не HTML.</b>', speaker: 'ДЕТЕКТИВ', startMs: 3000, typingMs: 2000, endMs: 12000 };
  hero.camera = { start: 1.04, end: 1, focusX: 42, focusY: 38 };
  hero.effects = { smoke: .5, flicker: .2 };
  const normalized = model.validate(project, baseline);
  normalized.scenes[0].durationMs = 9000;
  assert.equal(project.scenes[0].durationMs, 8000);
  const story = model.compile(project, baseline), compiled = story.scenes.find(scene => scene.id === 'hero');
  assert.deepEqual(story.scenes.map(scene => scene.id), ['revelation', 'dasha', 'hero', 'panorama', 'alley']);
  assert.equal(compiled.image, baseline.scenes[2].image);
  assert.equal(compiled.duration, 18000);
  assert.equal(compiled.transitionMs, 800);
  assert.equal(compiled.focus, '42% 38%');
  assert.deepEqual(compiled.phrases, [{ text: '<b>Это текст, не HTML.</b>', start: 3000, typing: 2000, end: 12000 }]);
  assert.equal(compiled.speaker, 'ДЕТЕКТИВ');
  assert.equal(compiled.text, undefined);
  assert.equal(compiled.textDelay, undefined);
  assert.deepEqual(compiled.directorEffects, hero.effects);
  compiled.audio.beds.length = 0;
  assert.notEqual(baseline.scenes[2].audio.beds.length, 0);
});

test('empty captions clear stale speaker/text timing and multiple speakers remain attached to their phrases', () => {
  const project = fresh(), hero = project.scenes[2];
  hero.phrases = [];
  let scene = model.compile(project, baseline).scenes[2];
  assert.equal(scene.speaker, '');
  assert.equal(scene.text, '');
  assert.equal(scene.phrases, undefined);
  assert.equal(scene.textDelay, undefined);
  hero.phrases = [
    { text: 'Первая', speaker: 'А', startMs: 0, typingMs: 500, endMs: 2000 },
    { text: 'Вторая', speaker: 'Б', startMs: 3000, typingMs: 500, endMs: 9000 }
  ];
  scene = model.compile(project, baseline).scenes[2];
  assert.equal(scene.speaker, 'А');
  assert.equal(scene.phrases[0].speaker, undefined);
  assert.equal(scene.phrases[1].speaker, 'Б');
});

test('uploaded voice replaces pending baseline voice and extends the scene for the whole recording', () => {
  const project = fresh();
  project.media.push(media());
  project.scenes[1].tracks.push(track());
  const original = copy(project), scene = model.compile(project, baseline).scenes[1];
  assert.equal(scene.audio.voice, null);
  assert.deepEqual(scene.audio.tracks, [{ id:'layer-one', src:'director-media:voice-one', kind:'voice', start:2000, gain:.6, loop:false }]);
  assert.equal(scene.duration, 43500);
  assert.equal(scene.phrases.at(-1).end, 43500, 'final caption stays with the extended complete voice');
  assert.deepEqual(project, original);
  assert.equal(baseline.scenes[1].audio.voice.src, 'assets/audio/Pereulok_voice_natural_v2.mp3');
  const dasha = project.scenes[3]; dasha.tracks.push({ ...track(), startMs: 0 });
  assert.equal(model.compile(project, baseline).scenes[3].phrases.at(-1).end, 41500);
  project.scenes[1].phrases.at(-1).endMs = 34000;
  const earlier = model.compile(project, baseline).scenes[1];
  assert.equal(earlier.phrases.at(-1).end, 34000, 'explicit earlier hide time remains exact');
  assert.equal(earlier.holdLastPhrase, false, 'earlier caption must not reappear at the final timestamp');
});

test('music/effects do not replace the voice or extend the scene; multiple voice ends choose the longest', () => {
  const project = fresh(); project.media.push(media(), media('other-voice', 50000));
  const panorama = project.scenes[1];
  panorama.tracks.push({ ...track('voice-one', 'music'), loop: true });
  let compiled = model.compile(project, baseline).scenes[1];
  assert.equal(compiled.duration, 35000);
  assert.deepEqual(compiled.audio.voice, baseline.scenes[1].audio.voice);
  panorama.tracks.push({ ...track('other-voice'), id: 'voice-two', startMs: 4000 });
  compiled = model.compile(project, baseline).scenes[1];
  assert.equal(compiled.duration, 55500);
});

test('imports cannot change scene membership, image sources, version or schema', () => {
  for (const change of [
    p => { p.version = 2; }, p => { p.format = 'other'; }, p => p.scenes.pop(),
    p => { p.scenes[1].id = p.scenes[0].id; }, p => { p.scenes[0].id = 'unknown'; },
    p => { p.scenes[0].image = 'https://example.com/photo.png'; },
    p => { p.scenes[0].audio = {src:'data:audio/wav,x'}; },
    p => { p.scenes[0].camera.url = 'blob:anything'; }
  ]) {
    const project = fresh(); change(project);
    assert.throws(() => model.validate(project, baseline));
  }
  assert.throws(() => model.validate(JSON.parse(JSON.stringify(fresh()).replace('"version":1', '"version":1,"__proto__":{"polluted":true}')), baseline), /недопустимый ключ/);
  assert.equal({}.polluted, undefined);
  const circular = fresh(); circular.scenes[0].effects.loop = circular;
  assert.throws(() => model.validate(circular, baseline), /глубокую структуру/);
});

test('phrase order, timing, size and numeric limits are validated rather than silently clipped', () => {
  for (const change of [
    p => { p.scenes[0].phrases[1].startMs = 4000; },
    p => { p.scenes[0].phrases[0].typingMs = 16000; },
    p => { p.scenes[0].phrases[0].endMs = 17000; },
    p => { p.scenes[0].phrases[0].text = 'a'.repeat(4001); },
    p => { p.scenes[0].phrases = Array(25).fill(p.scenes[0].phrases[0]); },
    p => { p.scenes[0].durationMs = NaN; }, p => { p.scenes[0].transitionMs = 2001; },
    p => { p.scenes[0].camera.start = .99; }, p => { p.scenes[0].camera.end = 1.05; },
    p => { p.scenes[0].camera.focusX = -1; }, p => { p.scenes[0].effects.smoke = 1.1; }
  ]) {
    const project = fresh(); change(project);
    assert.throws(() => model.validate(project, baseline));
  }
});

test('audio references, file metadata, limits and non-looping full voices are enforced', () => {
  for (const change of [
    p => { p.scenes[0].tracks[0].assetId = 'missing'; },
    p => { p.scenes[0].tracks[0].loop = true; },
    p => { p.scenes[0].tracks[0].src = 'https://example.com/music.mp3'; },
    p => { p.scenes[0].tracks[0].volume = 1.1; },
    p => { p.scenes[0].tracks[0].startMs = 16001; },
    p => { p.scenes[0].tracks.push(copy(p.scenes[0].tracks[0])); },
    p => { p.media[0].name = '../voice.wav'; },
    p => { p.media[0].type = 'text/html'; },
    p => { p.media[0].size = model.LIMITS.mediaBytes + 1; },
    p => { p.media[0].durationMs = 600000; },
    p => { p.media.push(copy(p.media[0])); }
  ]) {
    const project = fresh(); project.media.push(media()); project.scenes[0].tracks.push(track()); change(project);
    assert.throws(() => model.validate(project, baseline));
  }
});

test('large UTF-8 projects fail before a JSON payload can exceed the 1 MiB contract', () => {
  const project = fresh();
  for (const scene of project.scenes) {
    scene.durationMs = 600000;
    scene.phrases = Array.from({length:24}, (_, i) => ({ text:'ࠀ'.repeat(4000), speaker:'', startMs:i*20000, typingMs:1000, endMs:(i+1)*20000 }));
  }
  assert.throws(() => model.validate(project, baseline), /1 МБ/);
});
