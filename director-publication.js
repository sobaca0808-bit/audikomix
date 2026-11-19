(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AlleyDirectorPublication = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  function compile(input, baseline, model) {
    const wrapped = Object.hasOwn(input || {}, 'project');
    const project = model.validate(wrapped ? input.project : input, baseline);
    if (wrapped && Object.keys(input).some(key => !['project', 'files'].includes(key))) {
      throw new Error('Неизвестное поле публикации.');
    }
    const files = wrapped ? input.files : {};
    if (!files || typeof files !== 'object' || Array.isArray(files)) throw new Error('Некорректная карта аудиофайлов.');
    const ids = new Set(project.media.map(item => item.id));
    for (const [id, src] of Object.entries(files)) {
      if (!ids.has(id) || typeof src !== 'string' ||
          !/^assets\/audio\/(?:[\p{L}\p{N}_-]+\/)*[\p{L}\p{N}_ .-]+\.(ogg|wav|mp3|m4a|aac|flac|opus|webm)$/iu.test(src)) {
        throw new Error('Для публикации нужны относительные пути внутри assets/audio/.');
      }
    }
    const story = model.compile(project, baseline);
    for (const scene of story.scenes) {
      for (const track of scene.audio?.tracks || []) {
        if (!track.src.startsWith('director-media:')) continue;
        const id = track.src.slice('director-media:'.length);
        if (!Object.hasOwn(files, id)) throw new Error('Для дорожки отсутствует путь к опубликованному аудио.');
        track.src = files[id];
      }
    }
    return story;
  }

  async function load({ fetch, baseline, model }) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    try {
      const response = await fetch('./director-settings.json', {
        mode: 'same-origin', credentials: 'same-origin', redirect: 'error',
        cache: 'no-cache', signal: controller.signal
      });
      if (!response.ok) return null;
      const text = await response.text();
      if (new TextEncoder().encode(text).byteLength > model.LIMITS.jsonBytes) return null;
      return compile(JSON.parse(text), baseline, model);
    } catch (_) {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  return { compile, load };
});
