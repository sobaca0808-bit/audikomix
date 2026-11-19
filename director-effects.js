(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AlleyDirectorEffects = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const instances = new WeakMap();
  const intensity = value => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
  const rounded = value => Math.round(value * 1000000) / 1000000;

  // One deterministic clock: the player supplies elapsed time. There are no timers
  // or independent CSS animations, so pausing the film also freezes the effects.
  function sample(frame, elapsed, options = {}) {
    const effects = frame && frame.directorEffects || {};
    const smoke = intensity(effects.smoke);
    const flicker = intensity(effects.flicker);
    const stationary = Boolean(options.reading || options.reducedMotion);
    const seconds = stationary || !Number.isFinite(elapsed) ? 0 : Math.max(0, elapsed) / 1000;
    const x = stationary ? 0 : Math.sin(seconds * 0.16) * 3;
    const y = stationary ? 0 : Math.sin(seconds * 0.11) * 1.2;
    // Slow dimming only, at most 5%; no rapid flashing or extra colour grading.
    const light = stationary ? 0.5 : 0.5 + 0.35 * Math.sin(seconds * 0.8) + 0.15 * Math.sin(seconds * 0.23);
    return {
      smokeOpacity: rounded(smoke * 0.15),
      lightOpacity: rounded(flicker * 0.05 * light),
      smokeTransform: `translate3d(${rounded(x)}%, ${rounded(y)}%, 0) scale(1.08)`
    };
  }

  function create(options = {}) {
    const document = options.document;
    if (!document || typeof document.createElement !== 'function' || typeof document.querySelector !== 'function') {
      throw new TypeError('AlleyDirectorEffects requires a document');
    }
    const visual = options.visual || document.querySelector('.visual');
    if (!visual || typeof visual.appendChild !== 'function') throw new TypeError('The film image area is missing');
    if (instances.has(visual)) return instances.get(visual);

    const layer = document.createElement('div');
    layer.className = 'director-atmosphere';
    layer.setAttribute('aria-hidden', 'true');
    layer.hidden = true;
    const smoke = document.createElement('div');
    smoke.className = 'director-smoke';
    const light = document.createElement('div');
    light.className = 'director-light';
    layer.appendChild(smoke);
    layer.appendChild(light);
    visual.appendChild(layer);
    let destroyed = false;

    const controller = {
      render(frame, elapsed, settings) {
        if (destroyed) return;
        const state = sample(frame, elapsed, settings);
        layer.hidden = state.smokeOpacity === 0 && state.lightOpacity === 0;
        smoke.hidden = state.smokeOpacity === 0;
        smoke.style.opacity = String(state.smokeOpacity);
        smoke.style.transform = state.smokeTransform;
        light.hidden = state.lightOpacity === 0;
        light.style.opacity = String(state.lightOpacity);
        return state;
      },
      destroy() {
        if (destroyed) return;
        destroyed = true;
        layer.remove();
        instances.delete(visual);
      }
    };
    instances.set(visual, controller);
    return controller;
  }

  return { create, sample };
});
