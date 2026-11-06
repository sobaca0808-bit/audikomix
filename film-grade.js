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

  // Девять опорных значений RGB в sRGB: тени, полутона и света меняются отдельно.
  const profiles = {
    // Ночь: сдерживаем насыщенность, сохраняем холодные тени и темноту переулка.
    alley: {
      filename: 'Ночной переулок у бара «Переулок».png', saturation: 0.88,
      R: [0.008, 0.116, 0.247, 0.378, 0.507, 0.633, 0.758, 0.878, 0.976],
      G: [0.009, 0.113, 0.240, 0.369, 0.498, 0.624, 0.748, 0.869, 0.967],
      B: [0.011, 0.112, 0.233, 0.358, 0.484, 0.609, 0.731, 0.849, 0.947]
    },
    // Общий план: ослабляем оранжевый оттенок и насыщенность, удерживаем свет ламп.
    panorama: {
      filename: 'Винтажный джаз-бар «Переулок» (2).png', saturation: 0.79,
      R: [0.012, 0.137, 0.260, 0.382, 0.504, 0.625, 0.746, 0.860, 0.962],
      G: [0.012, 0.136, 0.261, 0.387, 0.512, 0.636, 0.757, 0.870, 0.972],
      B: [0.014, 0.138, 0.265, 0.392, 0.519, 0.644, 0.767, 0.880, 0.981]
    },
    // Тёплый портрет: сдерживаем красно-жёлтые полутона кожи и сохраняем мягкие света.
    hero: {
      filename: 'a_cinematic_warm_toned_vintage_bar_room_portrait.png', saturation: 0.78,
      R: [0.014, 0.140, 0.263, 0.385, 0.506, 0.626, 0.744, 0.856, 0.961],
      G: [0.014, 0.140, 0.266, 0.391, 0.516, 0.640, 0.761, 0.877, 0.979],
      B: [0.016, 0.144, 0.272, 0.399, 0.526, 0.651, 0.775, 0.891, 0.989]
    },
    // Даша: более лёгкая коррекция сохраняет читаемость газеты и тепло входа в бар.
    dasha: {
      filename: 'Газетчица у старого бара.png', saturation: 0.90,
      R: [0.010, 0.124, 0.254, 0.385, 0.516, 0.644, 0.768, 0.880, 0.976],
      G: [0.011, 0.123, 0.251, 0.380, 0.508, 0.634, 0.757, 0.869, 0.965],
      B: [0.013, 0.125, 0.253, 0.382, 0.510, 0.635, 0.756, 0.868, 0.963]
    }
  };
  Object.values(profiles).forEach(profile => {
    ['R', 'G', 'B'].forEach(channel => Object.freeze(profile[channel]));
    Object.freeze(profile);
  });
  Object.freeze(profiles);

  function validProfile(profile) {
    return profile && Number.isFinite(profile.saturation) && profile.saturation >= 0
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
    // В конце вернём исходную альфу: полупрозрачные края не умножаются на неё дважды.
    svgElement(document, 'feFuncA', { type: 'linear', slope: 0, intercept: 1 }, curves);
    svgElement(document, 'feTurbulence', {
      type: 'fractalNoise', baseFrequency: 0.75, numOctaves: 3, seed: 7, stitchTiles: 'stitch', result: 'noise'
    }, filter);
    svgElement(document, 'feColorMatrix', { in: 'noise', type: 'saturate', values: 0, result: 'monochrome' }, filter);
    const grain = svgElement(document, 'feComponentTransfer', { in: 'monochrome', result: 'grain' }, filter);
    svgElement(document, 'feFuncA', { type: 'linear', slope: 0, intercept: 0.025 }, grain);
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
