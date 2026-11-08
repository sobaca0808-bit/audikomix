(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AlleyViewerControls = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict';

  const instances = new WeakMap();
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  // These controls never call play, pause, prepare, or change a scene's clock.
  function create(options = {}) {
    const document = options.document || root.document;
    const audio = options.audio;
    const onMasterChange = typeof options.onMasterChange === 'function' ? options.onMasterChange : null;
    if (!document || typeof document.getElementById !== 'function' || !audio
      || typeof audio.getMasterState !== 'function' || typeof audio.setMasterVolume !== 'function'
      || typeof audio.toggleMuted !== 'function') throw new TypeError('AlleyViewerControls requires a document and audio controller');
    if (instances.has(document)) return instances.get(document);

    const element = id => document.getElementById(id);
    const player = element('cinema-player');
    const mute = element('mute');
    const volume = element('master-volume');
    const volumeValue = element('master-volume-value');
    const icon = element('volume-icon');
    const subtitle = element('subtitle-size');
    const subtitleValue = element('subtitle-size-value');
    const fullscreen = element('fullscreen');
    const fullscreenLabel = element('fullscreen-label');
    const status = element('viewer-status');
    if (!player || !mute || !volume || !subtitle || !fullscreen) throw new TypeError('Viewer controls markup is incomplete');

    let subtitleSize = 100;
    let fallback = false;
    let pending = null;
    let serial = 0;
    let destroyed = false;
    let wanted = document.fullscreenElement === player;
    let cancelledEntry = false;
    let lastNative = wanted;
    let lateExitPending = false;
    let unsettledEntries = 0;
    let previousFocus = null;
    const listeners = [];

    function listen(target, name, handler) {
      target.addEventListener(name, handler);
      listeners.push(() => target.removeEventListener(name, handler));
    }

    function announce(message) { if (status) status.textContent = message; }
    function nativeActive() { return document.fullscreenElement === player; }

    function setFallback(value) {
      fallback = value;
      player.classList.toggle('is-expanded', value);
      document.body.classList.toggle('viewer-expanded', value);
    }

    function restoreFocus() {
      if (previousFocus && previousFocus.isConnected !== false && typeof previousFocus.focus === 'function') previousFocus.focus();
      previousFocus = null;
    }

    function syncVolume() {
      const state = audio.getMasterState();
      const effective = Number(state.effectiveVolume);
      const percent = Math.round(clamp(Number.isFinite(effective) ? effective : 1, 0, 1) * 100);
      const silent = percent === 0;
      volume.value = String(percent);
      volume.setAttribute('aria-valuetext', percent + '%');
      if (volumeValue) volumeValue.textContent = percent + '%';
      mute.setAttribute('aria-pressed', String(silent));
      mute.setAttribute('data-muted', String(silent));
      const label = silent ? 'Включить звук' : 'Отключить звук';
      mute.setAttribute('aria-label', label);
      mute.setAttribute('title', label);
      // Keep the authored SVG; CSS chooses its muted/unmuted strokes.
      if (icon) icon.setAttribute('data-muted', String(silent));
    }

    function changeMaster(change) {
      const previous = { ...audio.getMasterState() };
      change();
      syncVolume();
      if (onMasterChange) {
        try {
          const result = onMasterChange({ ...audio.getMasterState() }, previous);
          if (result && typeof result.catch === 'function') result.catch(() => {});
        } catch (_) { /* Volume controls remain usable if an optional observer fails. */ }
      }
    }

    function syncSubtitle() {
      subtitle.value = String(subtitleSize);
      subtitle.setAttribute('aria-valuetext', subtitleSize + '%');
      if (subtitleValue) subtitleValue.textContent = subtitleSize + '%';
      player.style.setProperty('--subtitle-scale', String(subtitleSize / 100));
    }

    function syncFullscreen() {
      const native = nativeActive();
      const active = native || fallback;
      const label = native ? 'Выйти из полного экрана' : fallback ? 'Свернуть плеер' : 'На весь экран';
      const caption = native ? 'Выйти' : fallback ? 'Свернуть' : 'Полный экран';
      fullscreen.disabled = Boolean(pending);
      fullscreen.setAttribute('aria-pressed', String(active));
      fullscreen.setAttribute('aria-label', label);
      fullscreen.setAttribute('title', label);
      if (fullscreenLabel) fullscreenLabel.textContent = caption;
    }

    function sync() {
      if (destroyed) return;
      syncVolume();
      syncSubtitle();
      syncFullscreen();
    }

    function enterFallback(message) {
      setFallback(true);
      announce(message || 'Плеер развёрнут в окне браузера. Нажмите Esc, чтобы вернуться.');
      syncFullscreen();
    }

    // A native request may finish after Escape. Respect the latest user intent.
    function exitCancelledNative() {
      if (!cancelledEntry || wanted || !nativeActive() || lateExitPending || typeof document.exitFullscreen !== 'function') return;
      lateExitPending = true;
      try {
        Promise.resolve(document.exitFullscreen()).catch(() => {
          if (!destroyed) announce('Нажмите Esc, чтобы выйти из полного экрана.');
        }).finally(() => {
          lateExitPending = false;
          if (!destroyed) syncFullscreen();
        });
      } catch (_) { lateExitPending = false; }
    }

    async function toggleFullscreen() {
      if (destroyed || pending) return;
      if (fallback) {
        wanted = false;
        cancelledEntry = unsettledEntries > 0;
        serial += 1;
        setFallback(false);
        announce('');
        restoreFocus();
        syncFullscreen();
        exitCancelledNative();
        return;
      }
      const entering = !nativeActive();
      wanted = entering;
      cancelledEntry = !entering && unsettledEntries > 0;
      if (entering) previousFocus = document.activeElement;
      if (entering && (document.fullscreenEnabled === false || typeof player.requestFullscreen !== 'function'
        || typeof document.exitFullscreen !== 'function')) {
        enterFallback();
        return;
      }
      const version = ++serial;
      pending = entering ? 'enter' : 'exit';
      if (entering) unsettledEntries += 1;
      syncFullscreen();
      try {
        await (entering ? player.requestFullscreen() : document.exitFullscreen());
        if (version !== serial || destroyed) { exitCancelledNative(); return; }
        if (entering && wanted && !nativeActive()) enterFallback();
        else if (!entering) { announce(''); restoreFocus(); }
      } catch (_) {
        if (version !== serial || destroyed) return;
        if (entering && wanted) enterFallback('Полный экран недоступен. Плеер развёрнут в окне браузера; выход — Esc.');
        else announce('Не удалось выйти из полного экрана. Нажмите Esc.');
      } finally {
        if (entering) {
          unsettledEntries -= 1;
          if (!unsettledEntries && !wanted && !nativeActive()) cancelledEntry = false;
        }
        if (version === serial && !destroyed) { pending = null; syncFullscreen(); }
      }
    }

    function fullscreenChanged() {
      const native = nativeActive();
      const wasNative = lastNative;
      lastNative = native;
      if (native) {
        if (cancelledEntry && !wanted) exitCancelledNative();
        else { wanted = true; setFallback(false); announce(''); }
      } else if (wasNative) {
        wanted = false;
        cancelledEntry = unsettledEntries > 0;
        serial += 1;
        pending = null;
        restoreFocus();
      }
      syncFullscreen();
    }

    function fullscreenFailed() {
      if (pending === 'enter' && wanted && !nativeActive()) {
        serial += 1;
        pending = null;
        enterFallback('Полный экран недоступен. Плеер развёрнут в окне браузера; выход — Esc.');
      } else if (pending === 'exit') announce('Нажмите Esc, чтобы выйти из полного экрана.');
    }

    function keydown(event) {
      if (event.key === 'Escape' && (fallback || pending === 'enter')) {
        event.preventDefault();
        wanted = false;
        cancelledEntry = unsettledEntries > 0;
        serial += 1;
        pending = null;
        setFallback(false);
        announce('');
        restoreFocus();
        syncFullscreen();
        exitCancelledNative();
      }
      if (event.key !== 'Tab' || !fallback || typeof player.querySelectorAll !== 'function') return;
      const controls = [...player.querySelectorAll('a[href], button, input, select, textarea, summary, [tabindex]:not([tabindex="-1"])')]
        .filter(control => !control.disabled && !control.hidden && control.getAttribute('tabindex') !== '-1'
          && (typeof control.getClientRects !== 'function' || control.getClientRects().length > 0));
      if (!controls.length) return;
      const first = controls[0], last = controls[controls.length - 1];
      const outside = !player.contains(document.activeElement);
      if (outside || (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    }

    listen(mute, 'click', () => changeMaster(() => audio.toggleMuted()));
    listen(volume, 'input', () => {
      const value = Number(volume.value);
      if (volume.value.trim() !== '' && Number.isFinite(value)) changeMaster(() => audio.setMasterVolume(clamp(value, 0, 100) / 100));
      else syncVolume();
    });
    listen(subtitle, 'input', () => {
      const value = Number(subtitle.value);
      if (subtitle.value.trim() !== '' && Number.isFinite(value)) subtitleSize = clamp(Math.round(value / 5) * 5, 85, 140);
      syncSubtitle();
    });
    listen(fullscreen, 'click', toggleFullscreen);
    listen(document, 'fullscreenchange', fullscreenChanged);
    listen(document, 'fullscreenerror', fullscreenFailed);
    listen(document, 'keydown', keydown);

    const controller = {
      sync,
      destroy() {
        if (destroyed) return;
        destroyed = true;
        serial += 1;
        wanted = false;
        cancelledEntry = true;
        pending = null;
        listeners.forEach(remove => remove());
        setFallback(false);
        fullscreen.disabled = false;
        restoreFocus();
        exitCancelledNative();
        instances.delete(document);
      }
    };
    instances.set(document, controller);
    sync();
    return controller;
  }

  return { create };
});
