const test = require('node:test');
const assert = require('node:assert/strict');
const director = require('../director-editor.js');
const model = require('../director-project.js');
const source = require('../scenes.js');
const copy = value => JSON.parse(JSON.stringify(value));
const initial = () => model.fromStory(source);
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function wav(name = 'voice.wav', data = 'wave') { const blob = new Blob([data], { type: 'audio/wav' }); Object.defineProperty(blob, 'name', { value: name }); return blob; }

function harness(options = {}) {
  const events = [], timers = new Map(), media = new Map();
  let timerId = 0, uid = 0;
  const state = { saved: options.stored ? copy(options.stored) : null, loadGate: options.loadGate,
    saveGate: null, saveError: null, putGate: null, getMediaGate: null, metadataGate: null, metadataCalls: 0,
    metadataDuration: 1000, loadError: options.loadError, storageWrites: 0 };
  const playerState = { sceneId: 'alley', index: 0, mode: 'cinema', elapsed: 0, playing: false, starting: false, interactionVersion: 0 };
  let currentStory = copy(source), resolver;
  const player = {
    getState: () => ({ ...playerState }),
    pause() { playerState.playing = false; playerState.starting = false; playerState.interactionVersion++; events.push({ type: 'pause' }); },
    applyStory(story, settings) {
      currentStory = copy(story);
      Object.assign(playerState, { sceneId: settings.sceneId, index: story.scenes.findIndex(item => item.id === settings.sceneId), mode: settings.mode, elapsed: settings.elapsed || 0, playing: false, starting: false });
      events.push({ type: 'apply', settings: { ...settings }, story: copy(story) });
    },
    preview(story, settings) { this.applyStory(story, { ...settings, mode: 'cinema' }); playerState.playing = true; events.push({ type: 'preview' }); },
    setMediaResolver(fn) { resolver = fn; events.push({ type: 'resolver' }); }
  };
  const storage = {
    async load() { events.push({ type: 'load' }); if (state.loadGate) await state.loadGate.promise; if (state.loadError) throw state.loadError; return state.saved ? copy(state.saved) : null; },
    async save(project) { events.push({ type: 'save', project: copy(project) }); if (state.saveGate) await state.saveGate.promise; if (state.saveError) throw state.saveError; state.saved = copy(project); state.storageWrites++; return copy(project); },
    async putMedia(record) { events.push({ type: 'put', id: record.id }); if (state.putGate) await state.putGate.promise; if (media.has(record.id)) throw new Error('Нельзя заменить существующий файл'); media.set(record.id, record); return copy(record.metadata); },
    async getMedia(id) { if (state.getMediaGate) return state.getMediaGate.promise; return media.get(id)?.blob || null; }
  };
  const downloads = [];
  const window = { Blob, location: { search: options.search || '' }, setTimeout: (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId; }, clearTimeout: id => timers.delete(id) };
  const create = () => director.create({ mount: false, window, baseline: source, model, storage, player,
    uid: prefix => prefix + '-' + (++uid),
    readAudioMetadata: async () => { state.metadataCalls++; if (state.metadataGate) await state.metadataGate.promise; return { durationMs: state.metadataDuration }; },
    download: async (blob, name) => { downloads.push({ blob, name }); }
  });
  return { events, state, media, player, playerState, downloads, storage, create,
    get currentStory() { return currentStory; },
    async resolve(id) { return resolver(id); },
    async flush() { const pending = [...timers.values()]; timers.clear(); for (const timer of pending) await timer.fn(); },
    get pending() { return timers.size; }
  };
}

test('default editor is available for development and copies the source without persistence', async () => {
  const before = copy(source), h = harness(), editor = await h.create();
  assert.equal(editor.getState().enabled, true);
  assert.equal(editor.getState().open, false);
  assert.equal(editor.getState().dirty, false);
  assert.deepEqual(h.events.map(item => item.type), ['resolver', 'load']);
  const draft = editor.getDraft(); draft.scenes[0].phrases[0].text = 'outside mutation';
  assert.notEqual(editor.getDraft().scenes[0].phrases[0].text, 'outside mutation');
  const saved = editor.getSaved(); saved.scenes.reverse();
  assert.equal(editor.getSaved().scenes[0].id, 'alley');
  assert.deepEqual(source, before);
  assert.equal(h.state.storageWrites, 0);
});

test('saved project restores before interaction and the media provider is attached before storage awaits', async () => {
  const stored = initial(); stored.scenes[0].durationMs = 18000;
  const gate = deferred(), h = harness({ stored, loadGate: gate });
  const creation = h.create();
  assert.deepEqual(h.events.map(item => item.type), ['resolver', 'load']);
  const file = wav(); h.media.set('m', { blob: file }); assert.equal(await h.resolve('m'), file);
  gate.resolve(); const editor = await creation;
  assert.equal(h.currentStory.scenes[0].duration, 18000);
  assert.equal(h.playerState.playing, false);
  assert.equal(editor.getSaved().scenes[0].durationMs, 18000);
});

test('late bootstrap never replaces active, pending, cancelled or navigated user playback', async () => {
  for (const interaction of ['playing', 'pending', 'cancelled', 'navigated']) {
    const stored = initial(); stored.scenes[0].durationMs = 18000;
    const gate = deferred(), h = harness({ stored, loadGate: gate }), creation = h.create();
    h.playerState.interactionVersion++;
    if (interaction === 'playing') Object.assign(h.playerState, { playing: true, elapsed: 1000 });
    if (interaction === 'pending') h.playerState.starting = true;
    if (interaction === 'cancelled') h.playerState.interactionVersion++;
    if (interaction === 'navigated') Object.assign(h.playerState, { sceneId: 'hero', index: 2 });
    gate.resolve(); const editor = await creation;
    assert.equal(h.events.filter(item => item.type === 'apply').length, 0, interaction);
    assert.equal(h.events.filter(item => item.type === 'resolver').length, 1, interaction);
    assert.equal(editor.getSaved().scenes[0].durationMs, 18000);
    assert.match(editor.getState().message, /не прерван/);
  }
});

test('opening pauses, valid draft changes preview in Comic, and Close retains draft without saving', async () => {
  const h = harness(), editor = await h.create(); await editor.open();
  assert.equal(editor.getState().open, true); assert.equal(h.playerState.mode, 'comic');
  editor.setPhrase(0, { text: '<b>Авторская реплика</b>' });
  assert.equal(editor.getState().dirty, true); assert.equal(h.pending, 1);
  await h.flush();
  assert.equal(h.currentStory.scenes[0].phrases[0].text, '<b>Авторская реплика</b>');
  assert.equal(h.playerState.playing, false); assert.equal(h.state.storageWrites, 0);
  editor.updateScene('alley', { durationMs: 19000 });
  editor.close(); assert.equal(h.pending, 0);
  assert.equal(editor.getState().open, false);
  assert.equal(editor.getDraft().scenes[0].durationMs, 19000);
  assert.equal(editor.getSaved().scenes[0].durationMs, 16000);
});

test('scene reordering and phrase changes are draft-only until Save; Cancel restores last saved project', async () => {
  const h = harness(), editor = await h.create(); await editor.open();
  editor.selectScene('hero'); editor.reorder(-1); editor.setPhrase(0, { text: 'Новая фраза героя' }); await h.flush();
  assert.equal(editor.getDraft().scenes[1].id, 'hero');
  await editor.save(); assert.equal(h.state.storageWrites, 1);
  const saved = editor.getSaved();
  editor.reorder(-1); editor.setPhrase(0, { text: 'Не сохранять' });
  await editor.cancel();
  assert.deepEqual(editor.getDraft(), saved); assert.deepEqual(h.state.saved, saved);
  assert.equal(h.state.storageWrites, 1); assert.equal(editor.getState().open, false);
  assert.equal(h.currentStory.scenes[1].id, 'hero'); assert.equal(h.playerState.playing, false);
});

test('Save awaits durable completion, rejects concurrent edits and keeps old saved state on failure', async () => {
  const h = harness(), editor = await h.create(); editor.updateScene('alley', { durationMs: 18000 });
  h.state.saveGate = deferred(); h.state.saveError = new Error('quota exhausted');
  const saving = editor.save();
  assert.equal(editor.getState().saving, true);
  assert.equal(editor.getSaved().scenes[0].durationMs, 16000);
  assert.throws(() => editor.updateScene('alley', { durationMs: 19000 }), /сохранения/);
  await assert.rejects(editor.cancel(), /сохранения/);
  h.state.saveGate.resolve(); await assert.rejects(saving, /quota/);
  assert.equal(editor.getState().saving, false); assert.equal(editor.getState().dirty, true);
  assert.equal(editor.getSaved().scenes[0].durationMs, 16000);
  assert.equal(h.state.storageWrites, 0); assert.match(editor.getState().message, /Не удалось сохранить/);
});

test('invalid drafts cannot Preview, Save or export and do not alter source or persistence', async () => {
  const h = harness(), editor = await h.create(), before = copy(source);
  editor.updateScene('alley', { durationMs: 1000 });
  await assert.rejects(editor.preview(), /Реплика|реплики|Конец|печати/);
  await assert.rejects(editor.save(), /Реплика|реплики|Конец|печати/);
  assert.throws(() => editor.exportProject(), /Реплика|реплики|Конец|печати/);
  assert.equal(h.events.some(item => item.type === 'preview'), false);
  assert.equal(h.state.storageWrites, 0); assert.deepEqual(source, before);
});

test('Preview plays only the selected draft scene and closes the editor without persistence', async () => {
  const h = harness(), editor = await h.create(); await editor.open(); editor.selectScene('dasha');
  editor.setPhrase(0, { text: 'Черновая газетная реплика' });
  await editor.preview();
  assert.equal(h.playerState.sceneId, 'dasha'); assert.equal(h.playerState.playing, true);
  assert.equal(h.playerState.mode, 'cinema'); assert.equal(editor.getState().open, false);
  assert.equal(editor.getState().dirty, true); assert.equal(h.pending, 0);
  assert.equal(h.state.storageWrites, 0);
});

test('invalid JSON import is atomic and does not cancel a valid queued live preview', async () => {
  const h = harness(), editor = await h.create(); await editor.open(); editor.setPhrase(0, { text: 'Сохранить черновик' });
  const before = editor.getDraft();
  await assert.rejects(editor.importProject('{bad'), /JSON/);
  const invalid = initial(); invalid.version = 99;
  await assert.rejects(editor.importProject(invalid), /версия/);
  assert.deepEqual(editor.getDraft(), before); assert.equal(h.pending, 1);
  await h.flush(); assert.equal(h.currentStory.scenes[0].phrases[0].text, 'Сохранить черновик');
  assert.equal(h.state.storageWrites, 0);
});

test('valid JSON imports into draft, exports independent metadata and Cancel restores source', async () => {
  const h = harness(), editor = await h.create(); await editor.open();
  const imported = initial(); imported.scenes.reverse(); imported.scenes[4].phrases[0].text = 'Импорт';
  await editor.importProject(JSON.stringify(imported));
  assert.equal(h.currentStory.scenes[0].id, 'revelation');
  assert.deepEqual(JSON.parse(editor.exportProject()), imported);
  assert.equal(editor.getSaved().scenes[0].id, 'alley'); assert.equal(h.state.storageWrites, 0);
  await editor.cancel(); assert.equal(h.currentStory.scenes[0].id, 'alley');
});

test('Cancel, Close and Save invalidate delayed JSON-file reads rather than applying stale imports', async () => {
  for (const action of ['cancel', 'close', 'save']) {
    const h = harness(), editor = await h.create(); await editor.open();
    const gate = deferred(), imported = initial(); imported.scenes.reverse();
    const reading = editor.importFile({ size: 120, text: () => gate.promise });
    if (action === 'cancel') await editor.cancel();
    if (action === 'close') editor.close();
    if (action === 'save') await editor.save();
    gate.resolve(JSON.stringify(imported));
    assert.equal(await reading, null, action);
    assert.equal(editor.getDraft().scenes[0].id, 'alley', action);
    assert.equal(h.currentStory.scenes[0].id, 'alley', action);
  }
});

test('a slow missing-media scan cannot overwrite the result or status of Cancel', async () => {
  const h = harness(), editor = await h.create(); await editor.open();
  const imported = initial(); imported.media = [{ id: 'lost', name: 'lost.wav', type: 'audio/wav', size: 4, durationMs: 1000 }];
  h.state.getMediaGate = deferred();
  const importing = editor.importProject(imported);
  await Promise.resolve();
  await editor.cancel(); const message = editor.getState().message;
  h.state.getMediaGate.resolve(null);
  assert.equal(await importing, null);
  assert.equal(editor.getState().message, message); assert.deepEqual(editor.getState().missingMedia, []);
});

test('uploaded audio is a separate Blob with a fresh immutable id and a configurable layer', async () => {
  const h = harness(), editor = await h.create(), file = wav('голос.wav');
  const metadata = await editor.addAudio(file, 'voice');
  assert.equal(h.media.get(metadata.id).blob, file); assert.equal(await h.resolve(metadata.id), file);
  assert.equal(editor.getDraft().media[0].durationMs, 1000); assert.equal(editor.getSaved().media.length, 0);
  const track = editor.getDraft().scenes[0].tracks[0];
  editor.updateTrack(track.id, { startMs: 1200, volume: .37, loop: true });
  assert.equal(editor.getDraft().scenes[0].tracks[0].loop, false);
  assert.equal(editor.getDraft().scenes[0].tracks[0].volume, .37);
  editor.addTrack(metadata.id, 'music');
  assert.notEqual(editor.getDraft().scenes[0].tracks[1].id, track.id);
  await editor.downloadMedia(metadata.id);
  assert.equal(h.downloads[0].blob, file); assert.equal(h.downloads[0].name, 'голос.wav');
  const json = editor.exportProject(); assert.equal(json.includes('data:'), false); assert.equal(json.includes('blob:'), false);
  assert.equal(JSON.parse(json).media[0].size, file.size); assert.equal(h.state.storageWrites, 0);
});

test('audio size/type limits are checked before metadata is read or storage is changed', async () => {
  const h = harness(), editor = await h.create();
  await assert.rejects(editor.addAudio({ size: 33 * 1024 * 1024, name: 'large.wav', type: 'audio/wav' }), /32 МБ/);
  await assert.rejects(editor.addAudio({ size: 4, name: 'image.png', type: 'image/png' }), /аудиофайл/);
  assert.equal(h.state.metadataCalls, 0); assert.equal(h.media.size, 0);
});

test('Cancel or import while audio metadata/storage is pending cannot attach that stale audio', async () => {
  for (const phase of ['metadata', 'storage']) {
    const h = harness(), editor = await h.create(); await editor.open();
    const gate = deferred(); h.state[phase === 'metadata' ? 'metadataGate' : 'putGate'] = gate;
    const adding = editor.addAudio(wav(), 'music');
    await Promise.resolve(); await editor.cancel(); gate.resolve();
    assert.equal(await adding, null, phase);
    assert.deepEqual(editor.getDraft().media, [], phase); assert.equal(editor.getState().mediaBusy, false);
    assert.equal(h.state.storageWrites, 0);
  }
  const h = harness(), editor = await h.create(); h.state.metadataGate = deferred();
  const adding = editor.addAudio(wav(), 'voice'); await editor.importProject(initial());
  h.state.metadataGate.resolve(); assert.equal(await adding, null);
  assert.deepEqual(editor.getDraft().media, []);
});

test('missing audio can be relinked by metadata but saved media ids are never overwritten', async () => {
  const h = harness(), editor = await h.create();
  const project = initial(); project.media.push({ id: 'portable', name: 'voice.wav', type: 'audio/wav', size: 4, durationMs: 1000 });
  project.scenes[0].tracks.push({ id: 'voice-track', assetId: 'portable', kind: 'voice', startMs: 0, volume: 1, loop: false });
  await editor.importProject(project); assert.deepEqual(editor.getState().missingMedia, ['portable']);
  const before = editor.exportProject(), file = wav();
  await assert.rejects(editor.relinkAudio('portable', wav('short.wav', 'a')), /Размер/);
  assert.equal(await editor.relinkAudio('portable', file), true);
  assert.deepEqual(editor.getState().missingMedia, []); assert.equal(editor.exportProject(), before);
  assert.equal(h.media.get('portable').blob, file);
  const inspections = h.state.metadataCalls;
  await assert.rejects(editor.relinkAudio('portable', wav('other.wav')), /уже сохранён/);
  assert.equal(h.state.metadataCalls, inspections); assert.equal(h.media.get('portable').blob, file);
});

test('storage failure keeps a usable exportable draft and view=1 disables editing only', async () => {
  const h = harness({ loadError: new Error('storage blocked') }), editor = await h.create();
  assert.match(editor.getState().message, /сохранение недоступно/);
  editor.setPhrase(0, { text: 'Локальный черновик' });
  assert.equal(JSON.parse(editor.exportProject()).scenes[0].phrases[0].text, 'Локальный черновик');
  const viewer = await harness({ search: '?view=1' }).create();
  assert.equal(viewer.getState().enabled, false);
  await assert.rejects(viewer.open(), /режим просмотра/);
  assert.throws(() => viewer.updateScene('alley', { durationMs: 19000 }), /режим просмотра/);
});

test('destroy cancels delayed drafts and media work without writing project state', async () => {
  const h = harness(), editor = await h.create(); await editor.open(); editor.setPhrase(0, { text: 'Черновик' });
  h.state.metadataGate = deferred(); const adding = editor.addAudio(wav());
  editor.destroy(); h.state.metadataGate.resolve();
  assert.equal(await adding, null); assert.equal(h.pending, 0);
  assert.equal(h.state.storageWrites, 0);
  await assert.rejects(editor.open(), /Редактор закрыт/);
});

test('a durable Save never replaces playback started or navigated during its pending transaction', async () => {
  for (const action of ['start', 'navigate', 'already-playing']) {
    const h = harness(), editor = await h.create(); await editor.open();
    editor.updateScene('alley', { durationMs: 18000 });
    if (action === 'already-playing') h.playerState.playing = true;
    h.state.saveGate = deferred(); const saving = editor.save();
    if (action === 'start') Object.assign(h.playerState, { playing: true, interactionVersion: h.playerState.interactionVersion + 1 });
    if (action === 'navigate') Object.assign(h.playerState, { sceneId: 'hero', index: 2, interactionVersion: h.playerState.interactionVersion + 1 });
    const viewer = { ...h.playerState }, applies = h.events.filter(item => item.type === 'apply').length;
    h.state.saveGate.resolve(); await saving;
    assert.deepEqual(h.playerState, viewer, action);
    assert.equal(h.events.filter(item => item.type === 'apply').length, applies, action);
    assert.equal(h.state.saved.scenes[0].durationMs, 18000);
  }
});

test('the initially silent fifth scene supports authored phrases and returns cleanly to no captions', async () => {
  const h = harness(), editor = await h.create(); await editor.open(); editor.selectScene('revelation');
  editor.addPhrase(); editor.setPhrase(0, { text: '😀 Неожиданный заголовок', speaker: 'ДАША' });
  editor.addPhrase();
  assert.equal(editor.getDraft().scenes[4].phrases.length, 2);
  assert.equal(editor.getDraft().scenes[4].durationMs, 8250);
  await h.flush();
  assert.equal(h.currentStory.scenes[4].phrases[0].text, '😀 Неожиданный заголовок');
  editor.removePhrase(); editor.removePhrase(); await h.flush();
  assert.equal(h.currentStory.scenes[4].text, ''); assert.equal(h.currentStory.scenes[4].speaker, '');
  assert.equal(h.currentStory.scenes[4].phrases, undefined);
  assert.equal(source.scenes[4].text, ''); assert.equal(source.scenes[4].duration, 8000);
  assert.equal(h.state.storageWrites, 0);
});
