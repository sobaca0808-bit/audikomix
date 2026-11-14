const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateLayout, create } = require('../player-layout.js');

const near = (actual, expected, tolerance = .02) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} ≠ ${expected}`);

function harness({ width = 1366, height = 768, top = 120, chrome = 240 } = {}) {
  const callbacks = new Map(), resizeObservers = [], mutationObservers = [];
  let nextFrame = 0;
  function target() {
    const listeners = new Map();
    return {
      addEventListener(name, callback) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(callback); },
      removeEventListener(name, callback) { listeners.get(name)?.delete(callback); },
      dispatch(name) { for (const callback of listeners.get(name) || []) callback({ type: name }); },
      listenerCount() { return [...listeners.values()].reduce((sum, values) => sum + values.size, 0); }
    };
  }
  function element() {
    const attrs = new Map(), classes = new Set(), values = new Map();
    return {
      ...target(),
      classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) },
      style: { setProperty: (name, value) => values.set(name, String(value)), getPropertyValue: name => values.get(name) || '', removeProperty: name => values.delete(name) },
      setAttribute: (name, value) => attrs.set(name, String(value)), getAttribute: name => attrs.get(name) ?? null, removeAttribute: name => attrs.delete(name),
      getBoundingClientRect: () => ({ width: 0, height: 0, top: 0, bottom: 0 })
    };
  }
  const root = element(), main = element(), player = element(), visual = element(), deck = element(), toolbar = element(), caption = element(), header = element(), intro = element();
  const state = { width, top, chrome };
  const padding = 28;
  const available = () => state.width - 2 * padding;
  const cardWidth = () => Math.min(available(), parseFloat(player.style.getPropertyValue('--fit-card-width')) || available());
  const imageWidth = () => Math.min(cardWidth() - 2, parseFloat(player.style.getPropertyValue('--fit-image-width')) || cardWidth() - 2);
  player.parentElement = main;
  player.querySelector = selector => ({ '.visual': visual, '.control-deck': deck, '.toolbar': toolbar, '.caption': caption })[selector] || null;
  main.getBoundingClientRect = () => ({ width: state.width });
  player.getBoundingClientRect = () => ({ width: cardWidth(), top: state.top - window.scrollY });
  visual.getBoundingClientRect = () => ({ width: imageWidth(), height: imageWidth() * 9 / 16 });
  deck.getBoundingClientRect = () => ({ bottom: state.top - window.scrollY + state.chrome + imageWidth() * 9 / 16 });
  const document = { ...target(), documentElement: root, fullscreenElement: null,
    getElementById: id => id === 'cinema-player' ? player : null,
    querySelector: selector => ({ 'main > header': header, '.intro': intro })[selector] || null };
  class Observer {
    constructor(callback, list) { this.callback = callback; this.observed = []; this.disconnected = false; list.push(this); }
    observe(element, options) { this.observed.push({ element, options }); }
    disconnect() { this.disconnected = true; }
  }
  const window = { ...target(), document, innerHeight: height, scrollY: 0, visualViewport: { ...target(), height },
    requestAnimationFrame(callback) { callbacks.set(++nextFrame, callback); return nextFrame; },
    cancelAnimationFrame(id) { callbacks.delete(id); },
    getComputedStyle(element) { return element === main ? { paddingLeft: `${padding}px`, paddingRight: `${padding}px` } : { borderLeftWidth: '1px', borderRightWidth: '1px' }; },
    ResizeObserver: class extends Observer { constructor(callback) { super(callback, resizeObservers); } },
    MutationObserver: class extends Observer { constructor(callback) { super(callback, mutationObservers); } }
  };
  return {
    document, window, state, root, main, player, visual, deck, toolbar, caption, resizeObservers, mutationObservers,
    get queued() { return callbacks.size; },
    flush() { const work = [...callbacks.values()]; callbacks.clear(); work.forEach(callback => callback(0)); },
    options: { document, window }
  };
}

test('height budget includes the real page offset, controls and bottom gutter', () => {
  const result = calculateLayout({ availableWidth: 1310, viewportHeight: 768, top: 140, chromeHeight: 240, gap: 12, border: 2 });
  near(result.imageHeight, 376);
  near(result.imageWidth, 376 * 16 / 9);
  near(result.cardWidth, result.imageWidth + 2);
  assert.ok(140 + 240 + result.imageHeight + 12 <= 768.02);
});

test('width-limited phones keep their full available card width and a 16:9 image', () => {
  for (const availableWidth of [290, 330, 360, 400]) {
    const result = calculateLayout({ availableWidth, viewportHeight: 932, top: 130, chromeHeight: 280 });
    near(result.cardWidth, availableWidth);
    near(result.imageWidth, availableWidth - 2);
    near(result.imageHeight, (availableWidth - 2) * 9 / 16);
  }
});

test('short landscape preserves room for controls while centering a smaller photograph', () => {
  const result = calculateLayout({ availableWidth: 812, viewportHeight: 390, top: 46, chromeHeight: 220, gap: 8 });
  near(result.cardWidth, 580);
  near(result.imageHeight, 116);
  assert.ok(result.imageWidth < result.cardWidth - 2);
  assert.ok(result.imageWidth > 1);
});

test('a fresh width/height calculation grows again after a small viewport', () => {
  const small = calculateLayout({ availableWidth: 330, viewportHeight: 640, top: 150, chromeHeight: 280 });
  const large = calculateLayout({ availableWidth: 1864, viewportHeight: 1080, top: 140, chromeHeight: 240 });
  assert.ok(large.imageWidth > small.imageWidth);
  assert.ok(large.cardWidth > 1050, 'no former fixed page-width ceiling remains');
  assert.ok(large.cardWidth <= 1864);
});

test('missing, non-finite and impossible bounds never emit negative or NaN CSS sizes', () => {
  for (const input of [{}, { availableWidth: NaN, viewportHeight: Infinity }, { availableWidth: -10, viewportHeight: -1 }, { availableWidth: 320, viewportHeight: 100, top: 500, chromeHeight: 500 }, { availableWidth: 1, border: 50 }]) {
    const result = calculateLayout(input);
    for (const value of Object.values(result)) assert.ok(Number.isFinite(value) && value > 0);
  }
});

test('initial layout is fitted immediately and repeated creation owns one set of listeners', () => {
  const h = harness();
  const controller = create(h.options);
  assert.equal(create(h.options), controller);
  assert.equal(h.player.getAttribute('data-player-fit'), 'true');
  assert.equal(h.root.classList.contains('player-fit-ready'), true);
  assert.equal(h.resizeObservers.length, 1);
  assert.equal(h.mutationObservers.length, 2);
  assert.equal(h.window.listenerCount(), 2);
  assert.ok(h.deck.getBoundingClientRect().bottom <= h.window.innerHeight - 11.98);
});

test('resize bursts are coalesced and visualViewport height changes recalculate the same player', () => {
  const h = harness();
  create(h.options);
  const initialWidth = parseFloat(h.player.style.getPropertyValue('--fit-image-width'));
  h.window.visualViewport.height = 500;
  h.window.dispatch('resize'); h.window.dispatch('resize'); h.window.visualViewport.dispatch('resize');
  assert.equal(h.queued, 1);
  h.flush();
  assert.ok(parseFloat(h.player.style.getPropertyValue('--fit-image-width')) < initialWidth);
  assert.ok(h.deck.getBoundingClientRect().bottom <= 488.02);
  h.window.visualViewport.height = 1080; h.window.innerHeight = 1080; h.state.width = 1920;
  h.window.dispatch('resize'); h.flush();
  assert.ok(parseFloat(h.player.style.getPropertyValue('--fit-image-width')) > initialWidth);
});

test('late toolbar content refits height, while a main-height-only observation does not loop', () => {
  const h = harness();
  create(h.options);
  const initialHeight = h.visual.getBoundingClientRect().height;
  h.state.chrome += 44;
  h.mutationObservers[0].callback([{ target: h.toolbar }]); h.flush();
  near(h.visual.getBoundingClientRect().height, initialHeight - 44);
  const observer = h.resizeObservers[0];
  observer.callback([{ target: h.main, contentRect: { width: 1310, height: 900 } }]); h.flush();
  observer.callback([{ target: h.main, contentRect: { width: 1310, height: 1200 } }]);
  assert.equal(h.queued, 0);
});

test('fullscreen and expanded fallback keep their own sizes, then normal fitting resumes', () => {
  const h = harness(); create(h.options);
  const before = h.player.style.getPropertyValue('--fit-image-width');
  h.document.fullscreenElement = h.player; h.window.innerHeight = 500;
  h.document.dispatch('fullscreenchange'); h.flush();
  assert.equal(h.player.style.getPropertyValue('--fit-image-width'), before);
  h.document.fullscreenElement = null; h.player.classList.add('is-expanded');
  h.mutationObservers[1].callback([{ target: h.player }]); h.flush();
  assert.equal(h.player.style.getPropertyValue('--fit-image-width'), before);
  h.player.classList.remove('is-expanded'); h.document.dispatch('fullscreenchange'); h.flush();
  assert.notEqual(h.player.style.getPropertyValue('--fit-image-width'), before);
});

test('destroy releases only fitting state, listeners, observers and a pending animation frame', () => {
  const h = harness(); const controller = create(h.options);
  h.player.classList.add('existing-player-class'); controller.refresh();
  assert.equal(h.queued, 1);
  controller.destroy(); controller.destroy();
  assert.equal(h.queued, 0);
  assert.equal(h.player.getAttribute('data-player-fit'), null);
  assert.equal(h.player.style.getPropertyValue('--fit-image-width'), '');
  assert.equal(h.root.classList.contains('player-fit-ready'), false);
  assert.equal(h.player.classList.contains('existing-player-class'), true);
  assert.equal(h.window.listenerCount(), 0);
  assert.ok([...h.resizeObservers, ...h.mutationObservers].every(observer => observer.disconnected));
  assert.notEqual(create(h.options), controller);
});
