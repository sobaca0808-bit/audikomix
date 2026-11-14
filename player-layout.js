(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AlleyPlayerLayout = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict';
  const instances = new WeakMap();
  const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const round = value => Math.round(value * 100) / 100;

  // Only the photograph uses the height left after the real, measured player chrome.
  // A wider minimum card keeps its controls usable in a short landscape window.
  function calculateLayout({ availableWidth, viewportHeight, top = 0, chromeHeight = 0, gap = 12, border = 2, minimumCardWidth = 580 } = {}) {
    const available = Math.max(1, finite(availableWidth, 1));
    const frameBorder = Math.max(0, Math.min(available - 1, finite(border, 2)));
    const remainingHeight = Math.max(1, finite(viewportHeight, 1) - Math.max(0, finite(top)) - Math.max(0, finite(chromeHeight)) - Math.max(0, finite(gap, 12)));
    const imageWidth = Math.max(1, Math.min(available - frameBorder, remainingHeight * 16 / 9));
    const cardWidth = Math.min(available, Math.max(Math.min(available, Math.max(1, finite(minimumCardWidth, 580))), imageWidth + frameBorder));
    return { cardWidth: round(cardWidth), imageWidth: round(imageWidth), imageHeight: round(imageWidth * 9 / 16) };
  }

  function create(options = {}) {
    const window = options.window || root;
    const document = options.document || window.document;
    const player = document?.getElementById('cinema-player');
    const main = player?.parentElement;
    const visual = player?.querySelector('.visual');
    const deck = player?.querySelector('.control-deck');
    if (!player || !main || !visual || !deck) throw new TypeError('Player layout requires the existing player and controls.');
    if (instances.has(player)) return instances.get(player);
    let pending = null;
    let destroyed = false;
    let parentWidth = null;
    const listeners = [];
    const frame = window.requestAnimationFrame.bind(window);
    const cancelFrame = window.cancelAnimationFrame.bind(window);
    const rootElement = document.documentElement;
    rootElement.classList.add('player-fit-ready');
    player.setAttribute('data-player-fit', 'true');

    function expanded() { return document.fullscreenElement === player || player.classList.contains('is-expanded'); }
    function style(element) { return window.getComputedStyle(element); }
    function write(name, value) {
      const text = value + 'px';
      if (player.style.getPropertyValue(name) !== text) player.style.setProperty(name, text);
    }
    function narrow(width) {
      const next = width < 440 ? 'true' : 'false';
      if (player.getAttribute('data-fit-narrow') !== next) player.setAttribute('data-fit-narrow', next);
    }
    function viewportHeight() {
      const height = Math.max(1, finite(window.innerHeight, 1));
      const visible = finite(window.visualViewport?.height, height);
      return Math.max(1, Math.min(height, visible));
    }
    function measure() {
      const box = main.getBoundingClientRect();
      const mainStyle = style(main);
      const playerStyle = style(player);
      const availableWidth = Math.max(1, box.width - finite(parseFloat(mainStyle.paddingLeft)) - finite(parseFloat(mainStyle.paddingRight)));
      const playerBox = player.getBoundingClientRect();
      return {
        availableWidth,
        viewportHeight: viewportHeight(),
        top: playerBox.top + finite(window.scrollY),
        chromeHeight: deck.getBoundingClientRect().bottom - playerBox.top - visual.getBoundingClientRect().height,
        border: finite(parseFloat(playerStyle.borderLeftWidth)) + finite(parseFloat(playerStyle.borderRightWidth)),
        gap: window.innerHeight <= 520 ? 8 : 12
      };
    }
    function update() {
      pending = null;
      if (destroyed || expanded()) return;
      // Start from available width so enlarging the browser can grow the card again.
      let metrics = measure();
      write('--fit-card-width', round(metrics.availableWidth));
      write('--fit-image-width', round(Math.max(1, metrics.availableWidth - metrics.border)));
      narrow(metrics.availableWidth);
      for (let pass = 0; pass < 4; pass += 1) {
        metrics = measure();
        const result = calculateLayout(metrics);
        const before = player.style.getPropertyValue('--fit-card-width') + '|' + player.style.getPropertyValue('--fit-image-width');
        write('--fit-card-width', result.cardWidth);
        write('--fit-image-width', result.imageWidth);
        narrow(result.cardWidth);
        const after = player.style.getPropertyValue('--fit-card-width') + '|' + player.style.getPropertyValue('--fit-image-width');
        if (before === after) break;
      }
    }
    function refresh() {
      if (destroyed || pending !== null) return;
      pending = frame(update);
    }
    function listen(target, name, handler) {
      if (!target?.addEventListener) return;
      target.addEventListener(name, handler);
      listeners.push(() => target.removeEventListener(name, handler));
    }
    listen(window, 'resize', refresh);
    listen(window.visualViewport, 'resize', refresh);
    listen(document, 'fullscreenchange', refresh);
    listen(window, 'pageshow', refresh);

    let resizeObserver = null;
    if (typeof window.ResizeObserver === 'function') {
      resizeObserver = new window.ResizeObserver(entries => {
        let changed = false;
        for (const entry of entries) {
          if (entry.target === main) {
            const width = round(entry.contentRect.width);
            if (parentWidth !== width) { parentWidth = width; changed = true; }
          } else changed = true;
        }
        if (changed) refresh();
      });
      for (const element of [main, document.querySelector('main > header'), document.querySelector('.intro'), player.querySelector('.toolbar'), player.querySelector('.caption'), deck]) {
        if (element) resizeObserver.observe(element);
      }
    }
    let toolbarObserver = null;
    let stateObserver = null;
    if (typeof window.MutationObserver === 'function') {
      toolbarObserver = new window.MutationObserver(refresh);
      const toolbar = player.querySelector('.toolbar');
      if (toolbar) toolbarObserver.observe(toolbar, { childList: true });
      // Observe only fullscreen's own class, never the per-letter subtitle subtree.
      stateObserver = new window.MutationObserver(refresh);
      stateObserver.observe(player, { attributes: true, attributeFilter: ['class'] });
    }
    if (document.fonts?.ready) Promise.resolve(document.fonts.ready).then(refresh).catch(() => {});
    update();
    const controller = {
      refresh,
      destroy() {
        if (destroyed) return;
        destroyed = true;
        if (pending !== null) cancelFrame(pending);
        pending = null;
        listeners.forEach(remove => remove());
        resizeObserver?.disconnect(); toolbarObserver?.disconnect(); stateObserver?.disconnect();
        player.removeAttribute('data-player-fit'); player.removeAttribute('data-fit-narrow');
        player.style.removeProperty('--fit-card-width'); player.style.removeProperty('--fit-image-width');
        rootElement.classList.remove('player-fit-ready');
        instances.delete(player);
      }
    };
    instances.set(player, controller);
    return controller;
  }
  return { calculateLayout, create };
});
