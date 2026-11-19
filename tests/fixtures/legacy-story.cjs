// Настройка истории: здесь меняются кадры, утверждённые реплики и звуковые материалы.
(function (root) {
  const audio = {
    crossfade: 2000, // Плавный переход улица ↔ бар, миллисекунды.
    volumes: { voice: 1, ambience: 0.35, music: 0.2, effects: 0.3 },
    duck: { ambience: 0.3, music: 0.2, effects: 0.4, attack: 400, release: 800 },
    // Добавляйте только свои/лицензированные локальные файлы. null = дорожки пока нет.
    // Один id в соседних сценах сохраняет одну непрерывную дорожку без дублей.
    beds: {
      rain: { src: null, channel: 'ambience', loop: true },
      room: { src: null, channel: 'ambience', loop: true },
      jazz: { src: null, channel: 'music', loop: true },
      dishes: { src: null, channel: 'effects', loop: true }
    }
  };
  const scenes = [
    {
      id: 'alley', title: 'Ночной переулок', layout: 'alley',
      image: 'assets/Дождливый переулок у бара «Переулок».png',
      alt: 'Дождливый ночной переулок: прохожие, автомобиль и освещённый вход в бар',
      speaker: 'РАССКАЗЧИК', duration: 16000,
      phrases: [
        { text: '1932 год… В этом городе даже тишина работала на мафию.', start: 1000, typing: 2000, end: 4250 },
        { text: 'У каждого здесь были свои секреты.', start: 4500, typing: 1500, end: 7250 },
        { text: 'А дурные новости приходили без приглашения…', start: 7500, typing: 2000, end: 10750 },
        { text: 'И что особенно обидно — за них ещё приходилось платить.', start: 11000, typing: 2500, end: 16000 }
      ],
      // Камера двигается внутри заполненного экрана; масштаб ниже 100% оставлял поля.
      zoom: { start: 1, delta: 0.02 }, focus: '50% 50%',
      audio: {
        voice: null,
        beds: [{ id: 'rain', gain: 1 }, { id: 'jazz', gain: 0.12 }],
        effects: [{ src: null, at: 4500, gain: 0.35 }] // Отдалённые шаги на улице.
      }
    },
    {
      id: 'panorama', title: 'Общая панорама бара', layout: 'panorama',
      image: 'assets/Сепийный джаз-бар «Переулок».png',
      alt: 'Общий план джаз-бара «Переулок»: музыканты, посетители и барная стойка',
      speaker: 'РАССКАЗЧИК', duration: 35000, // Резерв до подключения утверждённой записи голоса.
      phrases: [
        { text: 'В нашем городе каждый второй считает себя большим человеком…', start: 2000, typing: 3500, end: 8500 },
        { text: 'Особенно после третьего стакана…', start: 9000, typing: 2500, end: 15500 },
        { text: 'А я просто хотел спокойно посидеть.', start: 16000, typing: 2500, end: 23500 },
        { text: 'Как выяснилось, это была моя первая ошибка.', start: 24000, typing: 3000, end: 35000 }
      ],
      holdLastPhrase: true,
      zoom: { start: 1.02, delta: -0.02 }, focus: '50% 50%',
      audio: {
        // Только утверждённый второй дубль. Файл не ускоряется и не обрабатывается.
        voice: { src: 'assets/audio/Pereulok_voice_natural_v2.mp3', start: 2000, tail: 1500 },
        beds: [{ id: 'room', gain: 1 }, { id: 'dishes', gain: 0.7 }, { id: 'jazz', gain: 0.65 }],
        effects: []
      }
    },
    {
      id: 'hero', title: 'Герой в баре', layout: 'hero',
      image: 'assets/Сепия-нуар в баре с джазом.png',
      alt: 'Главный герой с сигаретой за столиком в тёплом свете джаз-бара',
      speaker: 'РАССКАЗЧИК',
      text: 'Люблю тихие вечера. Особенно когда никто не пытается меня убить',
      duration: 10000, textDelay: 2000, textDuration: 4000,
      zoom: { start: 1, delta: 0.02 }, focus: '55% 35%',
      audio: {
        voice: null,
        beds: [{ id: 'room', gain: 1 }, { id: 'dishes', gain: 0.7 }, { id: 'jazz', gain: 0.65 }],
        effects: []
      }
    },
    {
      id: 'dasha', title: 'Даша у двери бара', layout: 'dasha',
      image: 'assets/Газетчица у старого бара.png',
      alt: 'Газетчица Даша у двери бара с газетой «Переулок» в протянутой руке',
      speaker: 'ДАША', duration: 12000,
      phrases: [
        { text: 'Свежий „Переулок“!', start: 0, typing: 1200, end: 2500 },
        { text: 'Дерзкое ограбление банка!', start: 2700, typing: 1500, end: 5200 },
        { text: 'Главный подозреваемый — на первой полосе!', start: 5400, typing: 2200, end: 9200 },
        { text: 'Газеты, господа, газеты!', start: 9400, typing: 1200, end: 12000 }
      ],
      holdLastPhrase: true, zoom: { start: 1, delta: 0.02 }, focus: '50% 60%',
      audio: {
        voice: null, // Живой голос Даши автор добавит позже. Синтеза голоса нет.
        beds: [{ id: 'rain', gain: 1 }, { id: 'jazz', gain: 0.12 }],
        effects: [{ src: null, at: 2000, gain: 0.35 }]
      }
    },
    {
      id: 'revelation', title: 'Газетная сенсация в баре', layout: 'revelation',
      image: 'assets/Газетный заголовок в переулке.png',
      alt: 'Внутри бара Даша показывает герою газету «Переулок» с его фотографией',
      speaker: '', text: '',
      duration: 8000, // Настраиваемый резерв для новой немой сцены, пока автор не добавил текст и голос.
      zoom: { start: 1, delta: 0.02 }, focus: '50% 35%',
      audio: {
        voice: null, // Будущая запись: { src: 'assets/audio/имя-файла.mp3', start: 0, tail: 1500 }.
        beds: [{ id: 'room', gain: 1 }, { id: 'dishes', gain: 0.7 }, { id: 'jazz', gain: 0.65 }],
        effects: []
      }
    }
  ];
  root.AlleyStory = { audio, scenes };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.AlleyStory;
})(typeof window !== 'undefined' ? window : globalThis);
