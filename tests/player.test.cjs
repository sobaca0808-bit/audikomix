const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../player.js'), 'utf8');
const config = fs.readFileSync(path.join(__dirname, '../scenes.js'), 'utf8');
const intro = ['1932 год… В этом городе даже тишина работала на мафию.', 'У каждого здесь были свои секреты.', 'А дурные новости приходили без приглашения…', 'И что особенно обидно — за них ещё приходилось платить.'];
const hero = 'Люблю тихие вечера. Особенно когда никто не пытается меня убить';
const dasha = ['Свежий „Переулок“!', 'Дерзкое ограбление банка!', 'Главный подозреваемый — на первой полосе!', 'Газеты, господа, газеты!'];
const images = [
  'assets/Дождливый переулок у бара «Переулок».png',
  'assets/Сепийный джаз-бар «Переулок».png',
  'assets/Сепия-нуар в баре с джазом.png',
  'assets/Газетчица у старого бара.png',
  'assets/Газетный заголовок в переулке.png'
];

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

// Фальшивый аудиоадаптер проверяет транспорт; сам движок проверяется отдельно.
function player({ voiceSeconds = null, preparation = Promise.resolve(), reducedMotion = false, extraScene = false, blockedVoice = false } = {}) {
  let now = 0, nextId = 0, audio;
  const pending = new Map();
  function makeElement() {
    const classes = new Set();
    return {
      textContent: '', attributes: {}, handlers: {}, disabled: false, hidden: false, children: [], value: '',
      style: { setProperty(name, value) { this[name] = value; } },
      classList: { toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); }, contains: name => classes.has(name) },
      setAttribute(name, value) { this.attributes[name] = value; }, getAttribute(name) { return this.attributes[name]; },
      set src(value) { this.attributes.src = value; }, get src() { return this.attributes.src; },
      appendChild(child) { this.children.push(child); }, addEventListener(name, handler) { this.handlers[name] = handler; }
    };
  }
  const ids = Object.fromEntries(['frame','speaker','dialogue','accessible-dialogue','counter','back','next','start','cinema','comic','status','hint','progress','audio-status','volume-voice','volume-ambience','volume-music','volume-effects'].map(id => [id, makeElement()]));
  const screen = makeElement(), caption = makeElement();
  const preference = { matches: reducedMotion, addEventListener(name, handler) { this.change = handler; } };
  const document = { hidden: false, handlers: {}, getElementById: id => ids[id], createElement: makeElement,
    querySelector: selector => selector === '.screen' ? screen : caption,
    addEventListener(name, handler) { this.handlers[name] = handler; } };
  class FakeAudio {
    constructor(settings, { onStatus }) { audio = this; this.settings = settings; this.onStatus = onStatus; this.events = []; this.ready = false; this.blocked = blockedVoice; }
    async prepare() { this.events.push({ type: 'prepare' }); await preparation; this.ready = true; this.onStatus({ message: voiceSeconds ? 'Голос готов' : 'Запись ещё не добавлена. Показ без голоса.', contextState: 'running' }); }
    durationFor(scene) { return this.ready && voiceSeconds && scene.audio.voice ? voiceSeconds * 1000 + scene.audio.voice.start + scene.audio.voice.tail : scene.duration; }
    play(scene, elapsed, options = {}) { if (this.blocked) return false; this.events.push({ type: 'play', id: scene.id, elapsed, crossfade: Boolean(options.crossfade) }); this.playing = true; }
    getStatus() { return { voice: this.ready && voiceSeconds ? 'ready' : 'missing' }; }
    tick(elapsed) { this.elapsed = elapsed; }
    pause() { this.events.push({ type: 'pause' }); this.playing = false; }
    stop() { this.events.push({ type: 'stop' }); this.playing = false; }
    setVolume(channel, value) { this.events.push({ type: 'volume', channel, value }); }
  }
  const window = { AlleyAudio: FakeAudio, handlers: {}, matchMedia: () => preference, addEventListener(name, handler) { this.handlers[name] = handler; } };
  const context = vm.createContext({ document, window, performance: { now: () => now },
    requestAnimationFrame: callback => { pending.set(++nextId, callback); return nextId; }, cancelAnimationFrame: id => pending.delete(id) });
  vm.runInContext(config, context);
  if (extraScene) window.AlleyStory.scenes.push({ id:'extra', title:'Проверка конфигурации', image:'assets/frame-3.svg', duration:2000, text:'', audio:{voice:null,beds:[],effects:[]} });
  vm.runInContext(source, context);
  return {
    ids, audio, screen, caption, preference, document, window, scenes: window.AlleyStory.scenes,
    click(id) { if (!ids[id].disabled) return ids[id].handlers.click(); },
    advance(ms) { now += ms; const callbacks = [...pending.values()]; pending.clear(); callbacks.forEach(fn => fn(now)); },
    go(index) { const current = Number(ids.counter.textContent.match(/\d+/)[0]) - 1; for (let i = current; i < index; i++) this.click('next'); for (let i = current; i > index; i--) this.click('back'); },
    get scheduled() { return pending.size; }
  };
}

function scale(p) { return Number(p.ids.frame.style.transform.match(/[\d.]+/)[0]); }

test('Пять утверждённых сцен: точные изображения, прежние тексты и немой финальный кадр', () => {
  const p = player();
  assert.deepEqual(Array.from(p.scenes, scene => scene.id), ['alley','panorama','hero','dasha','revelation']);
  assert.deepEqual(Array.from(p.scenes, scene => scene.duration), [16000,35000,10000,12000,8000]);
  assert.deepEqual(Array.from(p.scenes[0].phrases, item => item.text), intro);
  assert.equal(p.scenes[2].text, hero);
  assert.deepEqual(Array.from(p.scenes[3].phrases, item => item.text), dasha);
  assert.deepEqual(Array.from(p.scenes, scene => scene.image), images);
  assert.equal('candidate' in p.scenes[1], false, 'Панорама уже утверждена');
  assert.deepEqual(Array.from(p.scenes, scene => scene.focus), ['50% 50%','50% 50%','55% 35%','50% 60%','50% 35%']);
  assert.equal(p.scenes[1].audio.voice.src, 'assets/audio/Pereulok_voice_natural_v2.mp3');
  assert.deepEqual(Array.from(p.scenes, scene => scene.audio.voice?.src ?? null), [null,'assets/audio/Pereulok_voice_natural_v2.mp3',null,null,null]);
  for (const index of [0, 2, 3, 4]) assert.equal(p.scenes[index].audio.voice, null, `У сцены ${index + 1} нет добавленного голоса`);
  assert.equal(p.scenes[4].speaker, '');
  assert.equal(p.scenes[4].text, '');
  assert.equal(p.scenes[4].phrases, undefined);
  assert.deepEqual(p.scenes[4].audio.beds, p.scenes[2].audio.beds);
  assert.equal(p.scenes[4].audio.effects.length, 0);
  assert.equal(p.ids.progress.children.length, 5);
  assert.equal(p.ids.counter.textContent, 'КАДР 1 / 5');
  assert.equal(p.audio.events.length, 0, 'До действия пользователя нет аудиозагрузки и запуска');
});

test('Прогресс и счётчик следуют конфигурации, а не фиксированному числу кадров', () => {
  const p = player({extraScene:true});
  assert.equal(p.ids.progress.children.length, 6);
  assert.equal(p.ids.counter.textContent, 'КАДР 1 / 6');
  p.go(5);
  assert.equal(p.ids.counter.textContent, 'КАДР 6 / 6');
  assert.equal(p.ids.next.disabled, true);
});

test('Кино без MP3: все пять сцен 16 → 35 → 10 → 12 → 8 с, crossfade и перезапуск', async () => {
  const p = player();
  await p.click('start');
  p.advance(15999); assert.equal(p.ids.counter.textContent, 'КАДР 1 / 5');
  p.advance(1); assert.equal(p.ids.counter.textContent, 'КАДР 2 / 5');
  assert.equal(p.ids.dialogue.textContent, '');
  p.advance(35000); assert.equal(p.ids.counter.textContent, 'КАДР 3 / 5');
  p.advance(10000); assert.equal(p.ids.counter.textContent, 'КАДР 4 / 5');
  p.advance(11999); assert.equal(p.ids.dialogue.textContent, dasha[3]);
  p.advance(1); assert.equal(p.ids.counter.textContent, 'КАДР 5 / 5');
  assert.equal(p.ids.frame.src, images[4]);
  assert.equal(p.ids.dialogue.textContent, '');
  assert.equal(p.ids.speaker.textContent, '');
  assert.equal(p.ids['accessible-dialogue'].textContent, '');
  assert.equal(p.caption.classList.contains('is-empty'), true);
  assert.equal(p.ids.next.disabled, true);
  assert.equal(p.audio.playing, true);
  p.advance(7999); assert.equal(p.ids.status.textContent, 'Идёт показ');
  p.advance(1);
  assert.equal(p.ids.status.textContent, 'Конец демонстрации');
  assert.equal(p.ids.dialogue.textContent, '');
  assert.equal(p.ids.start.textContent, 'Сначала ↻');
  assert.equal(p.scheduled, 0); assert.equal(p.audio.playing, false);
  const transitions = p.audio.events.filter(e => e.type === 'play');
  assert.deepEqual(transitions.map(e => [e.id,e.crossfade]), [['alley',false],['panorama',true],['hero',true],['dasha',true],['revelation',true]]);
  await p.click('start'); assert.equal(p.ids.counter.textContent, 'КАДР 1 / 5');
  assert.equal(p.ids.frame.src, images[0]);
  assert.deepEqual(p.ids.progress.children.map(bar => bar.classList.contains('seen')), [true,false,false,false,false]);
  assert.equal(p.screen.classList.contains('image-only'), true);
  assert.equal(p.ids.dialogue.textContent, '');
});

test('Вступление: первая секунда только фото, фразы и паузы остались прежними', async () => {
  const p = player(); await p.click('start');
  p.advance(999); assert.equal(p.ids.dialogue.textContent, ''); assert.equal(p.screen.classList.contains('image-only'), true);
  p.advance(1); assert.equal(p.ids.dialogue.textContent, ''); assert.equal(p.screen.classList.contains('image-only'), false);
  assert.equal(p.ids['accessible-dialogue'].textContent, intro[0]);
  p.advance(500); assert.ok(intro[0].startsWith(p.ids.dialogue.textContent)); assert.ok(p.ids.dialogue.textContent.length > 0);
  p.advance(1500); assert.equal(p.ids.dialogue.textContent, intro[0]);
  p.advance(1250); assert.equal(p.ids.dialogue.textContent, '');
  p.advance(1750); assert.equal(p.ids.dialogue.textContent, intro[1]);
  p.advance(2000); assert.ok(Math.abs(scale(p) - 1.01) < 1e-9);
  p.advance(1500); assert.equal(p.ids.dialogue.textContent, intro[2]);
  p.advance(4000); assert.equal(p.ids.dialogue.textContent, intro[3]);
});

test('Герой остаётся отдельным третьим кадром: новая камера, задержка 2 с и прежняя реплика', async () => {
  const p = player(); p.go(2); await p.click('start');
  assert.equal(scale(p), 1);
  assert.equal(p.ids.frame.style.transformOrigin, '55% 35%');
  p.advance(1999); assert.equal(p.ids.dialogue.textContent, '');
  p.advance(2); assert.ok(p.ids.dialogue.textContent.length > 0); assert.equal(p.ids['accessible-dialogue'].textContent, hero);
  p.advance(2999); assert.equal(scale(p), 1.01);
  p.advance(1000); assert.equal(p.ids.dialogue.textContent, hero);
  p.advance(4000); assert.equal(p.ids.counter.textContent, 'КАДР 4 / 5');
});

test('Панорама с длинной записью: длительность берётся от полного голоса и запаса', async () => {
  const p = player({voiceSeconds:40}); p.go(1); await p.click('start');
  assert.ok(p.ids.hint.textContent.includes('2 — 43.5 с'));
  p.advance(35000); assert.equal(p.ids.counter.textContent, 'КАДР 2 / 5');
  p.advance(8499); assert.equal(p.ids.counter.textContent, 'КАДР 2 / 5');
  p.advance(1); assert.equal(p.ids.counter.textContent, 'КАДР 3 / 5');
});

test('Подготовка записи завершается до старта общей шкалы времени', async () => {
  const task = deferred(); const p = player({voiceSeconds:45, preparation:task.promise}); p.go(1);
  const start = p.click('start');
  assert.equal(p.ids.status.textContent, 'Подготовка звука…');
  p.advance(100000); assert.equal(p.scheduled, 0); assert.notEqual(p.audio.playing, true);
  task.resolve(); await start;
  assert.ok(p.ids.hint.textContent.includes('48.5 с')); assert.equal(p.scheduled, 1);
  assert.equal(p.audio.events.find(e => e.type === 'play').elapsed, 0);
});

test('Навигация и Комикс во время async загрузки не запускают запоздалую озвучку', async () => {
  for (const action of ['next','comic','start']) {
    const task = deferred(); const p = player({preparation:task.promise});
    const start = p.click('start'); await p.click(action); task.resolve(); await start;
    assert.equal(p.audio.events.filter(e => e.type === 'play').length, 0, action);
    assert.equal(p.scheduled, 0);
  }
});

test('Пауза хранит позицию панорамы; продолжение синхронно получает тот же elapsed', async () => {
  const p = player({voiceSeconds:40}); p.go(1); await p.click('start'); p.advance(12500); await p.click('start');
  const frozen = p.ids.frame.style.transform; p.advance(30000);
  assert.equal(p.ids.frame.style.transform, frozen); assert.equal(p.audio.playing, false); assert.equal(p.scheduled, 0);
  await p.click('start');
  assert.equal(p.audio.events.filter(e => e.type === 'play').at(-1).elapsed, 12500);
  p.advance(30999); assert.equal(p.ids.counter.textContent, 'КАДР 2 / 5');
  p.advance(1); assert.equal(p.ids.counter.textContent, 'КАДР 3 / 5');
});

test('Комикс сразу показывает все утверждённые подписи и никогда не запускает звук', async () => {
  const p = player(); await p.click('comic');
  assert.equal(p.ids.dialogue.textContent, intro.join('\n\n')); assert.equal(p.ids.start.hidden, true);
  p.go(1); assert.equal(p.ids.dialogue.textContent, '');
  p.go(2); assert.equal(p.ids.dialogue.textContent, hero);
  p.go(3); assert.equal(p.ids.dialogue.textContent, dasha.join('\n\n'));
  p.go(4);
  assert.equal(p.ids.dialogue.textContent, '');
  assert.equal(p.ids.speaker.textContent, '');
  assert.equal(p.ids['accessible-dialogue'].textContent, '');
  assert.equal(p.caption.classList.contains('is-empty'), true);
  assert.equal(p.ids.start.hidden, true);
  p.advance(100000); assert.equal(p.ids.counter.textContent, 'КАДР 5 / 5');
  assert.equal(p.audio.events.some(e => e.type === 'play'), false);
  await p.click('cinema'); assert.equal(p.ids.counter.textContent, 'КАДР 5 / 5'); assert.equal(p.scheduled, 0);
  assert.equal(p.ids.start.textContent, 'Продолжить ▶');
});

test('Даша: все прежние фразы и пауза, переход на пятую сцену ровно через 12 с', async () => {
  const p = player(); p.go(3); assert.equal(p.ids.start.textContent, 'Продолжить ▶'); await p.click('start');
  assert.equal(scale(p), 1); p.advance(1500); assert.equal(p.ids.dialogue.textContent, dasha[0]);
  p.advance(1100); assert.equal(p.ids.dialogue.textContent, '');
  p.advance(1800); assert.equal(p.ids.dialogue.textContent, dasha[1]);
  p.advance(1600); assert.ok(Math.abs(scale(p) - 1.01) < 1e-9);
  await p.click('start'); const text = p.ids.dialogue.textContent, zoom = p.ids.frame.style.transform;
  p.advance(20000); assert.equal(p.ids.dialogue.textContent, text); assert.equal(p.ids.frame.style.transform, zoom);
  await p.click('start'); p.advance(2000); assert.equal(p.ids.dialogue.textContent, dasha[2]);
  p.advance(2600); assert.equal(p.ids.dialogue.textContent, dasha[3]);
  p.advance(1399); assert.equal(p.ids.counter.textContent, 'КАДР 4 / 5');
  assert.equal(p.ids.dialogue.textContent, dasha[3]);
  assert.equal(p.ids.start.textContent, 'Пауза Ⅱ'); assert.equal(p.audio.playing, true);
  p.advance(1); assert.equal(p.ids.counter.textContent, 'КАДР 5 / 5');
  assert.equal(p.ids.dialogue.textContent, '');
  assert.equal(p.ids.start.textContent, 'Пауза Ⅱ'); assert.equal(p.audio.playing, true);
  p.advance(8000); assert.equal(p.ids.start.textContent, 'Сначала ↻'); assert.equal(p.audio.playing, false);
});

test('Немая пятая сцена: пауза хранит камеру и позицию, продолжение завершает ровно 8 с', async () => {
  const p = player(); p.go(4);
  assert.equal(p.ids.start.textContent, 'Продолжить ▶');
  assert.equal(p.ids.next.disabled, true); assert.equal(p.ids.back.disabled, false);
  await p.click('start'); p.advance(3000);
  assert.equal(p.ids.dialogue.textContent, ''); assert.equal(p.ids.speaker.textContent, '');
  assert.equal(p.ids['accessible-dialogue'].textContent, ''); assert.equal(p.caption.classList.contains('is-empty'), true);
  await p.click('start'); const frozen = p.ids.frame.style.transform;
  p.advance(20000);
  assert.equal(p.ids.frame.style.transform, frozen); assert.equal(p.scheduled, 0); assert.equal(p.audio.playing, false);
  assert.equal(p.ids.start.textContent, 'Продолжить ▶');
  await p.click('start');
  assert.deepEqual(p.audio.events.filter(event => event.type === 'play').map(event => [event.id, event.elapsed]), [['revelation',0],['revelation',3000]]);
  p.advance(4999); assert.equal(p.ids.status.textContent, 'Идёт показ');
  p.advance(1); assert.equal(p.ids.counter.textContent, 'КАДР 5 / 5');
  assert.equal(p.ids.status.textContent, 'Конец демонстрации'); assert.equal(p.ids.start.textContent, 'Сначала ↻');
  assert.equal(scale(p), 1.02); assert.equal(p.audio.playing, false); assert.equal(p.scheduled, 0);
  assert.equal(p.ids.dialogue.textContent, ''); assert.equal(p.ids['accessible-dialogue'].textContent, '');
  await p.click('start'); assert.equal(p.ids.counter.textContent, 'КАДР 1 / 5');
  assert.equal(scale(p), 1); assert.equal(p.ids.frame.src, images[0]);
  assert.equal(p.audio.events.filter(event => event.type === 'play').at(-1).elapsed, 0);
});

test('Камера всех сцен плавно проходит 100–102%, панорама движется обратно по полной длительности голоса', async () => {
  for (let index = 0; index < 5; index += 1) {
    const p = player({voiceSeconds:40}); p.go(index); await p.click('start');
    const duration = index === 1 ? 43500 : [16000,35000,10000,12000,8000][index];
    const expected = index === 1 ? [1.02,1.016875,1.01,1.003125] : [1,1.003125,1.01,1.016875];
    const samples = [scale(p)];
    for (let quarter = 1; quarter <= 3; quarter += 1) {
      p.advance(duration / 4);
      samples.push(scale(p));
    }
    samples.forEach((value, quarter) => {
      assert.ok(Math.abs(value - expected[quarter]) < 1e-10, `Сцена ${index + 1}, четверть ${quarter}: ${value}`);
      assert.ok(value >= 1 && value <= 1.02, `Сцена ${index + 1}: масштаб ${value} не создаёт поля`);
    });
    p.advance(duration / 4 - 1);
    assert.equal(p.ids.counter.textContent, `КАДР ${index + 1} / 5`);
    assert.ok(Math.abs(scale(p) - (index === 1 ? 1 : 1.02)) < 1e-8);
    assert.equal(p.ids.frame.style.transformOrigin, p.scenes[index].focus);
    assert.equal(p.ids.frame.style.objectPosition, p.scenes[index].focus);
  }
});

test('Камера не допускает масштаб ниже 100% даже при прежних или убывающих настройках', async () => {
  for (const [index, zoom] of [[0,{start:.8,delta:.02}],[1,{start:1.02,delta:-.5}]]) {
    const p = player(); p.scenes[index].zoom = zoom; p.go(index); await p.click('start');
    assert.ok(scale(p) >= 1);
    p.advance(p.scenes[index].duration / 2);
    assert.equal(scale(p), 1);
  }
});

test('Комикс отключает камеру всех пяти сцен, смена reduced motion не меняет транспорт', async () => {
  const p = player(); await p.click('comic');
  for (let index = 0; index < 5; index += 1) {
    p.go(index); assert.equal(p.ids.frame.style.transform, '');
  }
  p.go(2); await p.click('cinema'); await p.click('start'); p.advance(2500);
  const plays = p.audio.events.filter(event => event.type === 'play').length;
  p.preference.matches = true; p.preference.change();
  assert.equal(p.ids.frame.style.transform, ''); assert.equal(p.scheduled, 1); assert.equal(p.audio.playing, true);
  p.advance(1000); assert.ok(hero.startsWith(p.ids.dialogue.textContent));
  p.preference.matches = false; p.preference.change();
  assert.ok(scale(p) > 1 && scale(p) < 1.02);
  assert.equal(p.audio.events.filter(event => event.type === 'play').length, plays);
  assert.equal(p.scheduled, 1); assert.equal(p.audio.playing, true);
});

test('Уход со вкладки, pagehide и прерывание AudioContext ставят показ и звук на паузу', async () => {
  for (const action of ['hidden','pagehide','interrupted']) {
    const p = player(); await p.click('start'); p.advance(2500);
    if (action === 'hidden') { p.document.hidden = true; p.document.handlers.visibilitychange(); }
    if (action === 'pagehide') p.window.handlers.pagehide();
    if (action === 'interrupted') p.audio.onStatus({message:'Звук прерван',contextState:'interrupted'});
    assert.equal(p.audio.playing, false, action); assert.equal(p.scheduled, 0);
    p.advance(30000); assert.equal(p.ids.counter.textContent, 'КАДР 1 / 5');
  }
});

test('Ручная навигация останавливает старые источники, уровни каналов управляются отдельно', async () => {
  const p = player(); await p.click('start'); await p.click('next');
  const events = p.audio.events;
  assert.equal(events.at(-2).type, 'stop'); assert.equal(events.at(-1).id, 'panorama'); assert.equal(events.at(-1).crossfade, false);
  const input = p.ids['volume-music']; input.value = '.08'; input.handlers.input();
  assert.deepEqual(events.at(-1), {type:'volume',channel:'music',value:.08});
  await p.click('comic'); assert.equal(p.audio.playing, false); assert.equal(p.scheduled, 0);
});

test('Уменьшение движения отключает zoom, сохраняя подписи', async () => {
  const p = player({reducedMotion:true}); await p.click('start'); p.advance(3000);
  assert.equal(p.ids.frame.style.transform, ''); assert.equal(p.ids.dialogue.textContent, intro[0]);
  p.go(2); p.advance(6000); assert.equal(p.ids.dialogue.textContent, hero); assert.equal(p.ids.frame.style.transform, '');
});

test('Блокировка браузером готового голоса оставляет панораму на паузе до повторного клика', async () => {
  const p = player({voiceSeconds:40, blockedVoice:true}); p.go(1); await p.click('start');
  assert.equal(p.scheduled, 0); assert.equal(p.audio.playing, false);
  assert.ok(p.ids['audio-status'].textContent.includes('Браузер не запустил звук'));
  p.advance(50000); assert.equal(p.ids.counter.textContent, 'КАДР 2 / 5');
  p.audio.blocked = false; await p.click('start');
  assert.equal(p.scheduled, 1); assert.equal(p.audio.playing, true);
});
