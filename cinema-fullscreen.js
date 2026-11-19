(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AlleyCinemaFullscreen = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict';
  function create({ window = root, document = window.document, player, status }) {
    let active = false, destroyed = false, timer = null, keyboard = false, pressing = false;
    let ownedLock = false, locking = false, epoch = 0;
    const orientation = window.screen?.orientation;
    const listeners = [];
    const portrait = () => window.innerHeight > window.innerWidth;
    const mobile = () => window.matchMedia?.('(pointer: coarse)').matches || window.innerWidth <= 1000;
    function listen(target, event, callback) {
      if (!target?.addEventListener) return;
      target.addEventListener(event, callback);
      listeners.push(() => target.removeEventListener(event, callback));
    }
    function cancelTimer() { if (timer !== null) window.clearTimeout(timer); timer = null; }
    function reveal() {
      if (!active || destroyed) return;
      cancelTimer(); player.setAttribute('data-cinema-controls', 'visible');
      timer = window.setTimeout(() => {
        timer = null;
        const editor = player.querySelector?.('#director-panel');
        if (keyboard || pressing || editor?.hidden === false) { reveal(); return; }
        player.setAttribute('data-cinema-controls', 'hidden');
      }, 3000);
    }
    function hint() {
      if (active && mobile() && portrait() && status) status.textContent = 'Поверните телефон горизонтально';
      else if (status?.textContent === 'Поверните телефон горизонтально') status.textContent = '';
    }
    function unlock() {
      if (!ownedLock) return;
      ownedLock = false;
      try { orientation?.unlock?.(); } catch (_) { /* Browser may already have released it on exit. */ }
    }
    async function lock() {
      if (locking || ownedLock || !active || destroyed || !mobile()) return;
      if (document.fullscreenElement !== player || !orientation?.lock) { hint(); return; }
      const version = epoch;
      locking = true;
      try {
        await orientation.lock('landscape');
        ownedLock = true;
        if (destroyed || !active || epoch !== version) unlock();
      } catch (_) { /* Rotation restrictions must never affect playback. */ }
      finally {
        locking = false;
        if (!destroyed && active) {
          hint();
          if (epoch !== version) void lock();
        }
      }
    }
    function update(value) {
      if (destroyed) return;
      if (value !== active) {
        active = value; epoch += 1;
        if (active) { keyboard = false; reveal(); void lock(); hint(); }
        else { cancelTimer(); unlock(); player.removeAttribute('data-cinema-controls'); hint(); }
      } else if (active) hint();
    }
    listen(player, 'pointerdown', () => { keyboard = false; pressing = true; reveal(); });
    listen(window, 'pointerup', () => { pressing = false; reveal(); });
    listen(window, 'pointercancel', () => { pressing = false; reveal(); });
    listen(player, 'pointermove', event => { if (event.pointerType === 'mouse') reveal(); });
    listen(document, 'keydown', () => { keyboard = true; reveal(); });
    listen(player, 'focusin', reveal);
    listen(window, 'resize', () => { hint(); reveal(); });
    listen(orientation, 'change', () => { hint(); reveal(); });
    return { update, reveal, destroy() {
      if (destroyed) return;
      update(false); destroyed = true; epoch += 1;
      cancelTimer(); unlock(); listeners.forEach(remove => remove());
    } };
  }
  return { create };
});
