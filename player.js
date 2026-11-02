// Здесь хранится история: картинка, подпись и длительность каждого кадра.
// Поля audio оставлены для будущих файлов озвучки, музыки и эффектов.
const frames = [
  { image: 'assets/frame-1.svg', alt: 'Ночной переулок под светом фонаря', speaker: 'РАССКАЗЧИК', text: 'В этом городе даже тишина работала на мафию.', duration: 6000, audio: { voice: null, music: null, effects: [] } },
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
  { image: 'assets/frame-3.svg', alt: 'Кочан капусты в открытом чемодане', speaker: 'ЛУИ', text: '— Конечно. А вот с помидорами вышла заминка…', duration: 6000, audio: { voice: null, music: null, effects: [] } }
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

function renderScene() {
  const frame = frames[current];
  const reading = mode === 'comic';
  const visible = reading || !frame.textDelay || elapsed >= frame.textDelay;
  const fraction = reading || !frame.textDuration ? 1 : Math.max(0, Math.min(1, (elapsed - frame.textDelay) / frame.textDuration));
  const text = visible ? frame.text.slice(0, Math.ceil(frame.text.length * fraction)) : '';
  caption.classList.toggle('is-empty', !visible);
  const speaker = visible ? frame.speaker : '';
  if (element('speaker').textContent !== speaker) element('speaker').textContent = speaker;
  if (element('dialogue').textContent !== text) element('dialogue').textContent = text;
  // Скринридер получает целую реплику один раз, без объявления каждой буквы.
  const accessibleText = visible ? frame.text : '';
  if (element('accessible-dialogue').textContent !== accessibleText) element('accessible-dialogue').textContent = accessibleText;
  if (frame.zoom && !reading && !reducedMotion.matches) {
    // Приближение от 96% до 100% сохраняет всё фото даже на узком экране.
    const progress = Math.min(1, elapsed / frame.duration);
    const eased = progress * progress * (3 - 2 * progress);
    element('frame').style.transform = `scale(${0.96 + 0.04 * eased})`;
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

function render() {
  const frame = frames[current];
  if (element('frame').getAttribute('src') !== frame.image) element('frame').src = frame.image;
  element('frame').alt = frame.alt;
  screen.classList.toggle('photo-frame', Boolean(frame.zoom));
  renderScene();
  element('counter').textContent = `КАДР ${current + 1} / ${frames.length}`;
  element('back').disabled = current === 0;
  element('next').disabled = current === frames.length - 1;
  element('start').textContent = playing ? 'Пауза Ⅱ' : current === frames.length - 1 ? 'Сначала ↻' : current === 0 ? 'Начать ▶' : 'Продолжить ▶';
  element('start').hidden = mode === 'comic';
  element('cinema').setAttribute('aria-pressed', String(mode === 'cinema'));
  element('comic').setAttribute('aria-pressed', String(mode === 'comic'));
  element('status').textContent = mode === 'comic' ? 'Ручное переключение' : playing ? 'Идёт показ' : current === frames.length - 1 ? 'Конец демонстрации' : 'Показ остановлен';
  element('hint').textContent = mode === 'cinema' ? 'В режиме «Кино» первый и третий кадры длятся 6 секунд, второй — 10 секунд.' : 'В режиме «Комикс» переключайте кадры кнопками «Назад» и «Вперёд».';
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
    if (current === frames.length - 1) {
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
