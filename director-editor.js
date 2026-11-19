(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AlleyDirector = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict';

  const MAX_FILE = 32 * 1024 * 1024;
  const MAX_TOTAL = 150 * 1024 * 1024;
  const MAX_JSON = 1024 * 1024;
  const AUDIO_EXT = /\.(mp3|wav|ogg|m4a|aac|flac|webm|opus)$/i;
  const clone = value => JSON.parse(JSON.stringify(value));
  const kinds = { voice: 'Голос', music: 'Музыка', ambience: 'Атмосфера', effects: 'Эффект' };
  const mediaType = file => file.type || ({ mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', webm: 'audio/webm', opus: 'audio/ogg' })[String(file.name).split('.').pop().toLowerCase()] || '';
  const safeFilename = name => String(name).replace(/[\\/<>:"|?*\u0000-\u001f\u007f]/g, '_').slice(0, 160) || 'audio';

  function readAudioMetadata(file, window, document) {
    return new Promise((resolve, reject) => {
      const audio = document.createElement('audio');
      const url = window.URL.createObjectURL(file);
      let settled = false;
      const timeout = window.setTimeout(() => finish(new Error('Не удалось прочитать длительность аудио. Выберите поддерживаемый аудиофайл.')), 10000);
      function finish(error) {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        audio.onloadedmetadata = null;
        audio.onerror = null;
        const durationMs = Math.round(Number(audio.duration) * 1000);
        audio.pause();
        audio.removeAttribute('src');
        try { audio.load(); } catch (_) { /* Detached media needs no further loading. */ }
        window.URL.revokeObjectURL(url);
        if (error) reject(error);
        else if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 600000) reject(new Error('Аудиозапись должна длиться от доли секунды до 10 минут.'));
        else resolve({ durationMs });
      }
      audio.preload = 'metadata';
      audio.onloadedmetadata = () => finish();
      audio.onerror = () => finish(new Error('Браузер не прочитал аудиофайл. Попробуйте MP3, WAV или OGG.'));
      audio.src = url;
      audio.load();
    });
  }

  async function create(options = {}) {
    const window = options.window || root;
    const document = options.document || window.document;
    const model = options.model || window.AlleyDirectorProject;
    const storage = options.storage;
    const player = options.player;
    const baseline = options.baseline || window.AlleyStory;
    if (!model || !storage || !player || !baseline) throw new TypeError('Director requires story, model, storage and player');
    const mounted = options.mount !== false;
    if (mounted && !document?.createElement) throw new TypeError('Director requires a document');
    const defer = options.setTimeout || window.setTimeout.bind(window);
    const clear = options.clearTimeout || window.clearTimeout.bind(window);
    let nextId = 0;
    const uid = options.uid || (prefix => prefix + '-' + (window.crypto?.randomUUID?.() || Date.now().toString(36) + '-' + (++nextId) + '-' + Math.random().toString(36).slice(2, 9)));
    const inspectAudio = options.readAudioMetadata || (file => readAudioMetadata(file, window, document));
    const listeners = [];
    const objectURLs = new Set();
    const original = model.validate(model.fromStory(baseline), baseline);
    let saved = clone(original);
    let draft = clone(saved);
    let selectedSceneId = player.getState?.().sceneId || saved.scenes[0].id;
    let selectedPhrase = 0;
    let opened = false;
    let destroyed = false;
    let dirty = false;
    let saving = false;
    let mediaBusy = false;
    let revision = 0;
    let epoch = 0;
    let missingVersion = 0;
    let liveTimer = null;
    let message = '';
    let error = false;
    let missing = new Set();
    let previousFocus = null;
    let returnMode = 'cinema';
    let view = null;
    let loadProblem = '';
    const viewOnly = options.enabled === false || (() => {
      try { return new URLSearchParams(window.location?.search || '').get('view') === '1'; }
      catch (_) { return false; }
    })();

    const scene = () => draft.scenes.find(item => item.id === selectedSceneId) || draft.scenes[0];
    const sceneTitle = id => baseline.scenes.find(item => item.id === id)?.title || id;
    function listen(target, type, handler) {
      target.addEventListener(type, handler);
      listeners.push(() => target.removeEventListener(type, handler));
    }
    function say(text, failed = false) {
      message = String(text || ''); error = failed;
      if (view) view.status();
    }
    function stopLive() { if (liveTimer !== null) clear(liveTimer); liveTimer = null; }
    function normalized() { return model.validate(draft, baseline); }
    function compiled(project) { return model.compile(project, baseline); }
    async function show(project, { mode = 'comic', elapsed = 0 } = {}) {
      return player.applyStory(compiled(project), { sceneId: selectedSceneId, mode, elapsed, autoplay: false });
    }
    async function checkMissing() {
      const version = ++missingVersion;
      const projectEpoch = epoch;
      const references = clone(draft.media);
      const unavailable = new Set();
      for (const item of references) {
        try { if (!await storage.getMedia(item.id)) unavailable.add(item.id); }
        catch (_) { unavailable.add(item.id); }
      }
      if (destroyed || version !== missingVersion || projectEpoch !== epoch) return;
      missing = unavailable;
      if (view) view.media();
    }
    function refresh({ fields = true } = {}) {
      if (!view) return;
      view.status();
      if (fields) view.fields();
    }
    function touch({ fields = false, live = true } = {}) {
      revision += 1;
      dirty = JSON.stringify(draft) !== JSON.stringify(saved);
      say(dirty ? 'Есть несохранённые изменения.' : 'Сохранённая версия проекта.');
      refresh({ fields });
      stopLive();
      if (opened && live) {
        const version = revision;
        liveTimer = defer(async () => {
          liveTimer = null;
          if (destroyed || !opened || version !== revision) return;
          try {
            const project = normalized();
            await show(project);
            if (version === revision && opened && !destroyed) say(dirty ? 'Предпросмотр обновлён. Изменения ещё не сохранены.' : 'Сохранённая версия проекта.');
          } catch (failure) { if (version === revision && opened && !destroyed) say(failure.message, true); }
        }, 220);
      }
    }
    function requireEditable() {
      if (destroyed) throw new Error('Редактор закрыт.');
      if (saving) throw new Error('Дождитесь завершения сохранения.');
      if (viewOnly) throw new Error('Открыт режим просмотра.');
    }
    function patchScene(id, patch) {
      requireEditable();
      const target = draft.scenes.find(item => item.id === id);
      if (!target) throw new Error('Кадр не найден.');
      for (const name of ['durationMs', 'transitionMs', 'phrases', 'tracks']) if (Object.hasOwn(patch, name)) target[name] = clone(patch[name]);
      if (patch.camera) target.camera = { ...target.camera, ...patch.camera };
      if (patch.effects) target.effects = { ...target.effects, ...patch.effects };
      touch();
      return getDraft();
    }
    function setPhrase(index, patch) {
      requireEditable();
      const target = scene().phrases[index];
      if (!target) throw new Error('Выберите реплику.');
      for (const name of ['text', 'speaker', 'startMs', 'typingMs', 'endMs']) if (Object.hasOwn(patch, name)) target[name] = patch[name];
      touch();
      if (view) view.phraseOptions();
    }
    function selectScene(id) {
      requireEditable();
      if (!draft.scenes.some(item => item.id === id)) throw new Error('Кадр не найден.');
      selectedSceneId = id;
      selectedPhrase = 0;
      revision += 1;
      stopLive();
      refresh();
      if (opened) {
        try { Promise.resolve(show(normalized())).catch(failure => say(failure.message, true)); }
        catch (failure) { say(failure.message, true); }
      }
    }
    function reorder(direction) {
      requireEditable();
      const index = draft.scenes.findIndex(item => item.id === selectedSceneId);
      const destination = index + Math.sign(direction);
      if (destination < 0 || destination >= draft.scenes.length) return;
      [draft.scenes[index], draft.scenes[destination]] = [draft.scenes[destination], draft.scenes[index]];
      touch({ fields: true });
    }
    function addPhrase() {
      requireEditable();
      const current = scene();
      if (current.phrases.length >= 24) throw new Error('В кадре может быть не больше 24 реплик.');
      const last = current.phrases.at(-1);
      const startMs = last ? last.endMs + 250 : 1000;
      const endMs = startMs + 3500;
      current.durationMs = Math.max(current.durationMs, endMs);
      current.phrases.push({ text: '', speaker: last?.speaker || baseline.scenes.find(item => item.id === current.id)?.speaker || '', startMs, typingMs: 1500, endMs });
      selectedPhrase = current.phrases.length - 1;
      touch({ fields: true });
      view?.inputs.text.focus();
    }
    function removePhrase() {
      requireEditable();
      scene().phrases.splice(selectedPhrase, 1);
      selectedPhrase = Math.max(0, Math.min(selectedPhrase, scene().phrases.length - 1));
      touch({ fields: true });
    }
    async function open() {
      requireEditable();
      if (opened) return;
      const state = player.getState?.() || {};
      returnMode = state.mode || 'cinema';
      if (draft.scenes.some(item => item.id === state.sceneId)) selectedSceneId = state.sceneId;
      player.pause();
      opened = true;
      previousFocus = document?.activeElement;
      if (view) { view.panel.hidden = false; view.toggle.setAttribute('aria-expanded', 'true'); refresh(); }
      try { await show(normalized()); }
      catch (failure) { say(failure.message, true); }
      if (view && opened) {
        document.querySelector('.visual')?.scrollIntoView?.({ block: 'start', behavior: 'auto' });
        view.inputs.scene.focus();
      }
      await checkMissing();
    }
    function close() {
      if (!opened) return;
      opened = false;
      revision += 1;
      stopLive();
      if (view) { view.panel.hidden = true; view.toggle.setAttribute('aria-expanded', 'false'); }
      previousFocus?.focus?.();
      previousFocus = null;
    }
    async function preview() {
      requireEditable(); stopLive();
      const project = normalized();
      // Call synchronously inside the button gesture, before awaiting anything.
      const result = player.preview(compiled(project), { sceneId: selectedSceneId });
      close();
      const version = revision;
      await result;
      if (!destroyed && !opened && version === revision) say('Предпросмотр. Откройте режим режиссёра, чтобы продолжить работу.');
      return clone(project);
    }
    async function save() {
      requireEditable();
      if (mediaBusy) throw new Error('Дождитесь загрузки аудиофайла.');
      stopLive();
      const project = normalized();
      revision += 1;
      const version = revision;
      const viewer = player.getState?.() || {};
      const viewerSnapshot = JSON.stringify(viewer);
      saving = true; refresh({ fields: false });
      say('Сохраняем проект в этом браузере…');
      try {
        await storage.save(project);
        saved = clone(project);
        if (version === revision) draft = clone(project);
        dirty = JSON.stringify(draft) !== JSON.stringify(saved);
        if (!destroyed && version === revision && !viewer.playing && !viewer.starting
          && JSON.stringify(player.getState?.() || {}) === viewerSnapshot) await show(saved, { mode: opened ? 'comic' : returnMode });
        say(dirty ? 'Версия сохранена. Более новые изменения ещё не сохранены.' : 'Проект сохранён в этом браузере.');
        return clone(saved);
      } catch (failure) { say('Не удалось сохранить: ' + failure.message, true); throw failure; }
      finally { saving = false; refresh(); }
    }
    async function cancel() {
      requireEditable();
      stopLive(); epoch += 1; revision += 1;
      draft = clone(saved); dirty = false;
      if (!draft.scenes.some(item => item.id === selectedSceneId)) selectedSceneId = draft.scenes[0].id;
      selectedPhrase = 0;
      player.pause();
      await show(saved, { mode: returnMode });
      say('Изменения отменены. Восстановлена сохранённая версия.');
      refresh(); close();
      await checkMissing();
      return clone(saved);
    }
    function exportProject() { return JSON.stringify(normalized(), null, 2); }
    async function importProject(input) {
      requireEditable();
      let raw;
      if (typeof input === 'string') {
        if (new TextEncoder().encode(input).byteLength > MAX_JSON) throw new Error('JSON проекта должен быть не больше 1 МБ.');
        try { raw = JSON.parse(input); }
        catch (_) { throw new Error('Файл не содержит корректный JSON проекта.'); }
      } else raw = input;
      const project = model.validate(raw, baseline); // Nothing changes until the entire import validates.
      stopLive();
      epoch += 1;
      const projectEpoch = epoch;
      draft = clone(project);
      if (!draft.scenes.some(item => item.id === selectedSceneId)) selectedSceneId = draft.scenes[0].id;
      selectedPhrase = 0;
      touch({ fields: true, live: false });
      const version = revision;
      await show(project, { mode: opened ? 'comic' : returnMode });
      if (destroyed || projectEpoch !== epoch || version !== revision) return null;
      await checkMissing();
      if (destroyed || projectEpoch !== epoch || version !== revision) return null;
      say(missing.size ? 'Проект импортирован в черновик. Для отсутствующего звука выберите исходные аудиофайлы; затем сохраните проект.' : 'Проект импортирован в черновик. Нажмите «Сохранить», чтобы оставить его в браузере.');
      return clone(project);
    }
    async function importFile(file) {
      requireEditable();
      if (!file || !Number.isFinite(file.size) || file.size > MAX_JSON || typeof file.text !== 'function') throw new Error('JSON проекта должен быть не больше 1 МБ.');
      const version = revision, projectEpoch = epoch;
      const text = await file.text();
      if (destroyed || projectEpoch !== epoch || version !== revision) return null;
      return importProject(text);
    }
    function assertAudio(file) {
      if (!file || !Number.isFinite(file.size) || file.size <= 0 || file.size > MAX_FILE) throw new Error('Выберите аудиофайл размером до 32 МБ.');
      if (!AUDIO_EXT.test(String(file.name)) && !/^audio\//i.test(String(file.type))) throw new Error('Выберите аудиофайл MP3, WAV, OGG или другой поддерживаемый формат.');
    }
    async function addAudio(file, kind = 'voice') {
      requireEditable(); assertAudio(file);
      if (!Object.hasOwn(kinds, kind)) throw new Error('Неизвестный тип дорожки.');
      if (mediaBusy) throw new Error('Дождитесь загрузки предыдущего аудиофайла.');
      const current = scene();
      if (current.tracks.length >= 8) throw new Error('В кадре может быть не больше 8 дорожек.');
      if (draft.media.reduce((sum, item) => sum + item.size, 0) + file.size > MAX_TOTAL) throw new Error('В проекте можно хранить до 150 МБ аудио.');
      const version = epoch, sceneId = selectedSceneId;
      mediaBusy = true; refresh({ fields: false }); say('Читаем локальный аудиофайл…');
      try {
        const info = await inspectAudio(file);
        if (destroyed || version !== epoch) return null;
        const metadata = { id: uid('media'), name: String(file.name), type: mediaType(file), size: file.size, durationMs: Math.round(info.durationMs) };
        const track = { id: uid('track'), kind, assetId: metadata.id, startMs: 0, volume: 1, loop: false };
        const candidate = clone(draft);
        candidate.media.push(metadata);
        candidate.scenes.find(item => item.id === sceneId).tracks.push(track);
        model.validate(candidate, baseline);
        await storage.putMedia({ id: metadata.id, blob: file, metadata });
        if (destroyed || version !== epoch) return null;
        draft.media.push(metadata);
        draft.scenes.find(item => item.id === sceneId).tracks.push(track);
        missingVersion += 1;
        missing.delete(metadata.id);
        touch({ fields: true });
        say('Аудиофайл добавлен в черновик. Голос воспроизводится целиком. Нажмите «Сохранить».');
        return clone(metadata);
      } catch (failure) { if (!destroyed && version === epoch) say(failure.message, true); throw failure; }
      finally { mediaBusy = false; refresh({ fields: false }); }
    }
    async function relinkAudio(id, file) {
      requireEditable(); assertAudio(file);
      if (mediaBusy) throw new Error('Дождитесь загрузки предыдущего аудиофайла.');
      const metadata = draft.media.find(item => item.id === id);
      if (!metadata) throw new Error('Аудиофайл не указан в проекте.');
      if (file.size !== metadata.size) throw new Error('Размер не совпадает с исходным файлом «' + metadata.name + '». Для новой записи добавьте новую дорожку.');
      const version = epoch;
      mediaBusy = true; refresh({ fields: false });
      try {
        if (await storage.getMedia(id)) throw new Error('Этот аудиофайл уже сохранён. Новую запись добавьте отдельной дорожкой.');
        const info = await inspectAudio(file);
        if (Math.abs(info.durationMs - metadata.durationMs) > 250) throw new Error('Длительность не совпадает с исходной записью. Выберите правильный аудиофайл.');
        if (destroyed || version !== epoch) return false;
        await storage.putMedia({ id, blob: file, metadata: clone(metadata) });
        if (destroyed || version !== epoch) return false;
        missingVersion += 1;
        missing.delete(id);
        refresh();
        if (opened) await show(normalized());
        say('Связь с аудиофайлом восстановлена. Сам JSON проекта не изменён.');
        return true;
      } catch (failure) { if (!destroyed && version === epoch) say(failure.message, true); throw failure; }
      finally { mediaBusy = false; refresh({ fields: false }); }
    }
    function addTrack(assetId, kind = 'voice') {
      requireEditable();
      if (!draft.media.some(item => item.id === assetId)) throw new Error('Выберите аудиофайл из проекта.');
      if (!Object.hasOwn(kinds, kind)) throw new Error('Неизвестный тип дорожки.');
      if (scene().tracks.length >= 8) throw new Error('В кадре может быть не больше 8 дорожек.');
      scene().tracks.push({ id: uid('track'), kind, assetId, startMs: 0, volume: 1, loop: false });
      touch({ fields: true });
    }
    function updateTrack(id, patch) {
      requireEditable();
      const target = scene().tracks.find(item => item.id === id);
      if (!target) throw new Error('Дорожка не найдена.');
      for (const name of ['kind', 'startMs', 'volume', 'loop']) if (Object.hasOwn(patch, name)) target[name] = patch[name];
      if (target.kind === 'voice') target.loop = false;
      touch();
    }
    function removeTrack(id) {
      requireEditable();
      scene().tracks = scene().tracks.filter(item => item.id !== id);
      touch({ fields: true });
    }
    function download(blob, name) {
      if (options.download) return options.download(blob, safeFilename(name));
      const url = window.URL.createObjectURL(blob);
      objectURLs.add(url);
      const anchor = document.createElement('a');
      anchor.href = url; anchor.download = safeFilename(name); anchor.hidden = true;
      document.body.appendChild(anchor); anchor.click(); anchor.remove();
      defer(() => { window.URL.revokeObjectURL(url); objectURLs.delete(url); }, 1000);
    }
    async function downloadMedia(id) {
      const item = draft.media.find(entry => entry.id === id);
      if (!item) throw new Error('Аудиофайл не найден в проекте.');
      const blob = await storage.getMedia(id);
      if (!blob) throw new Error('Аудиофайла нет в этом браузере. Выберите исходный файл для восстановления связи.');
      await download(blob, item.name);
      return blob;
    }
    function getDraft() { return clone(draft); }
    function getSaved() { return clone(saved); }
    function getState() { return { open: opened, dirty, saving, mediaBusy, sceneId: selectedSceneId, phraseIndex: selectedPhrase, message, error, missingMedia: [...missing], enabled: !viewOnly }; }

    function mount() {
      const host = document.getElementById('cinema-player');
      const toolbar = host?.querySelector('.toolbar');
      if (!host || !toolbar) throw new Error('Не найдена панель плеера для режима режиссёра.');
      const toggle = document.createElement('button');
      toggle.id = 'director-toggle'; toggle.type = 'button'; toggle.className = 'director-toggle';
      toggle.textContent = 'Режим режиссёра'; toggle.setAttribute('aria-expanded', 'false'); toggle.setAttribute('aria-controls', 'director-panel');
      const panel = document.createElement('aside');
      panel.id = 'director-panel'; panel.className = 'director-panel'; panel.hidden = true;
      panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'false'); panel.setAttribute('aria-labelledby', 'director-title');
      // This template is static. Project text, names and filenames are assigned only through value/textContent.
      panel.innerHTML = `
        <div class="director-header"><div><p class="director-kicker">ЛОКАЛЬНАЯ МОНТАЖНАЯ</p><h2 id="director-title">Режим режиссёра</h2></div><button id="director-close" type="button" aria-label="Закрыть редактор, сохранив черновик">×</button></div>
        <div class="director-body">
          <p class="director-note">Правки и звук остаются в этом браузере. Исходная история не перезаписывается.</p>
          <section class="director-section"><h3>Кадр</h3><label class="director-field" for="director-scene">Выбрать сцену<select id="director-scene"></select></label><div class="director-row"><button id="director-scene-up" type="button">↑ Раньше</button><button id="director-scene-down" type="button">↓ Позже</button></div><div class="director-row"><label class="director-field">Длительность, с<input id="director-duration" type="number" min="1" max="600" step="0.1"></label><label class="director-field">Переход, мс<input id="director-transition" type="number" min="0" max="2000" step="50"></label></div></section>
          <details class="director-section" open><summary>Реплики</summary><label class="director-field" for="director-phrase">Выбрать реплику<select id="director-phrase"></select></label><div class="director-row"><button id="director-phrase-add" type="button">+ Реплика</button><button id="director-phrase-remove" type="button">Удалить реплику</button></div><fieldset id="director-phrase-fields"><label class="director-field">Кто говорит<input id="director-speaker" type="text" maxlength="80"></label><label class="director-field">Текст<textarea id="director-text" rows="4" maxlength="4000"></textarea></label><div class="director-row"><label class="director-field">Появление, с<input id="director-start" type="number" min="0" step="0.1"></label><label class="director-field">Набор, с<input id="director-typing" type="number" min="0.01" step="0.1"></label><label class="director-field">Скрыть в, с<input id="director-end" type="number" min="0.01" step="0.1"></label></div></fieldset></details>
          <details class="director-section"><summary>Звук по дорожкам</summary><label class="director-field">Тип дорожки<select id="director-upload-kind"><option value="voice">Голос</option><option value="music">Музыка</option><option value="ambience">Атмосфера</option><option value="effects">Эффект</option></select></label><label class="director-field director-file-label">Добавить локальный аудиофайл<input id="director-upload" type="file" accept="audio/*,.mp3,.wav,.ogg,.m4a,.aac,.flac,.webm,.opus"></label><p class="director-note">До 32 МБ на файл. Голос звучит целиком, без обрезания; кадр при необходимости станет длиннее.</p><div class="director-row"><label class="director-field">Из файлов проекта<select id="director-library"></select></label><button id="director-track-add" type="button">+ Дорожка</button></div><div id="director-tracks"></div></details>
          <details class="director-section"><summary>Камера и эффекты</summary><div class="director-row"><label class="director-field">Масштаб в начале, %<input id="director-camera-start" type="number" min="100" max="104" step="0.1"></label><label class="director-field">В конце, %<input id="director-camera-end" type="number" min="100" max="104" step="0.1"></label></div><div class="director-row"><label class="director-field">Центр по горизонтали, %<input id="director-focus-x" type="number" min="0" max="100" step="1"></label><label class="director-field">По вертикали, %<input id="director-focus-y" type="number" min="0" max="100" step="1"></label></div><label class="director-field">Дым, %<input id="director-smoke" type="range" min="0" max="100" step="1"><output id="director-smoke-value"></output></label><label class="director-field">Мягкое мерцание, %<input id="director-flicker" type="range" min="0" max="100" step="1"><output id="director-flicker-value"></output></label></details>
          <details class="director-section"><summary>Перенос проекта</summary><div class="director-row"><button id="director-export" type="button">Экспорт JSON</button><label class="director-field director-file-label">Импорт JSON<input id="director-import" type="file" accept="application/json,.json"></label></div><p class="director-note">JSON хранит настройки. Скачайте аудио отдельно кнопками ниже и перенесите вместе с JSON; после импорта выберите эти файлы для восстановления связи.</p><div id="director-media" class="director-media-list"></div></details>
        </div><p id="director-status" class="director-status" role="status" aria-live="polite"></p><div class="director-actions"><button id="director-preview" type="button">Предпросмотр</button><button id="director-save" type="button" class="primary">Сохранить</button><button id="director-cancel" type="button">Отменить изменения</button></div>`;
      toolbar.appendChild(toggle); host.appendChild(panel);
      const byId = id => panel.querySelector('#director-' + id);
      const inputs = Object.fromEntries(['scene', 'duration', 'transition', 'phrase', 'text', 'speaker', 'start', 'typing', 'end', 'camera-start', 'camera-end', 'focus-x', 'focus-y', 'smoke', 'flicker', 'upload', 'upload-kind', 'library', 'import'].map(id => [id, byId(id)]));
      const protectedButtons = ['scene-up', 'scene-down', 'phrase-add', 'phrase-remove', 'preview', 'save', 'cancel', 'track-add', 'export'].map(byId);
      function guarded(action) { return event => { try { Promise.resolve(action(event)).catch(failure => say(failure.message, true)); } catch (failure) { say(failure.message, true); } }; }
      function optionsFor(select, values, selected) {
        select.replaceChildren();
        for (const [value, label] of values) {
          const option = document.createElement('option'); option.value = String(value); option.textContent = label; select.appendChild(option);
        }
        select.value = String(selected ?? '');
      }
      function fieldValue(input, value, force = false) { if (force || document.activeElement !== input) input.value = String(value ?? ''); }
      function phraseOptions() {
        optionsFor(inputs.phrase, scene().phrases.map((item, index) => [index, (index + 1) + '. ' + (item.text.replace(/\s+/g, ' ').slice(0, 55) || 'Новая реплика')]), selectedPhrase);
        if (!scene().phrases.length) optionsFor(inputs.phrase, [['', 'В этом кадре нет реплик']], '');
      }
      function trackRows() {
        const host = byId('tracks'); host.replaceChildren();
        for (const track of scene().tracks) {
          const row = document.createElement('fieldset'); row.className = 'director-track director-section'; row.dataset.trackId = track.id;
          const name = document.createElement('legend'); name.textContent = draft.media.find(item => item.id === track.assetId)?.name || 'Аудиофайл'; row.appendChild(name);
          function label(text, input) { const wrap = document.createElement('label'); wrap.className = 'director-field'; wrap.appendChild(document.createTextNode(text)); wrap.appendChild(input); row.appendChild(wrap); return input; }
          const kind = label('Слой', document.createElement('select')); kind.className = 'director-track-kind';
          optionsFor(kind, Object.entries(kinds), track.kind);
          const start = label('Начало, с', document.createElement('input')); start.className = 'director-track-start'; start.type = 'number'; start.min = '0'; start.step = '0.1'; start.value = String(track.startMs / 1000);
          const volume = label('Громкость, %', document.createElement('input')); volume.className = 'director-track-volume'; volume.type = 'range'; volume.min = '0'; volume.max = '100'; volume.step = '1'; volume.value = String(Math.round(track.volume * 100));
          const output = document.createElement('output'); output.textContent = Math.round(track.volume * 100) + '%'; row.appendChild(output);
          const loop = label('Повторять до конца кадра', document.createElement('input')); loop.className = 'director-track-loop'; loop.type = 'checkbox'; loop.checked = track.loop; loop.disabled = track.kind === 'voice';
          const remove = document.createElement('button'); remove.type = 'button'; remove.dataset.action = 'remove-track'; remove.textContent = 'Удалить дорожку'; row.appendChild(remove);
          listen(kind, 'change', guarded(() => { updateTrack(track.id, { kind: kind.value }); loop.disabled = kind.value === 'voice'; if (loop.disabled) loop.checked = false; }));
          listen(start, 'input', guarded(() => updateTrack(track.id, { startMs: Number(start.value) * 1000 })));
          listen(volume, 'input', guarded(() => { updateTrack(track.id, { volume: Number(volume.value) / 100 }); output.textContent = volume.value + '%'; }));
          listen(loop, 'change', guarded(() => updateTrack(track.id, { loop: loop.checked })));
          listen(remove, 'click', guarded(() => removeTrack(track.id)));
          host.appendChild(row);
        }
        if (!scene().tracks.length) { const note = document.createElement('p'); note.className = 'director-note'; note.textContent = 'Локальные дорожки пока не добавлены. Подготовленные звуки исходной истории сохранены.'; host.appendChild(note); }
      }
      function mediaRows() {
        const host = byId('media'); host.replaceChildren();
        for (const item of draft.media) {
          const row = document.createElement('div'); row.className = 'director-media-row'; row.dataset.mediaId = item.id;
          const name = document.createElement('p'); name.textContent = item.name; row.appendChild(name);
          const state = document.createElement('p'); state.className = 'director-note'; state.textContent = missing.has(item.id) ? 'Файла нет в этом браузере. Выберите исходную запись.' : 'Сохранён отдельно: ' + (item.size / 1024 / 1024).toFixed(1) + ' МБ'; row.appendChild(state);
          const button = document.createElement('button'); button.type = 'button'; button.className = 'director-download'; button.textContent = 'Скачать аудио'; button.disabled = missing.has(item.id); row.appendChild(button);
          listen(button, 'click', guarded(() => downloadMedia(item.id)));
          if (missing.has(item.id)) {
            const label = document.createElement('label'); label.className = 'director-field director-file-label'; label.textContent = 'Восстановить связь с файлом';
            const input = document.createElement('input'); input.type = 'file'; input.accept = 'audio/*,.mp3,.wav,.ogg,.m4a,.aac,.flac,.webm,.opus'; input.className = 'director-relink'; label.appendChild(input); row.appendChild(label);
            listen(input, 'change', guarded(async () => { const file = input.files?.[0]; if (file) await relinkAudio(item.id, file); input.value = ''; }));
          }
          host.appendChild(row);
        }
        if (!draft.media.length) { const note = document.createElement('p'); note.className = 'director-note'; note.textContent = 'В проекте пока нет загруженных аудиофайлов.'; host.appendChild(note); }
      }
      function fields() {
        const current = scene();
        optionsFor(inputs.scene, draft.scenes.map((item, index) => [item.id, (index + 1) + '. ' + sceneTitle(item.id)]), current.id);
        selectedPhrase = Math.max(0, Math.min(selectedPhrase, current.phrases.length - 1));
        phraseOptions();
        for (const [id, value] of Object.entries({ duration: current.durationMs / 1000, transition: current.transitionMs,
          'camera-start': current.camera.start * 100, 'camera-end': current.camera.end * 100, 'focus-x': current.camera.focusX, 'focus-y': current.camera.focusY,
          smoke: current.effects.smoke * 100, flicker: current.effects.flicker * 100 })) fieldValue(inputs[id], value);
        const phrase = current.phrases[selectedPhrase];
        byId('phrase-fields').disabled = !phrase || saving;
        for (const [id, value] of Object.entries({ text: phrase?.text || '', speaker: phrase?.speaker || '', start: (phrase?.startMs || 0) / 1000, typing: (phrase?.typingMs || 0) / 1000, end: (phrase?.endMs || 0) / 1000 })) fieldValue(inputs[id], value);
        optionsFor(inputs.library, draft.media.map(item => [item.id, item.name]), inputs.library.value || draft.media[0]?.id);
        trackRows(); mediaRows(); status();
      }
      function status() {
        panel.dataset.dirty = String(dirty); panel.dataset.saving = String(saving);
        const status = byId('status');
        if (status.textContent !== message) status.textContent = message;
        status.classList.toggle('is-error', error);
        for (const input of Object.values(inputs)) input.disabled = saving;
        for (const button of protectedButtons) button.disabled = saving;
        const index = draft.scenes.findIndex(item => item.id === selectedSceneId);
        byId('scene-up').disabled = saving || index === 0;
        byId('scene-down').disabled = saving || index === draft.scenes.length - 1;
        byId('phrase-remove').disabled = saving || !scene().phrases.length;
        byId('phrase-fields').disabled = saving || !scene().phrases.length;
        inputs.upload.disabled = saving || mediaBusy;
        byId('track-add').disabled = saving || mediaBusy || !draft.media.length;
        byId('save').disabled = saving || mediaBusy;
        for (const id of ['smoke', 'flicker']) byId(id + '-value').textContent = Math.round(scene().effects[id] * 100) + '%';
      }
      view = { panel, toggle, inputs, fields, status, phraseOptions, media: mediaRows };
      listen(toggle, 'click', guarded(() => opened ? close() : open()));
      listen(byId('close'), 'click', close);
      listen(panel, 'keydown', event => { if (event.key === 'Escape' && opened) { event.preventDefault(); event.stopPropagation(); close(); } });
      listen(inputs.scene, 'change', guarded(() => selectScene(inputs.scene.value)));
      listen(byId('scene-up'), 'click', guarded(() => reorder(-1)));
      listen(byId('scene-down'), 'click', guarded(() => reorder(1)));
      listen(inputs.phrase, 'change', () => { selectedPhrase = Number(inputs.phrase.value) || 0; fields(); });
      listen(byId('phrase-add'), 'click', guarded(addPhrase));
      listen(byId('phrase-remove'), 'click', guarded(removePhrase));
      listen(inputs.duration, 'input', guarded(() => patchScene(selectedSceneId, { durationMs: Number(inputs.duration.value) * 1000 })));
      listen(inputs.transition, 'input', guarded(() => patchScene(selectedSceneId, { transitionMs: Number(inputs.transition.value) })));
      for (const field of ['text', 'speaker']) listen(inputs[field], 'input', guarded(() => setPhrase(selectedPhrase, { [field]: inputs[field].value })));
      for (const [id, field] of [['start', 'startMs'], ['typing', 'typingMs'], ['end', 'endMs']]) listen(inputs[id], 'input', guarded(() => setPhrase(selectedPhrase, { [field]: Number(inputs[id].value) * 1000 })));
      for (const [id, field, factor] of [['camera-start', 'start', .01], ['camera-end', 'end', .01], ['focus-x', 'focusX', 1], ['focus-y', 'focusY', 1]]) listen(inputs[id], 'input', guarded(() => patchScene(selectedSceneId, { camera: { [field]: Number(inputs[id].value) * factor } })));
      for (const id of ['smoke', 'flicker']) listen(inputs[id], 'input', guarded(() => patchScene(selectedSceneId, { effects: { [id]: Number(inputs[id].value) / 100 } })));
      listen(inputs.upload, 'change', guarded(async () => { const file = inputs.upload.files?.[0]; if (file) await addAudio(file, inputs['upload-kind'].value); inputs.upload.value = ''; }));
      listen(byId('track-add'), 'click', guarded(() => addTrack(inputs.library.value, inputs['upload-kind'].value)));
      listen(byId('preview'), 'click', guarded(preview));
      listen(byId('save'), 'click', guarded(save));
      listen(byId('cancel'), 'click', guarded(cancel));
      listen(byId('export'), 'click', guarded(() => { download(new (window.Blob || Blob)([exportProject()], { type: 'application/json' }), 'pereulok-project.json'); say('JSON скачан. Аудиофайлы скачайте отдельно ниже.'); }));
      listen(inputs.import, 'change', guarded(async () => { const file = inputs.import.files?.[0]; if (!file) return; await importFile(file); inputs.import.value = ''; }));
      fields();
    }

    // Attach the local resolver before yielding. A late storage read must never
    // reconfigure audio or replace a film the viewer has already started.
    if (typeof player.setMediaResolver === 'function') player.setMediaResolver(id => storage.getMedia(id));
    const initialPlayerState = JSON.stringify(player.getState?.() || {});
    let deferredSaved = false;
    try {
      const stored = await storage.load();
      if (stored) {
        saved = model.validate(stored, baseline);
        draft = clone(saved);
        if (!draft.scenes.some(item => item.id === selectedSceneId)) selectedSceneId = draft.scenes[0].id;
        if (JSON.stringify(player.getState?.() || {}) === initialPlayerState) {
          await show(saved, { mode: player.getState?.().mode || 'cinema' });
        } else deferredSaved = true;
      }
    } catch (failure) { loadProblem = 'Локальное сохранение недоступно: ' + failure.message + ' Исходная история сохранена; черновик можно экспортировать в JSON.'; }
    if (mounted && !viewOnly) mount();
    if (loadProblem) say(loadProblem, true);
    else say(deferredSaved ? 'Сохранённый проект доступен в редакторе. Текущий просмотр не прерван.' : 'Выберите кадр. Сохранение и звук остаются в этом браузере.');
    await checkMissing();
    return {
      open, close, selectScene, reorder, updateScene: patchScene, setPhrase, addPhrase, removePhrase,
      preview, save, cancel, importProject, importFile, exportProject, addAudio, relinkAudio, addTrack, updateTrack, removeTrack, downloadMedia,
      getDraft, getSaved, getState,
      destroy() {
        if (destroyed) return;
        destroyed = true; epoch += 1; revision += 1; stopLive();
        listeners.forEach(remove => remove());
        objectURLs.forEach(url => window.URL.revokeObjectURL(url)); objectURLs.clear();
        if (view) { view.panel.remove(); view.toggle.remove(); }
        opened = false;
      }
    };
  }

  return { create, readAudioMetadata };
});
