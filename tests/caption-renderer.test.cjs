const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const renderer = require('../caption-renderer.js');

function harness() {
  let created = 0;
  class Element {
    constructor(name) {
      this.nodeName = name;
      this.children = [];
      this.attributes = {};
      this.dataset = {};
      this.styles = {};
      this.styleWrites = [];
      this.style = new Proxy(this.styles, { set: (target, key, value) => {
        this.styleWrites.push([key, value]); target[key] = value; return true;
      } });
      this.replacements = 0;
      this.textWrites = 0;
      this._text = '';
    }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name] ?? null; }
    appendChild(child) { this.children.push(child); return child; }
    replaceChildren(fragment) {
      this.replacements += 1;
      this.children = fragment.children.slice();
      this._text = '';
    }
    set textContent(text) { this.textWrites += 1; this._text = String(text); this.children = []; }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    set innerHTML(_) { throw Error('Caption markup must never parse authored HTML'); }
  }
  const document = {
    createElement(name) { created += 1; return new Element(name); },
    createDocumentFragment() { return new Element('#fragment'); }
  };
  const element = new Element('p'); element.ownerDocument = document;
  const controller = renderer.create({ document, element });
  return { document, element, controller, get created() { return created; } };
}

const revealedText = element => element.children.filter(span => span.style.visibility === 'visible').map(span => span.textContent).join('');

test('browser export and CommonJS provide the same timer-free API', () => {
  const sandbox = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../caption-renderer.js'), 'utf8'), sandbox);
  assert.equal(typeof sandbox.window.AlleyCaptionRenderer.create, 'function');
  const h = harness();
  assert.deepEqual(Object.keys(h.controller).sort(), ['getVisibleText', 'render']);
  assert.equal(h.controller.getVisibleText(), '');
});

test('full text participates in layout before the first character is revealed', () => {
  const h = harness();
  const fullText = 'В нашем городе каждый второй…';
  h.controller.render({ fullText, visibleText: '' });
  assert.equal(h.element.textContent, fullText);
  assert.equal(h.element.children.length, Array.from(fullText).length);
  assert.equal(h.element.style.whiteSpace, 'pre-wrap');
  assert.equal(revealedText(h.element), '');
  assert.equal(h.element.dataset.visibleText, '');
  h.element.children.forEach((span, index) => {
    assert.equal(span.className, 'caption-char');
    assert.equal(span.getAttribute('data-caption-char'), String(index));
    assert.equal(span.getAttribute('data-revealed'), 'false');
    assert.equal(span.style.visibility, 'hidden');
    assert.equal(span.style.display, undefined, 'Hidden glyphs must not leave the inline layout');
  });
});

test('typing, pause redraw and rewind preserve every DOM node and the complete text', () => {
  const h = harness(), fullText = 'Люблю тихие вечера.';
  h.controller.render({ fullText, visibleText: '' });
  const nodes = h.element.children.slice(), created = h.created;
  for (const visibleText of ['Л', 'Люблю ', 'Люблю тихие', 'Люблю тихие', fullText, 'Лю', '']) {
    h.controller.render({ fullText, visibleText });
    assert.deepEqual(h.element.children, nodes);
    assert.equal(h.element.replacements, 1);
    assert.equal(h.created, created);
    assert.equal(h.element.textContent, fullText);
    assert.equal(revealedText(h.element), visibleText);
    assert.equal(h.controller.getVisibleText(), visibleText);
    assert.equal(h.element.dataset.visibleText, visibleText);
  }
  nodes.forEach(node => assert.equal(node.textWrites, 1, 'Reveal must not rewrite the characters'));
});

test('one newly revealed character changes only that glyph visibility', () => {
  const h = harness(), fullText = 'Газеты, господа!';
  h.controller.render({ fullText, visibleText: 'Газеты' });
  const before = h.element.children.map(node => node.styleWrites.length);
  h.controller.render({ fullText, visibleText: 'Газеты,' });
  h.element.children.forEach((node, index) => {
    assert.equal(node.styleWrites.length - before[index], index === 6 ? 1 : 0);
    assert.deepEqual(Object.keys(node.styles), ['visibility']);
  });
});

test('spaces, newlines, punctuation and Unicode code points remain intact in Comic mode', () => {
  const h = harness(), fullText = '  Свежий „Переулок“! 🎬\n\nГазеты, господа!  ';
  h.controller.render({ fullText, visibleText: fullText });
  assert.equal(h.element.textContent, fullText);
  assert.equal(revealedText(h.element), fullText);
  assert.equal(h.controller.getVisibleText(), fullText);
  assert.equal(h.element.children.filter(node => node.textContent === '🎬').length, 1);
  h.controller.render({ fullText, visibleText: '  Свежий „Переулок“! 🎬' });
  assert.equal(revealedText(h.element), '  Свежий „Переулок“! 🎬');
});

test('new phrases rebuild once and authored HTML stays literal text', () => {
  const h = harness();
  h.controller.render({ fullText: 'Переулок', visibleText: 'Пере' });
  const old = h.element.children[0];
  const fullText = '<img src=x onerror=alert(1)> & <b>новости</b>';
  h.controller.render({ fullText, visibleText: '<img' });
  assert.notEqual(h.element.children[0], old);
  assert.equal(h.element.replacements, 2);
  assert.equal(h.element.textContent, fullText);
  assert.equal(revealedText(h.element), '<img');
  assert.ok(h.element.children.every(node => node.nodeName === 'span'));
});

test('invalid prefixes and partial surrogate pairs reveal nothing', () => {
  const h = harness(), fullText = '🎬 Переулок';
  for (const visibleText of ['Другая строка', '🎬 Переулок с продолжением', '\ud83c', 5, null]) {
    h.controller.render({ fullText, visibleText });
    assert.equal(revealedText(h.element), '');
    assert.equal(h.controller.getVisibleText(), '');
  }
  h.controller.render({ fullText, visibleText: '🎬' });
  assert.equal(revealedText(h.element), '🎬');
});

test('empty or absent text clears an old caption without stale visible state', () => {
  const h = harness();
  h.controller.render({ fullText: 'Новая реплика', visibleText: 'Новая' });
  h.controller.render({ fullText: '', visibleText: '' });
  assert.equal(h.element.textContent, '');
  assert.equal(h.element.children.length, 0);
  assert.equal(h.controller.getVisibleText(), '');
  assert.equal(h.element.dataset.visibleText, '');
  h.controller.render();
  assert.equal(h.element.replacements, 2);
});

test('a long complete paragraph uses a fragment rather than spreading arguments', () => {
  const h = harness(), fullText = 'т'.repeat(70000);
  h.controller.render({ fullText, visibleText: fullText });
  assert.equal(h.element.children.length, fullText.length);
  assert.equal(h.element.textContent, fullText);
  assert.equal(h.element.replacements, 1);
});
