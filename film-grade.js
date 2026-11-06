(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (typeof define === 'function' && define.amd) define([], () => api);
  else root.AlleyFilmGrade = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict';

  const SVG = 'http://www.w3.org/2000/svg';
  const DEFAULTS = Object.freeze({ look: 'cinema', brightness: 100, contrast: 100, saturation: 100 });
  const LIMITS = { brightness: [70, 130], contrast: [70, 130], saturation: [0, 150] };
  const instances = new WeakMap();

  // Пять утверждённых исходников уже сведены автором в сепию.
  // Нейтральные кривые сохраняют их цвет, свет, контраст и готовое зерно.
  // Индивидуальные профили привязаны к файлам: при новой замене проверяем их заново.
  const identity = [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1];
  const authored = filename => ({ filename, saturation: 1, R: [...identity], G: [...identity], B: [...identity], grain: 0 });
  const profiles = {
    alley: authored('Дождливый переулок у бара «Переулок».png'),
    panorama: authored('Сепийный джаз-бар «Переулок».png'),
    hero: authored('Сепия-нуар в баре с джазом.png'),
    dasha: authored('Газетчица у старого бара.png'),
    revelation: authored('Газетный заголовок в переулке.png')
  };
  Object.values(profiles).forEach(profile => {
    ['R', 'G', 'B'].forEach(channel => Object.freeze(profile[channel]));
    Object.freeze(profile);
  });
  Object.freeze(profiles);

  function validProfile(profile) {
    return profile && (profile.grain == null || (Number.isFinite(profile.grain) && profile.grain >= 0 && profile.grain <= 0.05))
      && Number.isFinite(profile.saturation) && profile.saturation >= 0
      && ['R', 'G', 'B'].every(channel => Array.isArray(profile[channel]) && profile[channel].length === 9
        && profile[channel].every(value => Number.isFinite(value) && value >= 0 && value <= 1));
  }

  function svgElement(document, name, attributes, parent) {
    const node = document.createElementNS(SVG, name);
    Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, String(value)));
    if (parent) parent.appendChild(node);
    return node;
  }

  function makeFilter(document, defs, id, profile) {
    const filter = svgElement(document, 'filter', {
      id, x: '0%', y: '0%', width: '100%', height: '100%', 'color-interpolation-filters': 'sRGB'
    }, defs);
    svgElement(document, 'feColorMatrix', {
      in: 'SourceGraphic', type: 'saturate', values: profile.saturation, result: 'saturated'
    }, filter);
    const curves = svgElement(document, 'feComponentTransfer', { in: 'saturated', result: 'graded' }, filter);
    ['R', 'G', 'B'].forEach(channel => {
      svgElement(document, 'feFunc' + channel, { type: 'table', tableValues: profile[channel].join(' ') }, curves);
    });
    // Авторское зерно уже есть на фото. Дополнительный шум по умолчанию отключён.
    if (!(profile.grain > 0)) return;
    // При явном включении зерна в конце вернём исходную альфу.
    svgElement(document, 'feFuncA', { type: 'linear', slope: 0, intercept: 1 }, curves);
    svgElement(document, 'feTurbulence', {
      type: 'fractalNoise', baseFrequency: 0.75, numOctaves: 3, seed: 7, stitchTiles: 'stitch', result: 'noise'
    }, filter);
    svgElement(document, 'feColorMatrix', { in: 'noise', type: 'saturate', values: 0, result: 'monochrome' }, filter);
    const grain = svgElement(document, 'feComponentTransfer', { in: 'monochrome', result: 'grain' }, filter);
    svgElement(document, 'feFuncA', { type: 'linear', slope: 0, intercept: profile.grain }, grain);
    svgElement(document, 'feBlend', { in: 'grain', in2: 'graded', mode: 'soft-light', result: 'textured' }, filter);
    svgElement(document, 'feComposite', { in: 'textured', in2: 'SourceGraphic', operator: 'in' }, filter);
  }

  function sliderValue(value, previous, bounds) {
    // Range inputs return strings. Empty strings, booleans, null and objects are not slider values.
    if (typeof value !== 'number' && (typeof value !== 'string' || value.trim() === '')) return previous;
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(bounds[0], Math.min(bounds[1], number)) : previous;
  }

  function create(options = {}) {
    const document = options.document || root.document;
    if (!document || typeof document.createElementNS !== 'function' || typeof document.querySelectorAll !== 'function') {
      throw new TypeError('AlleyFilmGrade.create requires a document');
    }
    // One controller owns the stable IDs in this document, even if initialization runs twice.
    if (instances.has(document)) return instances.get(document);
    const mount = options.mount || document.body;
    if (!mount || typeof mount.appendChild !== 'function') throw new TypeError('AlleyFilmGrade requires a body or mount');
    const configured = options.profiles || profiles;
    const ids = new Map();
    const svg = svgElement(document, 'svg', {
      'data-film-grade-defs': '', width: 0, height: 0, 'aria-hidden': 'true', focusable: 'false'
    });
    svg.style.position = 'absolute';
    svg.style.pointerEvents = 'none';
    const defs = svgElement(document, 'defs', {}, svg);
    Object.entries(configured).forEach(([sceneId, profile]) => {
      // Scene IDs become local fragment URLs; invalid names/profiles simply have no grade.
      if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(sceneId) || !validProfile(profile)) return;
      const id = 'film-grade-' + sceneId;
      ids.set(sceneId, id);
      makeFilter(document, defs, id, profile);
    });
    mount.appendChild(svg);
    let settings = { ...DEFAULTS };

    function filterFor(sceneId) {
      if (settings.look === 'original' || !ids.has(sceneId)) return 'none';
      return `url(#${ids.get(sceneId)}) brightness(${settings.brightness}%) contrast(${settings.contrast}%) saturate(${settings.saturation}%)`;
    }

    function apply(image, sceneId) {
      if (!image || !image.style) return 'none';
      const id = sceneId == null ? '' : String(sceneId);
      if (image.dataset) image.dataset.gradeScene = id;
      else image.setAttribute('data-grade-scene', id);
      image.style.filter = filterFor(id);
      return image.style.filter;
    }

    function refresh() {
      document.querySelectorAll('img[data-grade-scene]').forEach(image => {
        const id = image.dataset ? image.dataset.gradeScene : image.getAttribute('data-grade-scene');
        image.style.filter = filterFor(id);
      });
    }

    function getSettings() { return { ...settings }; }

    function set(values = {}) {
      if (values && typeof values === 'object' && !Array.isArray(values)) {
        if (values.look === 'cinema' || values.look === 'original') settings.look = values.look;
        Object.entries(LIMITS).forEach(([name, bounds]) => {
          settings[name] = sliderValue(values[name], settings[name], bounds);
        });
      }
      refresh();
      return getSettings();
    }

    function reset() {
      settings = { ...DEFAULTS };
      refresh();
      return getSettings();
    }

    const controller = { apply, set, getSettings, reset };
    instances.set(document, controller);
    return controller;
  }

  return { profiles, create };
});
