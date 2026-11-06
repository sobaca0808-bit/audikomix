const story = window.AlleyStory;
const frames = story.scenes;
let current = 0;
let mode = 'cinema';
let playing = false;
let timer = null;
let elapsed = 0;
let startedAt = 0;
let starting = false;
let startVersion = 0;
let imageVersion = 0;
let imageAnimations = [];
const element = id => document.getElementById(id);
const screen = document.querySelector('.screen');
const caption = document.querySelector('.caption');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const audio = new window.AlleyAudio(story.audio, { onStatus: updateAudioStatus });
const filmGrade = window.AlleyFilmGrade?.create({ document });
const progress = element('progress');
const bars = frames.map(() => {
  const bar = document.createElement('span');
  progress.appendChild(bar);
  return bar;
});

function durationFor(frame) {
  return audio.durationFor(frame);
}

function updateAudioStatus(info) {
  const noBeds = Object.values(story.audio.beds).every(track => !track.src);
  element('audio-status').textContent = info.message + (noBeds ? ' Фоновые звуки ещё не добавлены.' : '');
  if (playing && ['suspended', 'interrupted', 'closed'].includes(info.contextState)) pausePlayback();
}

function playAudio(crossfade = false) {
  if (audio.play(frames[current], elapsed, { crossfade }) === false && audio.getStatus().voice === 'ready') {
    playing = false;
    stopTimer();
    audio.pause();
    element('audio-status').textContent = 'Браузер не запустил звук. Нажмите «Продолжить», чтобы включить утверждённую запись.';
    return false;
  }
  return true;
}


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
  // Прежний тайминг одиночной реплики героя.
  const visible = Boolean(frame.text) && (reading || !frame.textDelay || elapsed >= frame.textDelay);
  const fraction = reading || !frame.textDuration ? 1 : Math.max(0, Math.min(1, (elapsed - frame.textDelay) / frame.textDuration));
  const text = visible ? frame.text.slice(0, Math.ceil(frame.text.length * fraction)) : '';
  return { visible, text, accessibleText: visible ? frame.text : '' };
}

function renderScene() {
  const frame = frames[current];
  const reading = mode === 'comic';
  const { visible, text, accessibleText } = sceneCaption(frame, reading);
  screen.classList.toggle('image-only', Boolean(frame.layout === 'alley' && !reading && elapsed < 1000));
  caption.classList.toggle('is-empty', !visible);
  const speaker = visible ? frame.speaker : '';
  if (element('speaker').textContent !== speaker) element('speaker').textContent = speaker;
  if (element('dialogue').textContent !== text) element('dialogue').textContent = text;
  // Скринридер получает целую реплику один раз, без объявления каждой буквы.
  if (element('accessible-dialogue').textContent !== accessibleText) element('accessible-dialogue').textContent = accessibleText;
  if (frame.zoom && !reading && !reducedMotion.matches) {
    // Двигается только фото внутри неподвижного окна; масштаб не открывает поля.
    // Одна шкала времени сохраняет синхронную паузу текста, камеры и звука.
    const progress = Math.max(0, Math.min(1, elapsed / durationFor(frame)));
    const eased = progress * progress * (3 - 2 * progress);
    const start = frame.zoom.start ?? 1;
    const delta = frame.zoom.delta ?? 0.02;
    const scale = Math.max(1, Math.min(1.04, start + delta * eased));
    element('frame').style.transform = `scale(${scale})`;
  } else {
    element('frame').style.transform = '';
  }
}

function tick(now) {
  if (!playing || mode !== 'cinema') return;
  elapsed = Math.min(durationFor(frames[current]), Math.max(0, now - startedAt));
  audio.tick(elapsed);
  renderScene();
  if (elapsed >= durationFor(frames[current])) {
    if (current < frames.length - 1) {
      current += 1;
      elapsed = 0;
      startedAt = now;
      playAudio(true);
      render();
    } else {
      playing = false;
      timer = null;
      audio.stop();
      render();
      return;
    }
  }
  timer = playing ? requestAnimationFrame(tick) : null;
}

function scheduleNext() {
  stopTimer();
  if (!playing || mode !== 'cinema') return;
  startedAt = performance.now() - elapsed;
  timer = requestAnimationFrame(tick);
}

function atEnd() {
  return current === frames.length - 1 && elapsed >= durationFor(frames[current]);
}

function clearImageTransition() {
  imageAnimations.forEach(animation => animation.cancel());
  imageAnimations = [];
  element('frame').style.opacity = '1';
  const previous = element('previous-frame');
  if (previous) {
    previous.hidden = true;
    if (previous.replaceChildren) previous.replaceChildren();
  }
}

function showFrameImage(frame) {
  const image = element('frame');
  if (image.getAttribute('src') === frame.image) return;
  const version = ++imageVersion;
  const previous = element('previous-frame');
  const canFade = previous && image.animate && image.decode && !reducedMotion.matches;
  const currentReady = canFade && image.complete && image.naturalWidth;
  const snapshot = currentReady ? image.cloneNode(true)
    : canFade && previous.firstElementChild ? previous.firstElementChild.cloneNode(true) : null;
  if (snapshot) {
    snapshot.removeAttribute('id');
    snapshot.alt = '';
    snapshot.style.opacity = '1';
    if (currentReady) snapshot.style.transformOrigin = window.getComputedStyle(image).transformOrigin;
  }
  clearImageTransition();
  if (snapshot) {
    previous.replaceChildren(snapshot);
    previous.hidden = false;
  }
  image.src = frame.image;
  image.alt = frame.alt;
  caption.scrollTop = 0;
  if (!canFade) return;
  image.style.opacity = '0';
  image.decode().catch(() => {}).then(() => {
    if (version !== imageVersion) return;
    if (reducedMotion.matches) { clearImageTransition(); return; }
    const options = { duration: 200, easing: 'ease-in-out', fill: 'forwards' };
    const incoming = image.animate([{ opacity: 0 }, { opacity: 1 }], options);
    imageAnimations = [incoming];
    if (snapshot) {
      const outgoing = previous.animate([{ opacity: 1 }, { opacity: 0 }], options);
      outgoing.finished.catch(() => {});
      imageAnimations.push(outgoing);
    }
    incoming.finished.then(() => {
      if (version === imageVersion) clearImageTransition();
    }).catch(() => {});
  });
}

function render() {
  const frame = frames[current];
  showFrameImage(frame);
  // Снимок уходящей сцены уже сохранил свой центр и масштаб.
  element('frame').style.transformOrigin = frame.focus || '50% 50%';
  element('frame').style.objectPosition = frame.focus || '50% 50%';
  // Снимок предыдущего кадра уже создан со своим профилем; новый получает свой.
  filmGrade?.apply(element('frame'), frame.id);
  element('frame').classList.toggle('grade-pending', false);
  element('frame').alt = frame.alt;
  screen.classList.toggle('photo-frame', frame.zoom === true);
  screen.classList.toggle('alley-frame', frame.layout === 'alley');
  screen.classList.toggle('panorama-frame', frame.layout === 'panorama');
  screen.style.setProperty('--scene-image', `url(${JSON.stringify(frame.image)})`);
  screen.classList.toggle('dasha-frame', frame.layout === 'dasha');
  screen.classList.toggle('reading', mode === 'comic');
  renderScene();
  element('counter').textContent = `КАДР ${current + 1} / ${frames.length}`;
  element('back').disabled = current === 0;
  element('next').disabled = current === frames.length - 1;
  element('start').textContent = starting ? 'Отменить загрузку' : playing ? 'Пауза Ⅱ' : atEnd() ? 'Сначала ↻' : current === 0 ? 'Начать ▶' : 'Продолжить ▶';
  element('start').hidden = mode === 'comic';
  element('cinema').setAttribute('aria-pressed', String(mode === 'cinema'));
  element('comic').setAttribute('aria-pressed', String(mode === 'comic'));
  element('status').textContent = mode === 'comic' ? 'Ручное переключение' : starting ? 'Подготовка звука…' : playing ? 'Идёт показ' : atEnd() ? 'Конец демонстрации' : 'Показ остановлен';
  element('hint').textContent = mode === 'cinema' ? 'В режиме «Кино»: ' + frames.map((item, index) => `${index + 1} — ${Number((durationFor(item) / 1000).toFixed(2))} с`).join('; ') + '.' : 'В режиме «Комикс» переключайте кадры кнопками «Назад» и «Вперёд».';
  bars.forEach((bar, index) => bar.classList.toggle('seen', index <= current));
}

function cancelStart() {
  startVersion += 1;
  starting = false;
}

function pausePlayback() {
  if (playing) elapsed = Math.min(durationFor(frames[current]), Math.max(0, performance.now() - startedAt));
  playing = false;
  cancelStart();
  stopTimer();
  audio.pause();
  render();
}

function move(direction) {
  const resume = playing;
  cancelStart();
  stopTimer();
  audio.stop();
  current = Math.max(0, Math.min(frames.length - 1, current + direction));
  elapsed = 0;
  playing = resume && mode === 'cinema';
  if (playing) playAudio();
  render();
  scheduleNext();
}

function setMode(value) {
  mode = value;
  playing = false;
  elapsed = 0;
  cancelStart();
  stopTimer();
  audio.stop();
  caption.scrollTop = 0;
  render();
}

element('start').addEventListener('click', async () => {
  if (playing || starting) {
    pausePlayback();
    return;
  }
  if (atEnd()) {
    current = 0;
    elapsed = 0;
  }
  const version = ++startVersion;
  starting = true;
  render();
  try {
    // Создание/разблокировка AudioContext происходит внутри действия пользователя.
    // Вся запись декодируется до запуска таймера: фразы не обрываются из-за загрузки.
    await audio.prepare(frames);
  } catch {
    element('audio-status').textContent = 'Звук недоступен. Показ продолжится без звука.';
  }
  if (version !== startVersion || mode !== 'cinema' || document.hidden) {
    if (version === startVersion) {
      starting = false;
      audio.pause();
      render();
    }
    return;
  }
  starting = false;
  playing = true;
  playAudio();
  scheduleNext();
  render();
});
element('back').addEventListener('click', () => move(-1));
element('next').addEventListener('click', () => move(1));
element('cinema').addEventListener('click', () => setMode('cinema'));
element('comic').addEventListener('click', () => setMode('comic'));
for (const [channel, volume] of Object.entries(story.audio.volumes)) {
  const input = element('volume-' + channel);
  input.value = String(volume);
  input.addEventListener('input', () => audio.setVolume(channel, Number(input.value)));
}
if (filmGrade) {
  const pictureFields = ['brightness', 'contrast', 'saturation'];
  const syncPictureControls = () => {
    const settings = filmGrade.getSettings();
    const original = settings.look === 'original';
    element('look-original').setAttribute('aria-pressed', String(original));
    element('look-cinema').setAttribute('aria-pressed', String(!original));
    element('picture-look-name').textContent = original ? 'Оригинал' : 'Кино';
    for (const field of pictureFields) {
      const input = element('picture-' + field);
      input.value = String(settings[field]);
      input.disabled = original;
      input.setAttribute('aria-valuetext', settings[field] + '%');
      element('picture-' + field + '-value').textContent = settings[field] + '%';
    }
  };
  for (const look of ['original', 'cinema']) {
    element('look-' + look).addEventListener('click', () => {
      filmGrade.set({ look });
      syncPictureControls();
    });
  }
  for (const field of pictureFields) {
    const input = element('picture-' + field);
    input.addEventListener('input', () => {
      filmGrade.set({ [field]: input.value });
      syncPictureControls();
    });
  }
  element('picture-reset').addEventListener('click', () => {
    filmGrade.reset();
    syncPictureControls();
  });
  syncPictureControls();
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) pausePlayback();
});
window.addEventListener('pagehide', pausePlayback);
reducedMotion.addEventListener('change', () => {
  if (reducedMotion.matches) { imageVersion += 1; clearImageTransition(); }
  renderScene();
});
render();
