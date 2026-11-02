const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../player.js'), 'utf8');
const narration = 'Люблю тихие вечера. Особенно когда никто не пытается меня убить';
const alleyPhrases = [
  '1932 год… В этом городе даже тишина работала на мафию.',
  'У каждого здесь были свои секреты.',
  'А дурные новости приходили без приглашения…',
  'И что особенно обидно — за них ещё приходилось платить.'
];

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

test('Кино: 16 / 10 / 6 секунд, второй кадр сохраняет задержку и реплику', () => {
  const p = player();
  assert.equal(p.ids.frame.src, 'assets/frame-01-alley.webp');
  assert.equal(p.ids.dialogue.textContent, '');
  assert.equal(p.ids.back.disabled, true);
  p.click('start');
  p.advance(15999);
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

test('Первый кадр: одна секунда без текста, четыре фразы и паузы между ними', () => {
  const p = player();
  assert.equal(p.screen.classList.contains('image-only'), true);
  assert.equal(p.screen.classList.contains('photo-frame'), false);
  assert.equal(p.screen.classList.contains('alley-frame'), true);
  p.click('start');
  p.advance(999);
  assert.equal(p.ids.dialogue.textContent, '');
  assert.equal(p.ids.speaker.textContent, '');
  assert.equal(p.ids['accessible-dialogue'].textContent, '');
  p.advance(1);
  assert.equal(p.screen.classList.contains('image-only'), false);
  assert.equal(p.ids.speaker.textContent, 'РАССКАЗЧИК');
  let now = 1000;
  const intervals = [[1000, 3000, 4250], [4500, 6000, 7250], [7500, 9500, 10750], [11000, 13500, 16000]];
  for (let index = 0; index < intervals.length; index += 1) {
    const [start, complete, end] = intervals[index];
    p.advance(start + 1 - now);
    now = start + 1;
    const partial = p.ids.dialogue.textContent;
    assert.ok(partial.length > 0 && partial.length < alleyPhrases[index].length);
    assert.ok(alleyPhrases[index].startsWith(partial));
    assert.equal(p.ids['accessible-dialogue'].textContent, alleyPhrases[index]);
    p.advance(complete - now);
    now = complete;
    assert.equal(p.ids.dialogue.textContent, alleyPhrases[index]);
    p.advance(end - 1 - now);
    now = end - 1;
    assert.equal(p.ids.dialogue.textContent, alleyPhrases[index]);
    p.advance(1);
    now = end;
    assert.equal(p.ids.dialogue.textContent, '');
    assert.equal(p.ids.speaker.textContent, '');
    if (index < 3) {
      assert.equal(p.caption.classList.contains('is-empty'), true);
      assert.equal(p.ids.counter.textContent, 'КАДР 1 / 3');
    }
  }
  assert.equal(p.ids.counter.textContent, 'КАДР 2 / 3');
  assert.equal(p.ids.frame.style.transform, 'scale(0.8)');
});

test('Первый кадр: пауза сохраняет начальную задержку, набор и межфразовый интервал', () => {
  const p = player();
  p.click('start');
  p.advance(500);
  p.click('start');
  const openingScale = p.ids.frame.style.transform;
  p.advance(20000);
  assert.equal(p.screen.classList.contains('image-only'), true);
  assert.equal(p.ids.frame.style.transform, openingScale);
  p.click('start');
  p.advance(499);
  assert.equal(p.ids.dialogue.textContent, '');
  p.advance(501);
  p.click('start');
  const text = p.ids.dialogue.textContent;
  const scale = p.ids.frame.style.transform;
  p.advance(20000);
  assert.equal(p.ids.dialogue.textContent, text);
  assert.equal(p.ids.frame.style.transform, scale);
  p.click('start');
  p.advance(2750);
  assert.equal(p.ids.dialogue.textContent, '');
  p.click('start');
  p.advance(20000);
  assert.equal(p.ids.dialogue.textContent, '');
  p.click('start');
  p.advance(251);
  assert.ok(alleyPhrases[1].startsWith(p.ids.dialogue.textContent));
  assert.ok(p.ids.dialogue.textContent.length > 0);
});

test('Первый кадр: приближение 90–100% за 16 секунд, весь текст в Комиксе без ожидания', () => {
  const p = player();
  assert.equal(p.ids.frame.style.transform, 'scale(0.9)');
  p.click('start');
  p.advance(8000);
  assert.ok(Math.abs(Number(p.ids.frame.style.transform.match(/[\d.]+/)[0]) - 0.95) < 1e-9);
  p.advance(7999);
  assert.equal(p.ids.counter.textContent, 'КАДР 1 / 3');
  assert.equal(p.ids.dialogue.textContent, alleyPhrases[3]);
  p.advance(1);
  assert.equal(p.transforms.at(-2), 'scale(1)');
  p.click('back');
  assert.equal(p.ids.frame.style.transform, 'scale(0.9)');
  assert.equal(p.ids.dialogue.textContent, '');
  p.click('comic');
  assert.equal(p.ids.dialogue.textContent, alleyPhrases.join('\n\n'));
  assert.equal(p.ids['accessible-dialogue'].textContent, alleyPhrases.join('\n\n'));
  assert.equal(p.ids.frame.style.transform, '');
  assert.equal(p.screen.classList.contains('image-only'), false);
  p.advance(30000);
  assert.equal(p.ids.counter.textContent, 'КАДР 1 / 3');
  assert.equal(p.ids.dialogue.textContent, alleyPhrases.join('\n\n'));
  p.click('cinema');
  assert.equal(p.ids.dialogue.textContent, '');
  assert.equal(p.ids.frame.style.transform, 'scale(0.9)');
  const reduced = player({ reducedMotion: true });
  reduced.click('start');
  reduced.advance(8000);
  assert.equal(reduced.ids.frame.style.transform, '');
  assert.ok(reduced.ids.dialogue.textContent.length > 0);
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
