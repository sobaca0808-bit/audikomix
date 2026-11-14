const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const effects = require('../director-effects.js');

function harness() {
  class Element {
    constructor(name) { this.name = name; this.children = []; this.style = {}; this.attributes = {}; this.hidden = false; this.parentNode = null; }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
    remove() {
      if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
      this.parentNode = null;
    }
  }
  const visual = new Element('visual');
  visual.style.width = '100%'; visual.style.transform = 'none';
  const image = visual.appendChild(new Element('img'));
  image.style.filter = 'url(#film-grade-hero)'; image.style.transform = 'scale(1.02)';
  const document = { createElement: name => new Element(name), querySelector: selector => selector === '.visual' ? visual : null };
  return { document, visual, image };
}

const full = { directorEffects: { smoke: 1, flicker: 1 } };

test('browser export and default project leave the original image and layout untouched', () => {
  const sandbox = { window: {}, setTimeout() { throw new Error('Effects must not start another clock'); }, requestAnimationFrame() { throw new Error('Effects must not start another clock'); } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../director-effects.js'), 'utf8'), sandbox);
  assert.equal(typeof sandbox.window.AlleyDirectorEffects.create, 'function');
  const h = harness(), beforeImage = { ...h.image.style }, beforeVisual = { ...h.visual.style };
  const controller = sandbox.window.AlleyDirectorEffects.create({ document: h.document });
  controller.render({}, 10000);
  const layer = h.visual.children[1];
  assert.equal(layer.hidden, true);
  assert.equal(layer.attributes['aria-hidden'], 'true');
  assert.equal(layer.children.length, 2);
  assert.deepEqual(h.image.style, beforeImage);
  assert.deepEqual(h.visual.style, beforeVisual);
});

test('authored smoke/light strengths are clamped and cannot introduce rapid or strong flashing', () => {
  for (let elapsed = 0; elapsed <= 600000; elapsed += 250) {
    const state = effects.sample(full, elapsed);
    assert.equal(state.smokeOpacity, .15);
    assert.ok(state.lightOpacity >= 0 && state.lightOpacity <= .05);
    const next = effects.sample(full, elapsed + 50);
    assert.ok(Math.abs(next.lightOpacity - state.lightOpacity) < .001);
  }
  assert.equal(effects.sample({ directorEffects: { smoke: 99, flicker: 99 } }, 0).smokeOpacity, .15);
  for (const invalid of [-1, '1', NaN, Infinity, null, {}, true]) {
    const state = effects.sample({ directorEffects: { smoke: invalid, flicker: invalid } }, 100);
    assert.equal(state.smokeOpacity, 0);
    assert.equal(state.lightOpacity, 0);
  }
  assert.deepEqual(effects.sample(full, -100), effects.sample(full, 0));
  assert.deepEqual(effects.sample(full, Infinity), effects.sample(full, 0));
});

test('the supplied elapsed clock determines movement, and repeated paused renders freeze exactly', () => {
  const h = harness(), controller = effects.create({ document: h.document });
  controller.render(full, 3000);
  const layer = h.visual.children[1], smoke = layer.children[0], light = layer.children[1];
  assert.equal(layer.hidden, false);
  const paused = { smoke: { ...smoke.style }, light: { ...light.style } };
  for (let repeat = 0; repeat < 10; repeat++) controller.render(full, 3000);
  assert.deepEqual(smoke.style, paused.smoke);
  assert.deepEqual(light.style, paused.light);
  controller.render(full, 5000);
  assert.notEqual(smoke.style.transform, paused.smoke.transform);
  assert.notEqual(light.style.opacity, paused.light.opacity);
});

test('Comic and reduced motion keep a static preview without another animation clock', () => {
  for (const settings of [{ reading: true }, { reducedMotion: true }, { reading: true, reducedMotion: true }]) {
    const first = effects.sample(full, 0, settings);
    assert.deepEqual(effects.sample(full, 12000, settings), first);
    assert.deepEqual(effects.sample(full, 40000, settings), first);
    assert.equal(first.smokeOpacity, .15);
    assert.equal(first.lightOpacity, .025);
    assert.match(first.smokeTransform, /translate3d\(0%, 0%, 0\)/);
  }
});

test('scene switches disable old effects; creation is idempotent and destruction releases only its overlay', () => {
  const h = harness(), controller = effects.create({ document: h.document });
  assert.equal(effects.create({ document: h.document }), controller);
  assert.equal(h.visual.children.length, 2);
  controller.render(full, 1000);
  controller.render({ directorEffects: { smoke: .5, flicker: 0 } }, 2000);
  const layer = h.visual.children[1];
  assert.equal(layer.children[0].style.opacity, '.075'.replace(/^\./, '0.'));
  assert.equal(layer.children[1].hidden, true);
  controller.render(null, 3000);
  assert.equal(layer.hidden, true);
  controller.destroy(); controller.destroy();
  assert.equal(h.visual.children.length, 1);
  assert.equal(h.visual.children[0], h.image);
  assert.equal(controller.render(full, 5000), undefined);
  assert.notEqual(effects.create({ document: h.document }), controller);
  assert.equal(h.visual.children.length, 2);
});
