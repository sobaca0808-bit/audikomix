(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AlleyDirectorProject = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const LIMITS = Object.freeze({ jsonBytes: 1024 * 1024, phrases: 24, text: 4000,
    tracks: 8, mediaBytes: 32 * 1024 * 1024, totalMediaBytes: 150 * 1024 * 1024,
    durationMs: 600000, transitionMs: 2000 });
  const ID = /^[A-Za-z0-9_-]{1,96}$/;
  const AUDIO_NAME = /\.(?:mp3|wav|ogg|oga|m4a|aac|flac|webm|opus|mp4)$/i;
  const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);
  const KINDS = ['voice', 'music', 'ambience', 'effects'];
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  function fail(message) { throw new Error(message); }
  function bytes(text) {
    return typeof TextEncoder === 'function' ? new TextEncoder().encode(text).length
      : encodeURIComponent(text).replace(/%[A-F\d]{2}/gi, 'x').length;
  }
  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function checkTree(value, depth = 0) {
    if (depth > 12) fail('Проект имеет слишком глубокую структуру.');
    if (value === null || typeof value !== 'object') return;
    if (!Array.isArray(value) && Object.prototype.toString.call(value) !== '[object Object]') fail('Проект должен содержать только данные JSON.');
    for (const key of Object.keys(value)) {
      if (FORBIDDEN.has(key)) fail('В проекте найден недопустимый ключ.');
      checkTree(value[key], depth + 1);
    }
  }
  function record(value, allowed, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(label + ': ожидается объект.');
    for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(label + ': неизвестное поле «' + key + '».');
    return value;
  }
  function number(value, min, max, label, integer = false) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(label + ': допустимо от ' + min + ' до ' + max + '.');
    return integer ? Math.round(value) : value;
  }
  function text(value, max, label, empty = true) {
    if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) fail(label + ': недопустимый текст.');
    return value;
  }
  function id(value, label) {
    if (typeof value !== 'string' || !ID.test(value)) fail(label + ': недопустимый идентификатор.');
    return value;
  }
  function baselineScenes(baseline) {
    if (!baseline || !Array.isArray(baseline.scenes) || baseline.scenes.length !== 5) fail('Исходная история должна содержать пять сцен.');
    const ids = baseline.scenes.map(scene => id(scene.id, 'Исходная сцена'));
    if (new Set(ids).size !== 5) fail('Идентификаторы исходных сцен повторяются.');
    return baseline.scenes;
  }
  function metadata(raw) {
    record(raw, ['id', 'name', 'type', 'size', 'durationMs'], 'Аудиофайл');
    const result = { id: id(raw.id, 'Аудиофайл'), name: text(raw.name, 240, 'Имя аудиофайла', false),
      type: text(raw.type, 120, 'Тип аудиофайла'), size: number(raw.size, 1, LIMITS.mediaBytes, 'Размер аудиофайла', true),
      durationMs: number(raw.durationMs, 1, LIMITS.durationMs, 'Длительность аудиофайла', true) };
    if (/[\\/]/.test(result.name) || !AUDIO_NAME.test(result.name)) fail('Выберите аудиофайл с поддерживаемым расширением.');
    if (result.type && !/^(?:audio\/[A-Za-z\d.+-]+|application\/ogg|video\/(?:mp4|webm))$/i.test(result.type)) fail('Недопустимый тип аудиофайла.');
    return result;
  }

  function validate(input, baseline) {
    const source = baselineScenes(baseline);
    checkTree(input);
    let serialized;
    try { serialized = JSON.stringify(input); } catch (_) { fail('Не удалось прочитать проект JSON.'); }
    if (!serialized || bytes(serialized) > LIMITS.jsonBytes) fail('Проект JSON превышает 1 МБ.');
    record(input, ['format', 'version', 'title', 'scenes', 'media'], 'Проект');
    if (input.format !== 'alley-director' || input.version !== 1) fail('Формат или версия проекта не поддерживается.');
    if (!Array.isArray(input.scenes) || input.scenes.length !== source.length) fail('В проекте должны остаться все пять существующих сцен.');
    if (!Array.isArray(input.media) || input.media.length > source.length * LIMITS.tracks) fail('Слишком много аудиофайлов в проекте.');
    const media = input.media.map(metadata);
    const mediaMap = new Map(media.map(item => [item.id, item]));
    if (mediaMap.size !== media.length) fail('Идентификаторы аудиофайлов повторяются.');
    if (media.reduce((sum, item) => sum + item.size, 0) > LIMITS.totalMediaBytes) fail('Общий размер аудиофайлов превышает 150 МБ.');
    const allowedIds = new Set(source.map(scene => scene.id));
    const seen = new Set();
    const scenes = input.scenes.map(raw => {
      record(raw, ['id', 'durationMs', 'transitionMs', 'phrases', 'camera', 'effects', 'tracks'], 'Сцена');
      const sceneId = id(raw.id, 'Сцена');
      if (!allowedIds.has(sceneId) || seen.has(sceneId)) fail('Состав сцен изменён или одна сцена повторяется.');
      seen.add(sceneId);
      const durationMs = number(raw.durationMs, 1000, LIMITS.durationMs, 'Длительность сцены', true);
      if (!Array.isArray(raw.phrases) || raw.phrases.length > LIMITS.phrases) fail('В сцене допускается не более 24 реплик.');
      let previousEnd = 0;
      const phrases = raw.phrases.map(phrase => {
        record(phrase, ['text', 'speaker', 'startMs', 'typingMs', 'endMs'], 'Реплика');
        const result = { text: text(phrase.text, LIMITS.text, 'Реплика'), speaker: text(phrase.speaker, 80, 'Имя говорящего'),
          startMs: number(phrase.startMs, 0, durationMs, 'Начало реплики', true),
          typingMs: number(phrase.typingMs, 1, durationMs, 'Время печати', true),
          endMs: number(phrase.endMs, 1, durationMs, 'Конец реплики', true) };
        if (result.endMs <= result.startMs || result.typingMs > result.endMs - result.startMs) fail('Реплика должна успеть напечататься до конца показа.');
        if (result.startMs < previousEnd) fail('Реплики должны идти по порядку, без наложения.');
        previousEnd = result.endMs;
        return result;
      });
      record(raw.camera, ['start', 'end', 'focusX', 'focusY'], 'Камера');
      const camera = { start: number(raw.camera.start, 1, 1.04, 'Начальный масштаб'),
        end: number(raw.camera.end, 1, 1.04, 'Конечный масштаб'),
        focusX: number(raw.camera.focusX, 0, 100, 'Центр по горизонтали'),
        focusY: number(raw.camera.focusY, 0, 100, 'Центр по вертикали') };
      record(raw.effects, ['smoke', 'flicker'], 'Эффекты');
      const effects = { smoke: number(raw.effects.smoke, 0, 1, 'Дым'), flicker: number(raw.effects.flicker, 0, 1, 'Мерцание') };
      if (!Array.isArray(raw.tracks) || raw.tracks.length > LIMITS.tracks) fail('В сцене допускается не более восьми аудиодорожек.');
      const trackIds = new Set();
      const tracks = raw.tracks.map(track => {
        record(track, ['id', 'kind', 'assetId', 'startMs', 'volume', 'loop'], 'Аудиодорожка');
        const trackId = id(track.id, 'Аудиодорожка');
        if (trackIds.has(trackId)) fail('Идентификаторы дорожек в сцене повторяются.');
        trackIds.add(trackId);
        if (!KINDS.includes(track.kind)) fail('Неизвестный тип аудиодорожки.');
        const assetId = id(track.assetId, 'Аудиофайл дорожки');
        if (!mediaMap.has(assetId)) fail('Для дорожки отсутствует описание аудиофайла.');
        if (typeof track.loop !== 'boolean' || (track.kind === 'voice' && track.loop)) fail('Голос проигрывается один раз целиком, без повтора.');
        const result = { id: trackId, kind: track.kind, assetId,
          startMs: number(track.startMs, 0, durationMs, 'Начало дорожки', true),
          volume: number(track.volume, 0, 1, 'Громкость дорожки'), loop: track.loop };
        if (result.kind === 'voice' && result.startMs + mediaMap.get(assetId).durationMs + 1500 > LIMITS.durationMs) fail('Голос вместе с паузами превышает десять минут.');
        return result;
      });
      return { id: sceneId, durationMs, transitionMs: number(raw.transitionMs, 0, LIMITS.transitionMs, 'Переход', true), phrases, camera, effects, tracks };
    });
    return { format: 'alley-director', version: 1, title: text(input.title, 120, 'Название проекта', false), scenes, media };
  }

  function fromStory(baseline) {
    const scenes = baselineScenes(baseline).map(scene => {
      const raw = scene.phrases || (scene.text ? [{ text: scene.text, start: scene.textDelay || 0,
        typing: scene.textDuration || 1, end: scene.duration }] : []);
      const start = scene.zoom ? (scene.zoom.start ?? 1) : 1;
      const end = scene.zoom ? start + (scene.zoom.delta ?? 0.02) : 1;
      const match = /^(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%$/.exec(scene.focus || '50% 50%');
      return { id: scene.id, durationMs: scene.duration, transitionMs: scene.transitionMs ?? 200,
        phrases: raw.map(phrase => ({ text: phrase.text, speaker: phrase.speaker ?? scene.speaker ?? '',
          startMs: phrase.start, typingMs: phrase.typing, endMs: phrase.end })),
        camera: { start, end, focusX: match ? Number(match[1]) : 50, focusY: match ? Number(match[2]) : 50 },
        effects: { smoke: 0, flicker: 0 }, tracks: [] };
    });
    return validate({ format: 'alley-director', version: 1, title: 'Переулок', scenes, media: [] }, baseline);
  }

  function compile(input, baseline) {
    const project = validate(input, baseline);
    const originals = new Map(baseline.scenes.map(scene => [scene.id, scene]));
    const media = new Map(project.media.map(item => [item.id, item]));
    const scenes = project.scenes.map(settings => {
      const original = originals.get(settings.id);
      const scene = clone(original);
      scene.duration = settings.durationMs;
      scene.transitionMs = settings.transitionMs;
      scene.zoom = { start: settings.camera.start, delta: settings.camera.end - settings.camera.start };
      scene.focus = settings.camera.focusX + '% ' + settings.camera.focusY + '%';
      scene.directorEffects = { ...settings.effects };
      delete scene.text; delete scene.textDelay; delete scene.textDuration; delete scene.phrases;
      if (!settings.phrases.length) {
        scene.speaker = ''; scene.text = '';
      } else if (!original.phrases && settings.phrases.length === 1 && settings.phrases[0].endMs === settings.durationMs) {
        const phrase = settings.phrases[0];
        scene.speaker = phrase.speaker; scene.text = phrase.text;
        scene.textDelay = phrase.startMs; scene.textDuration = phrase.typingMs;
      } else {
        scene.speaker = settings.phrases[0].speaker;
        scene.phrases = settings.phrases.map(phrase => {
          const result = { text: phrase.text, start: phrase.startMs, typing: phrase.typingMs, end: phrase.endMs };
          if (phrase.speaker !== scene.speaker) result.speaker = phrase.speaker;
          return result;
        });
      }
      if (original.holdLastPhrase && settings.phrases.at(-1)?.endMs !== settings.durationMs) {
        scene.holdLastPhrase = false;
      }
      scene.audio = scene.audio || { voice: null, beds: [], effects: [] };
      if (settings.tracks.length) {
        scene.audio.tracks = settings.tracks.map(track => ({ id: track.id, src: 'director-media:' + track.assetId,
          kind: track.kind, start: track.startMs, gain: track.volume, loop: track.loop }));
        if (settings.tracks.some(track => track.kind === 'voice')) {
          scene.audio.voice = null;
          scene.duration = Math.max(scene.duration, ...settings.tracks.filter(track => track.kind === 'voice')
            .map(track => track.startMs + media.get(track.assetId).durationMs + 1500));
          // A final caption authored through the original scene end follows a
          // longer complete voice. An explicitly earlier hide time stays exact.
          const last = scene.phrases?.at(-1);
          if (original.holdLastPhrase && last?.end === settings.durationMs && scene.duration > settings.durationMs) {
            last.end = scene.duration;
          }
        }
      }
      return scene;
    });
    return { audio: clone(baseline.audio), scenes };
  }

  return { LIMITS, clone, fromStory, validate, compile, validateMedia: metadata };
});
