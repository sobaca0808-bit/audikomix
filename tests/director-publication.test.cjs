const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const model = require('../director-project.js');
const publication = require('../director-publication.js');
const baseline = require('../scenes.js');

test('exported project round trips channel gains and leaves the source mix intact', () => {
  const project = model.fromStory(baseline);
  const original = structuredClone(baseline.audio);
  project.volumes.music = .37;
  const copy = JSON.parse(JSON.stringify(project));
  assert.equal(model.compile(copy, baseline).audio.volumes.music, .37);
  assert.deepEqual(baseline.audio, original);
  assert.throws(() => model.validate({ ...copy, volumes: { music: 1.1 } }, baseline));
  delete copy.volumes;
  assert.deepEqual(model.compile(copy, baseline).audio.volumes, original.volumes);
});

test('publication requires repository audio paths for uploaded media', () => {
  const project = model.fromStory(baseline);
  project.media.push({ id: 'voice-one', name: 'voice.ogg', type: 'audio/ogg', size: 1000, durationMs: 1000 });
  project.scenes[0].tracks.push({ id: 'track-one', assetId: 'voice-one', kind: 'voice', startMs: 0, volume: 1, loop: false });
  assert.throws(() => publication.compile(project, baseline, model), /отсутствует путь/);
  for (const src of ['https://host.test/voice.ogg', '//host.test/a.ogg', 'assets/audio/../voice.ogg', 'assets/audio/%2e%2e/voice.ogg', 'data:audio/ogg,abc']) {
    assert.throws(() => publication.compile({ project, files: { 'voice-one': src } }, baseline, model), /относительные пути/);
  }
  const published = publication.compile({ project, files: { 'voice-one': 'assets/audio/voice-one.ogg' } }, baseline, model);
  assert.equal(published.scenes[0].audio.tracks[0].src, 'assets/audio/voice-one.ogg');
  assert.equal(published.scenes.at(-1).audio.tracks[0].id, 'jazz-finale');
});

test('missing, malformed and unreachable publication fall back and same-origin project loads', async () => {
  for (const fetch of [async () => ({ ok: false }), async () => ({ ok: true, text: async () => '{"broken":' }), async () => { throw Error('offline'); }]) {
    assert.equal(await publication.load({ fetch, baseline, model }), null);
  }
  const project = model.fromStory(baseline);
  project.volumes.effects = .7;
  const result = await publication.load({ baseline, model, fetch: async (url, options) => {
    assert.equal(url, './director-settings.json');
    assert.equal(options.redirect, 'error');
    assert.equal(options.mode, 'same-origin');
    return { ok: true, text: async () => JSON.stringify(project) };
  } });
  assert.equal(result.audio.volumes.effects, .7);
});

test('all published media resolve beneath the project Pages directory', () => {
  const selection = model.fromStory(baseline);
  const story = publication.compile(selection, baseline, model);
  const paths = new Set();
  for (const scene of story.scenes) {
    paths.add(scene.image);
    for (const bed of scene.audio.beds) paths.add(story.audio.beds[bed.id].src);
    for (const track of [...scene.audio.effects, ...(scene.audio.tracks || [])]) paths.add(track.src);
  }
  assert.equal(paths.size, 20);
  for (const src of paths) {
    const url = new URL(src, 'https://sample.github.io/audikomix/');
    assert.ok(url.pathname.startsWith('/audikomix/assets/'));
    assert.ok(fs.statSync(path.join(__dirname, '..', src)).size > 0, src);
  }
});
