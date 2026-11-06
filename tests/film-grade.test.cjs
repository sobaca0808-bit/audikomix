const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const grade = require('../film-grade.js');

// Only the DOM operations the module uses are modeled; no transport or image decoder is mocked.
function documentHarness() {
  class Element {
    constructor(name) { this.nodeName = name; this.children = []; this.attributes = {}; this.dataset = {}; this.style = {}; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name] ?? null; }
    appendChild(child) { this.children.push(child); return child; }
    cloneNode() {
      const clone = new Element(this.nodeName);
      clone.attributes = { ...this.attributes }; clone.dataset = { ...this.dataset }; clone.style = { ...this.style };
      return clone;
    }
  }
  const body = new Element('body');
  function descendants(node) { return node.children.flatMap(child => [child, ...descendants(child)]); }
  const document = {
    body,
    createElementNS(namespace, name) { assert.equal(namespace, 'http://www.w3.org/2000/svg'); return new Element(name); },
    querySelectorAll(selector) {
      assert.equal(selector, 'img[data-grade-scene]');
      return descendants(body).filter(node => node.nodeName === 'img' && Object.hasOwn(node.dataset, 'gradeScene'));
    }
  };
  return {
    document, body,
    image() { return body.appendChild(new Element('img')); },
    all(name) { return descendants(body).filter(node => node.nodeName === name); }
  };
}

test('CommonJS and browser exports expose the same profiles and controller API', () => {
  const sandbox = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../film-grade.js'), 'utf8'), sandbox);
  assert.equal(typeof sandbox.window.AlleyFilmGrade.create, 'function');
  assert.deepEqual(Object.keys(grade.profiles), ['alley', 'panorama', 'hero', 'dasha', 'revelation']);
  assert.deepEqual(Object.keys(sandbox.window.AlleyFilmGrade.profiles), Object.keys(grade.profiles));
  assert.equal(grade.profiles.hero.filename, 'Сепия-нуар в баре с джазом.png');
  assert.ok(Object.isFrozen(grade.profiles));
  assert.ok(Object.isFrozen(grade.profiles.hero.R));
});

test('default cinema preserves authored sepia with identity sRGB curves and no extra grain', () => {
  const h = documentHarness();
  const controller = grade.create({ document: h.document });
  assert.deepEqual(controller.getSettings(), { look: 'cinema', brightness: 100, contrast: 100, saturation: 100 });
  const image = h.image();
  controller.apply(image, 'alley');
  assert.equal(image.dataset.gradeScene, 'alley');
  assert.equal(image.style.filter, 'url(#film-grade-alley) brightness(100%) contrast(100%) saturate(100%)');
  const filters = h.all('filter');
  assert.equal(filters.length, Object.keys(grade.profiles).length);
  for (const filter of filters) {
    const id = filter.getAttribute('id').slice('film-grade-'.length);
    const profile = grade.profiles[id];
    assert.equal(filter.getAttribute('color-interpolation-filters'), 'sRGB');
    assert.equal(filter.getAttribute('x'), '0%');
    assert.equal(filter.getAttribute('width'), '100%');
    const saturation = filter.children.find(child => child.getAttribute('result') === 'saturated');
    assert.equal(Number(saturation.getAttribute('values')), profile.saturation);
    const curves = filter.children.find(child => child.getAttribute('result') === 'graded');
    for (const channel of ['R', 'G', 'B']) {
      const fn = curves.children.find(child => child.nodeName === 'feFunc' + channel);
      assert.equal(fn.getAttribute('type'), 'table');
      assert.deepEqual(fn.getAttribute('tableValues').split(' ').map(Number), profile[channel]);
    }
    assert.equal(profile.saturation, 1);
    assert.equal(profile.grain, 0);
    assert.deepEqual(profile.R, [0, .125, .25, .375, .5, .625, .75, .875, 1]);
    assert.deepEqual(profile.G, profile.R);
    assert.deepEqual(profile.B, profile.R);
    assert.equal(filter.children.some(child => child.nodeName === 'feTurbulence'), false);
  }
  assert.equal(h.all('animate').length, 0);
  const svg = h.all('svg')[0];
  assert.equal(svg.getAttribute('width'), '0');
  assert.equal(svg.getAttribute('aria-hidden'), 'true');
  assert.notEqual(svg.style.display, 'none');
});

test('profiles follow all five approved photographs without re-toning their ready sepia', () => {
  const h = documentHarness(), controller = grade.create({ document: h.document });
  const scenes = require('../scenes.js').scenes;
  assert.equal(scenes.length, 5);
  for (const scene of scenes) {
    const profile = grade.profiles[scene.id];
    assert.equal(profile.filename, scene.image.slice('assets/'.length));
    assert.equal(profile.saturation, 1);
    assert.equal(profile.grain, 0);
    assert.match(controller.apply(h.image(), scene.id), new RegExp('^url\\(#film-grade-' + scene.id + '\\)'));
  }
});

test('original bypasses all grading, switching back and reset restore cinema defaults', () => {
  const h = documentHarness(), controller = grade.create({ document: h.document }), image = h.image();
  controller.apply(image, 'hero');
  controller.set({ look: 'original', brightness: 115, contrast: 90, saturation: 75 });
  assert.equal(image.style.filter, 'none');
  controller.set({ look: 'cinema' });
  assert.equal(image.style.filter, 'url(#film-grade-hero) brightness(115%) contrast(90%) saturate(75%)');
  assert.deepEqual(controller.reset(), { look: 'cinema', brightness: 100, contrast: 100, saturation: 100 });
  assert.equal(image.style.filter, 'url(#film-grade-hero) brightness(100%) contrast(100%) saturate(100%)');
  const copy = controller.getSettings(); copy.brightness = 70;
  assert.equal(controller.getSettings().brightness, 100);
});

test('slider inputs clamp independently; invalid partial updates keep previous values', () => {
  const h = documentHarness(), controller = grade.create({ document: h.document });
  controller.set({ brightness: 999, contrast: -5, saturation: 170 });
  assert.deepEqual(controller.getSettings(), { look: 'cinema', brightness: 130, contrast: 70, saturation: 150 });
  controller.set({ brightness: -1, contrast: 400, saturation: -1 });
  assert.deepEqual(controller.getSettings(), { look: 'cinema', brightness: 70, contrast: 130, saturation: 0 });
  controller.set({ brightness: '112.5', contrast: '95', saturation: '80' });
  const saved = controller.getSettings();
  for (const bad of [NaN, Infinity, -Infinity, '', '  ', 'invalid', null, true, {}, []]) {
    controller.set({ look: 'other', brightness: bad, contrast: bad, saturation: bad });
    assert.deepEqual(controller.getSettings(), saved);
  }
  controller.set(null); controller.set([]);
  assert.deepEqual(controller.getSettings(), saved);
  controller.set({ contrast: 105 });
  assert.deepEqual(controller.getSettings(), { ...saved, contrast: 105 });
});

test('fresh DOM scans keep crossfade snapshots on their own scene and leave transport alone', () => {
  const h = documentHarness(), controller = grade.create({ document: h.document });
  const image = h.image(); image.style.opacity = '0.4'; image.style.transform = 'scale(0.9)';
  controller.apply(image, 'alley');
  const snapshot = image.cloneNode(); h.body.appendChild(snapshot);
  controller.apply(image, 'hero');
  const unrelated = h.image(); unrelated.style.filter = 'sepia(1)';
  controller.set({ brightness: 110 });
  assert.equal(snapshot.dataset.gradeScene, 'alley');
  assert.equal(snapshot.style.filter, 'url(#film-grade-alley) brightness(110%) contrast(100%) saturate(100%)');
  assert.equal(image.style.filter, 'url(#film-grade-hero) brightness(110%) contrast(100%) saturate(100%)');
  assert.equal(image.style.opacity, '0.4'); assert.equal(image.style.transform, 'scale(0.9)');
  assert.equal(unrelated.style.filter, 'sepia(1)');
  controller.set({ look: 'original' });
  assert.equal(snapshot.style.filter, 'none'); assert.equal(image.style.filter, 'none');
});

test('unknown scenes clear a previous grade and malformed custom profiles safely bypass', () => {
  const h = documentHarness(), controller = grade.create({ document: h.document }), image = h.image();
  controller.apply(image, 'alley');
  assert.equal(controller.apply(image, 'missing'), 'none');
  assert.equal(image.dataset.gradeScene, 'missing');
  controller.set({ contrast: 110 }); assert.equal(image.style.filter, 'none');
  const custom = documentHarness();
  const customController = grade.create({ document: custom.document, profiles: {
    custom: grade.profiles.dasha,
    broken: { saturation: 1, R: [0, 1], G: [0, 1], B: [0, 1] },
    'invalid id': grade.profiles.hero
  } });
  const customImage = custom.image();
  assert.match(customController.apply(customImage, 'custom'), /^url\(#film-grade-custom\)/);
  assert.equal(customController.apply(customImage, 'broken'), 'none');
  assert.equal(customController.apply(customImage, 'invalid id'), 'none');
  assert.equal(custom.all('filter').length, 1);
});

test('one document gets stable unique IDs and supports an explicit mount', () => {
  const h = documentHarness();
  const mount = h.document.createElementNS('http://www.w3.org/2000/svg', 'g');
  h.body.appendChild(mount);
  const first = grade.create({ document: h.document, mount });
  assert.equal(grade.create({ document: h.document }), first);
  assert.equal(mount.children.length, 1);
  const ids = h.all('filter').map(filter => filter.getAttribute('id'));
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(h.all('svg').length, 1);
});

test('optional grain is static, monochrome, clipped and requires an explicit bounded profile', () => {
  const h = documentHarness();
  grade.create({ document: h.document, profiles: {
    custom: { ...grade.profiles.hero, grain: .025 },
    invalid: { ...grade.profiles.hero, grain: 1 }
  } });
  assert.equal(h.all('filter').length, 1);
  const filter = h.all('filter')[0];
  const noise = h.all('feTurbulence')[0];
  assert.equal(noise.getAttribute('seed'), '7');
  assert.equal(filter.children.find(child => child.getAttribute('result') === 'monochrome').getAttribute('values'), '0');
  const grain = filter.children.find(child => child.getAttribute('result') === 'grain');
  assert.equal(grain.children[0].getAttribute('intercept'), '0.025');
  assert.equal(filter.children.at(-1).getAttribute('in2'), 'SourceGraphic');
  assert.equal(filter.children.at(-1).getAttribute('operator'), 'in');
  assert.equal(h.all('animate').length, 0);
});
