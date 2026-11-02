// Здесь хранится история: картинка, подпись и длительность каждого кадра.
// Поля audio оставлены для будущих файлов озвучки, музыки и эффектов.
const frames = [
  {
    image: 'assets/frame-01-alley.webp',
    alt: 'Ночной переулок с фонарями и входом в бар',
    speaker: 'РАССКАЗЧИК',
    duration: 16000,
    phrases: [
      { text: '1932 год… В этом городе даже тишина работала на мафию.', start: 1000, typing: 2000, end: 4250 },
      { text: 'У каждого здесь были свои секреты.', start: 4500, typing: 1500, end: 7250 },
      { text: 'А дурные новости приходили без приглашения…', start: 7500, typing: 2000, end: 10750 },
      { text: 'И что особенно обидно — за них ещё приходилось платить.', start: 11000, typing: 2500, end: 16000 }
    ],
    zoom: { start: 0.9, delta: 0.1 },
    audio: { voice: null, music: null, effects: [] }
  },
  {
    image: 'assets/frame-02-bar.webp',
    alt: 'Мужчина с сигаретой за столиком в джаз-баре тридцатых годов',
    speaker: 'РАССКАЗЧИК',
    text: 'Люблю тихие вечера. Особенно когда никто не пытается меня убить',
    duration: 10000,
    textDelay: 2000,
    textDuration: 4000,
    zoom: true,
    audio: { voice: null, music: null, effects: [] }
  },
  {
    image: 'assets/Газетчица Даша у двери бара.png',
    alt: 'Газетчица Даша у двери бара с газетой «Переулок» в протянутой руке',
    speaker: 'ДАША',
    duration: 12000,
    layout: 'dasha',
    phrases: [
      { text: 'Свежий „Переулок“!', start: 0, typing: 1200, end: 2500 },
      { text: 'Дерзкое ограбление банка!', start: 2700, typing: 1500, end: 5200 },
      { text: 'Главный подозреваемый — на первой полосе!', start: 5400, typing: 2200, end: 9200 },
      { text: 'Газеты, господа, газеты!', start: 9400, typing: 1200, end: 12000 }
    ],
    holdLastPhrase: true,
    zoom: { start: 0.9, delta: 0.1 },
    audio: { voice: null, music: null, effects: [] }
  }
];
let current = 0;
let mode = 'cinema';
let playing = false;
let timer = null;
let elapsed = 0;
let startedAt = 0;
const element = id => document.getElementById(id);
const screen = document.querySelector('.screen');
const caption = document.querySelector('.caption');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

function stopTimer() {
  cancelAnimationFrame(timer);
  timer = null;
}

function sceneCaption(frame, reading) {
  if (frame.phrases) {
    if (reading) {
      const text = frame.phrases.map(phrase => phrase.text).join('\n\n');
      return { visible: true, text, accessibleText: text };
    }
    const phrase = frame.phrases.find(item => elapsed >= item.start && elapsed < item.end)
      || (frame.holdLastPhrase && elapsed >= frame.duration ? frame.phrases.at(-1) : null);
    if (!phrase) return { visible: false, text: '', accessibleText: '' };
    const fraction = Math.max(0, Math.min(1, (elapsed - phrase.start) / phrase.typing));
    return {
      visible: true,
      text: phrase.text.slice(0, Math.ceil(phrase.text.length * fraction)),
      accessibleText: phrase.text
    };
  }
  // Прежний тайминг одиночной реплики второго кадра.
  const visible = reading || !frame.textDelay || elapsed >= frame.textDelay;
  const fraction = reading || !frame.textDuration ? 1 : Math.max(0, Math.min(1, (elapsed - frame.textDelay) / frame.textDuration));
  const text = visible ? frame.text.slice(0, Math.ceil(frame.text.length * fraction)) : '';
  return { visible, text, accessibleText: visible ? frame.text : '' };
}

function renderScene() {
  const frame = frames[current];
  const reading = mode === 'comic';
  const { visible, text, accessibleText } = sceneCaption(frame, reading);
  screen.classList.toggle('image-only', Boolean(frame.phrases && frame.layout !== 'dasha' && !reading && elapsed < 1000));
  caption.classList.toggle('is-empty', !visible);
  const speaker = visible ? frame.speaker : '';
  if (element('speaker').textContent !== speaker) element('speaker').textContent = speaker;
  if (element('dialogue').textContent !== text) element('dialogue').textContent = text;
  // Скринридер получает целую реплику один раз, без объявления каждой буквы.
  if (element('accessible-dialogue').textContent !== accessibleText) element('accessible-dialogue').textContent = accessibleText;
  if (frame.zoom && !reading && !reducedMotion.matches) {
    // Одна шкала времени для текста и движения. У второго кадра прежние 80–100%.
    const progress = Math.min(1, elapsed / frame.duration);
    const eased = progress * progress * (3 - 2 * progress);
    const start = frame.zoom.start ?? 0.8;
    const delta = frame.zoom.delta ?? 0.2;
    element('frame').style.transform = `scale(${start + delta * eased})`;
  } else {
    element('frame').style.transform = '';
  }
}

function tick(now) {
  if (!playing || mode !== 'cinema') return;
  elapsed = Math.min(frames[current].duration, now - startedAt);
  renderScene();
  if (elapsed >= frames[current].duration) {
    if (current < frames.length - 1) {
      current += 1;
      elapsed = 0;
      startedAt = now;
      render();
    } else {
      playing = false;
      timer = null;
      render();
      return;
    }
  }
  timer = requestAnimationFrame(tick);
}

function scheduleNext() {
  stopTimer();
  if (!playing || mode !== 'cinema') return;
  startedAt = performance.now() - elapsed;
  timer = requestAnimationFrame(tick);
}

function atEnd() {
  return current === frames.length - 1 && elapsed >= frames[current].duration;
}

function render() {
  const frame = frames[current];
  if (element('frame').getAttribute('src') !== frame.image) element('frame').src = frame.image;
  element('frame').alt = frame.alt;
  screen.classList.toggle('photo-frame', frame.zoom === true);
  screen.classList.toggle('alley-frame', Boolean(frame.phrases) && frame.layout !== 'dasha');
  screen.classList.toggle('dasha-frame', frame.layout === 'dasha');
  screen.classList.toggle('reading', mode === 'comic');
  renderScene();
  element('counter').textContent = `КАДР ${current + 1} / ${frames.length}`;
  element('back').disabled = current === 0;
  element('next').disabled = current === frames.length - 1;
  element('start').textContent = playing ? 'Пауза Ⅱ' : atEnd() ? 'Сначала ↻' : current === 0 ? 'Начать ▶' : 'Продолжить ▶';
  element('start').hidden = mode === 'comic';
  element('cinema').setAttribute('aria-pressed', String(mode === 'cinema'));
  element('comic').setAttribute('aria-pressed', String(mode === 'comic'));
  element('status').textContent = mode === 'comic' ? 'Ручное переключение' : playing ? 'Идёт показ' : atEnd() ? 'Конец демонстрации' : 'Показ остановлен';
  element('hint').textContent = mode === 'cinema' ? 'В режиме «Кино»: первый кадр — 16 секунд, второй — 10, третий — 12.' : 'В режиме «Комикс» переключайте кадры кнопками «Назад» и «Вперёд».';
  document.querySelectorAll('.progress span').forEach((bar, index) => bar.classList.toggle('seen', index <= current));
}

function move(direction) {
  current = Math.max(0, Math.min(frames.length - 1, current + direction));
  elapsed = 0;
  render();
  scheduleNext();
}

function setMode(value) {
  mode = value;
  playing = false;
  elapsed = 0;
  stopTimer();
  render();
}

element('start').addEventListener('click', () => {
  if (playing) {
    elapsed = Math.min(frames[current].duration, performance.now() - startedAt);
    playing = false;
    stopTimer();
  } else {
    if (atEnd()) {
      current = 0;
      elapsed = 0;
    }
    playing = true;
    scheduleNext();
  }
  render();
});
element('back').addEventListener('click', () => move(-1));
element('next').addEventListener('click', () => move(1));
element('cinema').addEventListener('click', () => setMode('cinema'));
element('comic').addEventListener('click', () => setMode('comic'));
reducedMotion.addEventListener('change', renderScene);
render();
