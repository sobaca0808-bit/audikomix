const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../player.js'), 'utf8');
const narration = 'Люблю тихие вечера. Особенно когда никто не пытается меня убить';

// Управляемые часы и DOM проверяют поведение плеера без браузерных зависимостей.
function player({ reducedMotion = false } = {}) {
  let now = 0;
  let nextId = 0;
  const pending = new Map();
  function makeElement() {
    const classes = new Set();
    return {
      textContent: '', style: {}, attributes: {}, handlers: {}, disabled: false,
      classList: {
        toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
        contains(name) { return classes.has(name); }
      },
      setAttribute(name, value) { this.attributes[name] = value; },
      getAttribute(name) { return this.attributes[name]; },
      set src(value) { this.attributes.src = value; },
      get src() { return this.attributes.src; },
      addEventListener(name, handler) { this.handlers[name] = handler; }
    };
  }
  const ids = Object.fromEntries(['frame', 'speaker', 'dialogue', 'accessible-dialogue', 'counter', 'back', 'next', 'start', 'cinema', 'comic', 'status', 'hint'].map(id => [id, makeElement()]));
  const transforms = [];
  Object.defineProperty(ids.frame.style, 'transform', {
    get: () => transforms.at(-1) || '',
    set: value => transforms.push(value)
  });
  const screen = makeElement();
  const caption = makeElement();
  const bars = Array.from({ length: 3 }, makeElement);
  const preference = { matches: reducedMotion, addEventListener(name, handler) { this.change = handler; } };
  vm.runInNewContext(source, {
    document: {
      getElementById: id => ids[id],
      querySelector: selector => selector === '.screen' ? screen : caption,
      querySelectorAll: () => bars
    },
    window: { matchMedia: () => preference },
    performance: { now: () => now },
    requestAnimationFrame: callback => { pending.set(++nextId, callback); return nextId; },
    cancelAnimationFrame: id => pending.delete(id)
  });
  return {
    ids, screen, caption, bars, preference, transforms,
    click(id) { if (!ids[id].disabled) ids[id].handlers.click(); },
    advance(ms) {
      now += ms;
      const callbacks = [...pending.values()];
      pending.clear();
      callbacks.forEach(callback => callback(now));
    },
    get scheduled() { return pending.size; }
  };
}

test('Кино: 6 / 10 / 6 секунд, две секунды без текста, постепенная реплика', () => {
  const p = player();
  assert.equal(p.ids.frame.src, 'assets/frame-1.svg');
  assert.equal(p.ids.dialogue.textContent, 'В этом городе даже тишина работала на мафию.');
  assert.equal(p.ids.back.disabled, true);
  p.click('start');
  p.advance(5999);
  assert.equal(p.ids.counter.textContent, 'КАДР 1 / 3');
  p.advance(1);
  assert.equal(p.ids.frame.src, 'assets/frame-02-bar.webp');
  assert.equal(p.ids.dialogue.textContent, '');
  assert.equal(p.ids.speaker.textContent, '');
  p.advance(1999);
  assert.equal(p.caption.classList.contains('is-empty'), true);
  assert.equal(p.ids['accessible-dialogue'].textContent, '');
  p.advance(2);
  assert.equal(p.ids.speaker.textContent, 'РАССКАЗЧИК');
  assert.ok(p.ids.dialogue.textContent.length > 0);
  assert.ok(p.ids.dialogue.textContent.length < narration.length);
  assert.equal(p.ids['accessible-dialogue'].textContent, narration);
  p.advance(3999);
  assert.equal(p.ids.dialogue.textContent, narration);
  p.advance(3999);
  assert.equal(p.ids.counter.textContent, 'КАДР 2 / 3');
  p.advance(1);
  assert.equal(p.ids.counter.textContent, 'КАДР 3 / 3');
  assert.equal(p.ids.frame.src, 'assets/frame-3.svg');
  assert.equal(p.ids.dialogue.textContent, '— Конечно. А вот с помидорами вышла заминка…');
  assert.equal(p.ids.frame.style.transform, '');
  p.advance(6000);
  assert.equal(p.ids.status.textContent, 'Конец демонстрации');
  assert.equal(p.scheduled, 0);
  assert.equal(p.ids.next.disabled, true);
  p.click('start');
  assert.equal(p.ids.counter.textContent, 'КАДР 1 / 3');
  assert.equal(p.scheduled, 1);
});

test('Пауза сохраняет задержку, набранный текст, приближение и оставшееся время', () => {
  const p = player();
  p.click('next');
  p.click('start');
  p.advance(1000);
  p.click('start');
  const transform = p.ids.frame.style.transform;
  p.advance(30000);
  assert.equal(p.ids.dialogue.textContent, '');
  assert.equal(p.ids.frame.style.transform, transform);
  assert.equal(p.scheduled, 0);
  p.click('start');
  p.advance(999);
  assert.equal(p.ids.dialogue.textContent, '');
  p.advance(1001);
  p.click('start');
  const text = p.ids.dialogue.textContent;
  const zoom = p.ids.frame.style.transform;
  p.advance(30000);
  assert.equal(p.ids.dialogue.textContent, text);
  assert.equal(p.ids.frame.style.transform, zoom);
  p.click('start');
  p.advance(6999);
  assert.equal(p.ids.counter.textContent, 'КАДР 2 / 3');
  p.advance(1);
  assert.equal(p.ids.counter.textContent, 'КАДР 3 / 3');
});

test('Комикс показывает всю реплику и останавливает кино без потери текущего кадра', () => {
  const p = player();
  p.click('start');
  p.click('next');
  p.advance(3000);
  p.click('comic');
  assert.equal(p.ids.counter.textContent, 'КАДР 2 / 3');
  assert.equal(p.ids.dialogue.textContent, narration);
  assert.equal(p.ids.frame.style.transform, '');
  assert.equal(p.ids.start.hidden, true);
  assert.equal(p.ids.comic.getAttribute('aria-pressed'), 'true');
  assert.equal(p.scheduled, 0);
  p.advance(30000);
  assert.equal(p.ids.counter.textContent, 'КАДР 2 / 3');
  p.click('next');
  assert.equal(p.ids.counter.textContent, 'КАДР 3 / 3');
  p.click('back');
  p.click('cinema');
  assert.equal(p.ids.counter.textContent, 'КАДР 2 / 3');
  assert.equal(p.ids.dialogue.textContent, '');
  assert.equal(p.ids.start.hidden, false);
  assert.equal(p.scheduled, 0);
});

test('Переходы сбрасывают сцену, не создают дублирующие таймеры и учитывают reduced motion', () => {
  const p = player({ reducedMotion: true });
  p.click('next');
  p.click('start');
  p.advance(4000);
  assert.equal(p.ids.frame.style.transform, '');
  p.preference.matches = false;
  p.preference.change();
  const scale = Number(p.ids.frame.style.transform.match(/[\d.]+/)[0]);
  assert.ok(scale > 0.8 && scale < 1);
  p.click('back');
  p.click('next');
  assert.equal(p.ids.dialogue.textContent, '');
  assert.equal(p.scheduled, 1);
  p.advance(9999);
  assert.equal(p.ids.counter.textContent, 'КАДР 2 / 3');
  p.advance(1);
  assert.equal(p.ids.counter.textContent, 'КАДР 3 / 3');
});

test('Приближение 80–100% плавно растёт за 10 секунд и не работает в Комиксе', () => {
  const p = player();
  p.click('next');
  assert.equal(p.ids.frame.style.transform, 'scale(0.8)');
  p.click('start');
  const scales = [0.8];
  for (let second = 1; second <= 9; second += 1) {
    p.advance(1000);
    const scale = Number(p.ids.frame.style.transform.match(/[\d.]+/)[0]);
    assert.ok(scale > scales.at(-1) && scale < 1);
    scales.push(scale);
  }
  assert.equal(scales[5], 0.9);
  // Плавное начало и завершение: шаг масштаба по краям меньше, чем в середине.
  assert.ok(scales[1] - scales[0] < scales[5] - scales[4]);
  assert.ok(scales[9] - scales[8] < scales[5] - scales[4]);
  p.advance(1000);
  assert.equal(p.transforms.at(-2), 'scale(1)');
  assert.equal(p.ids.counter.textContent, 'КАДР 3 / 3');
  p.click('back');
  assert.equal(p.ids.frame.style.transform, 'scale(0.8)');
  p.click('comic');
  assert.equal(p.ids.frame.style.transform, '');
  p.advance(20000);
  assert.equal(p.ids.frame.style.transform, '');
  assert.equal(p.ids.counter.textContent, 'КАДР 2 / 3');
});
