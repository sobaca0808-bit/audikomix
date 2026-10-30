// Здесь хранится история: картинка, подпись и длительность каждого кадра.
// Поля audio оставлены для будущих файлов озвучки, музыки и эффектов.
const frames = [
  { image: 'assets/frame-1.svg', alt: 'Ночной переулок под светом фонаря', speaker: 'РАССКАЗЧИК', text: 'В этом городе даже тишина работала на мафию.', duration: 6000, audio: { voice: null, music: null, effects: [] } },
  { image: 'assets/frame-2.svg', alt: 'Два гангстера в шляпах встречаются в переулке', speaker: 'ТОНИ', text: '— Ты принёс капусту? Босс не любит ждать.', duration: 6000, audio: { voice: null, music: null, effects: [] } },
  { image: 'assets/frame-3.svg', alt: 'Кочан капусты в открытом чемодане', speaker: 'ЛУИ', text: '— Конечно. А вот с помидорами вышла заминка…', duration: 6000, audio: { voice: null, music: null, effects: [] } }
];
let current = 0;
let mode = 'cinema';
let playing = false;
let timer = null;
const element = id => document.getElementById(id);

function stopTimer() {
  clearTimeout(timer);
  timer = null;
}
function scheduleNext() {
  stopTimer();
  if (!playing || mode !== 'cinema') return;
  timer = setTimeout(() => {
    if (current < frames.length - 1) {
      current += 1;
      render();
      scheduleNext();
    } else {
      playing = false;
      render();
    }
  }, frames[current].duration);
}
function render() {
  const frame = frames[current];
  element('frame').src = frame.image;
  element('frame').alt = frame.alt;
  element('speaker').textContent = frame.speaker;
  element('dialogue').textContent = frame.text;
  element('counter').textContent = `КАДР ${current + 1} / ${frames.length}`;
  element('back').disabled = current === 0;
  element('next').disabled = current === frames.length - 1;
  element('start').textContent = playing ? 'Пауза Ⅱ' : current === frames.length - 1 ? 'Сначала ↻' : current === 0 ? 'Начать ▶' : 'Продолжить ▶';
  element('start').hidden = mode === 'comic';
  element('cinema').setAttribute('aria-pressed', String(mode === 'cinema'));
  element('comic').setAttribute('aria-pressed', String(mode === 'comic'));
  element('status').textContent = mode === 'comic' ? 'Ручное переключение' : playing ? 'Идёт показ' : current === frames.length - 1 ? 'Конец демонстрации' : 'Показ остановлен';
  element('hint').textContent = mode === 'cinema' ? 'В режиме «Кино» кадры меняются каждые 6 секунд после нажатия «Начать».' : 'В режиме «Комикс» переключайте кадры кнопками «Назад» и «Вперёд».';
  document.querySelectorAll('.progress span').forEach((bar, index) => bar.classList.toggle('seen', index <= current));
}
function move(direction) {
  current = Math.max(0, Math.min(frames.length - 1, current + direction));
  render();
  scheduleNext();
}
function setMode(value) {
  mode = value;
  playing = false;
  stopTimer();
  render();
}
element('start').addEventListener('click', () => {
  if (playing) {
    playing = false;
    stopTimer();
  } else {
    if (current === frames.length - 1) current = 0;
    playing = true;
    scheduleNext();
  }
  render();
});
element('back').addEventListener('click', () => move(-1));
element('next').addEventListener('click', () => move(1));
element('cinema').addEventListener('click', () => setMode('cinema'));
element('comic').addEventListener('click', () => setMode('comic'));
render();
