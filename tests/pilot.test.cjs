const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const story = require('../scenes.js');
const timeline = require('../pilot-timeline.js');
const model = require('../director-project.js');
const { player } = require('./helpers/player.cjs');
const root = path.join(__dirname, '..');
const ids = ['alley', 'hero', 'dasha', 'revelation', 'panorama', 'whispers', 'valentin', 'friends', 'intruders', 'invitation'];
const normalize = text => text.replace(/\s+/gu, ' ').trim();

// Read the independent author manuscript, excluding scene descriptions and
// stage directions. This catches accidental use of the shortened cue JSON.
function manuscriptDialogue() {
  const script = fs.readFileSync(path.join(root, 'story/first-page/script.md'), 'utf8');
  return script.split(/^## \d\d\..+$/mu).slice(1).map(body => {
    const spoken = [];
    for (let paragraph of body.trim().split(/\n\s*\n/u)) {
      if (paragraph.startsWith('**Картинка:**') || paragraph.startsWith('Валентин смотрит на героя.')) continue;
      paragraph = paragraph.replace(/^\*\*[^*]+:\*\*/u, '').replace(/\([^)]*\)/gu, '').replace(/\*\*/gu, '');
      if (paragraph.trim()) spoken.push(paragraph);
    }
    return normalize(spoken.join(' '));
  });
}

test('ten scenes match the approved manifest, and every WebP exists', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'story/first-page/frames.json'), 'utf8'));
  assert.deepEqual(story.scenes.map(scene => scene.id), ids);
  assert.equal(story.scenes.length, 10);
  assert.deepEqual(story.scenes.map(scene => scene.image), manifest.map(scene => scene.image));
  for (const scene of story.scenes) {
    const bytes = fs.readFileSync(path.join(root, scene.image));
    assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
    assert.equal(bytes.toString('ascii', 8, 12), 'WEBP');
    assert.ok(bytes.length > 100000);
  }
});

test('every spoken word of the full manuscript is present, without stage directions becoming dialogue', () => {
  const expected = manuscriptDialogue();
  assert.equal(expected.length, 10);
  story.scenes.forEach((scene, index) => {
    assert.equal(normalize(scene.phrases.map(phrase => phrase.text).join(' ')), expected[index], scene.id);
    assert.ok(scene.phrases.every(phrase => phrase.speaker && !phrase.text.includes('(Пауза.)')));
  });
  assert.ok(story.scenes[3].stageDirections.some(text => text.includes('Разглядывает газету')));
  assert.ok(story.scenes[7].stageDirections.some(text => text.includes('Пауза')));
});

test('preliminary timing has finite non-overlapping cues, readable typing and a reading hold', () => {
  assert.equal(story.timing.draftDuration, 296000);
  assert.equal(story.timing.duration, story.scenes.reduce((sum, scene) => sum + scene.duration, 0));
  assert.ok(story.timing.duration > story.timing.draftDuration);
  for (const scene of story.scenes) {
    let previous = 0;
    assert.ok(scene.duration >= scene.draftDuration);
    assert.ok(scene.phrases.length <= model.LIMITS.phrases);
    for (const phrase of scene.phrases) {
      assert.ok(phrase.start >= previous);
      assert.ok(phrase.typing >= Array.from(phrase.text).length / timeline.PACE.typingCps * 1000);
      assert.ok(phrase.end - phrase.start >= phrase.typing + timeline.PACE.holdMs);
      assert.ok(phrase.end <= scene.duration);
      previous = phrase.end;
    }
  }
  assert.equal(story.scenes[0].phrases[0].start, 1000);
  for (const id of ['hero', 'revelation', 'friends', 'invitation']) {
    const cues = story.scenes.find(scene => scene.id === id).phrases;
    assert.ok(cues.some((cue, i) => i && cue.start - cues[i - 1].end >= 1200), id + ' explicit pause');
  }
});

test('sound plan has relative voice/music/ambience/sfx windows apart from the connected rain ambience', () => {
  const kinds = new Set();
  assert.equal(story.audio.beds.rain.src, 'assets/audio/calpo_rain.ogg');
  assert.ok(fs.existsSync(path.join(root, story.audio.beds.rain.src)));
  assert.ok(Object.entries(story.audio.beds).filter(([id]) => id !== 'rain').every(([, bed]) => bed.src === null));
  for (const scene of story.scenes) {
    assert.equal(scene.audio.voice, null);
    assert.deepEqual(scene.audio.beds.map(bed => bed.id), ['alley', 'dasha'].includes(scene.id) ? ['rain'] : []);
    assert.equal(scene.audio.effects.length, 0);
    assert.equal(scene.audioPlan.filter(cue => cue.kind === 'voice').length, scene.phrases.length);
    for (const cue of scene.audioPlan) {
      kinds.add(cue.kind);
      assert.equal(cue.src, null);
      assert.equal(cue.status, 'planned');
      assert.ok(cue.start >= 0 && cue.end > cue.start && cue.end <= scene.duration);
    }
  }
  assert.deepEqual([...kinds].sort(), ['ambience', 'music', 'sfx', 'voice']);
});

test('silent cinema advances through all ten scenes and ends on the title, with restart', async () => {
  const p = player({ story });
  assert.equal(p.ids.counter.textContent, 'КАДР 1 / 10');
  assert.equal(p.ids.progress.children.length, 10);
  assert.equal(p.audio.events.length, 0);
  await p.click('start');
  for (let i = 0; i < story.scenes.length; i++) {
    assert.equal(p.ids.counter.textContent, `КАДР ${i + 1} / 10`);
    p.advance(story.scenes[i].duration);
  }
  assert.equal(p.ids.start.textContent, 'Сначала');
  assert.equal(p.ids['end-card'].hidden, false);
  assert.equal(p.ids['end-card-title'].textContent, 'ПРОДОЛЖЕНИЕ СЛЕДУЕТ…');
  assert.equal(p.ids['accessible-dialogue'].textContent, 'ПРОДОЛЖЕНИЕ СЛЕДУЕТ…');
  assert.equal(p.scheduled, 0);
  await p.click('start');
  assert.equal(p.ids.counter.textContent, 'КАДР 1 / 10');
  assert.equal(p.ids['end-card'].hidden, true);
});

test('every cinema caption reveals completely with the correct speaker', async () => {
  const p = player({ story });
  for (let index = 0; index < story.scenes.length; index++) {
    p.go(index); await p.click('start');
    let now = 0;
    for (const phrase of story.scenes[index].phrases) {
      const target = phrase.start + phrase.typing;
      p.advance(target - now); now = target;
      assert.equal(p.ids.dialogue.textContent, phrase.text, index + ': ' + phrase.text);
      assert.equal(p.ids.speaker.textContent, phrase.speaker);
      assert.equal(p.ids['accessible-dialogue'].textContent, phrase.text);
    }
    await p.click('start');
  }
});

test('comic exposes all dialogue and the ending immediately, without starting the timer', async () => {
  const p = player({ story }); await p.click('comic');
  for (let index = 0; index < story.scenes.length; index++) {
    p.go(index);
    for (const phrase of story.scenes[index].phrases) assert.ok(p.ids.dialogue.textContent.includes(phrase.text));
    assert.equal(p.ids.start.hidden, true);
    assert.equal(p.scheduled, 0);
    assert.equal(p.ids.frame.style.transform, '');
    assert.equal(p.ids['end-card'].hidden, true);
  }
  assert.ok(p.ids.dialogue.textContent.includes('ПРОДОЛЖЕНИЕ СЛЕДУЕТ…'));
  await p.click('cinema');
  assert.equal(p.ids.dialogue.textContent, '');
});

test('final question, response pause, fade and title follow one clock and pause together', async () => {
  const frame = story.scenes.at(-1), p = player({ story }); p.go(9); await p.click('start');
  const last = frame.phrases.at(-1);
  p.advance(last.start + last.typing);
  assert.equal(p.ids.dialogue.textContent, 'А ты сам-то в таком кино сняться согласился бы?');
  const fadeStart = frame.duration - frame.endCard.fadeMs - frame.endCard.holdMs;
  assert.ok(fadeStart - last.end >= frame.endCard.pauseMs);
  p.advance(fadeStart + 600 - last.start - last.typing);
  const shade = p.ids['end-card'].style.backgroundColor;
  assert.match(shade, /0\.5\)/);
  await p.click('start'); p.advance(10000);
  assert.equal(p.ids['end-card'].style.backgroundColor, shade);
  await p.click('start'); p.advance(1200);
  assert.equal(p.ids['end-card-title'].style.opacity, '1');
  await p.click('back');
  assert.equal(p.ids['end-card'].hidden, true);
});

test('reduced motion preserves the final title without animated camera or fade', () => {
  const frame = story.scenes.at(-1), start = frame.duration - frame.endCard.fadeMs - frame.endCard.holdMs;
  const state = timeline.endCardState(frame, start + 600, { reducedMotion: true });
  assert.equal(state.shade, 1); assert.equal(state.title, 0);
  assert.equal(timeline.endCardState(frame, frame.duration, { reducedMotion: true }).title, 1);
  assert.equal(timeline.endCardState(frame, frame.duration, { reading: true }).visible, false);
});

test('director roundtrip handles all ten scenes, retains plans, and rejects a legacy five-scene import', () => {
  const project = model.fromStory(story);
  assert.equal(project.scenes.length, 10);
  const compiled = model.compile(JSON.parse(JSON.stringify(project)), story);
  assert.deepEqual(compiled.scenes.map(scene => scene.image), story.scenes.map(scene => scene.image));
  assert.deepEqual(compiled.scenes.at(-1).endCard, story.scenes.at(-1).endCard);
  assert.deepEqual(compiled.scenes.map(scene => scene.audioPlan), story.scenes.map(scene => scene.audioPlan));
  assert.equal(compiled.storageKey, story.storageKey);
  assert.throws(() => model.validate(model.fromStory(require('./fixtures/legacy-story.cjs')), story), /10/);
  const duplicate = structuredClone(project); duplicate.scenes[1].id = duplicate.scenes[0].id;
  assert.throws(() => model.validate(duplicate, story), /повторяется/);
});

test('editing the final caption keeps the ending after its complete reading window', () => {
  const project = model.fromStory(story), final = project.scenes.at(-1);
  final.phrases.at(-1).endMs = final.durationMs;
  const compiled = model.compile(project, story), scene = compiled.scenes.at(-1);
  assert.ok(scene.duration >= final.phrases.at(-1).endMs + 4800);
});
