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
      image: 'assets/frame-01-alley.webp',
      alt: 'Ночной переулок с фонарями и входом в бар',
      speaker: 'РАССКАЗЧИК', duration: 16000,
      phrases: [
        { text: '1932 год… В этом городе даже тишина работала на мафию.', start: 1000, typing: 2000, end: 4250 },
        { text: 'У каждого здесь были свои секреты.', start: 4500, typing: 1500, end: 7250 },
        { text: 'А дурные новости приходили без приглашения…', start: 7500, typing: 2000, end: 10750 },
        { text: 'И что особенно обидно — за них ещё приходилось платить.', start: 11000, typing: 2500, end: 16000 }
      ],
      zoom: { start: 0.9, delta: 0.1 },
      audio: {
        voice: null,
        beds: [{ id: 'rain', gain: 1 }, { id: 'jazz', gain: 0.12 }],
        effects: [{ src: null, at: 4500, gain: 0.35 }] // Отдалённые шаги на улице.
      }
    },
    {
      id: 'panorama', title: 'Общая панорама бара', layout: 'panorama', candidate: true,
      // Кандидат: окончательное изображение проверяет автор. Замените только этот путь.
      image: 'assets/Винтажный джаз-бар «Переулок» (2).png',
      alt: 'Общий план джаз-бара «Переулок»: музыканты, посетители и барная стойка',
      speaker: '', text: '', duration: 35000, // Резерв, пока нет утверждённой записи.
      zoom: { start: 0.9, delta: 0.1 },
      audio: {
        // Только утверждённый второй дубль. Файл не ускоряется и не обрабатывается.
        voice: { src: 'assets/audio/Pereulok_voice_natural_v2.mp3', start: 2000, tail: 1500 },
        beds: [{ id: 'room', gain: 1 }, { id: 'dishes', gain: 0.7 }, { id: 'jazz', gain: 0.65 }],
        effects: []
      }
    },
    {
      id: 'hero', title: 'Герой в баре', layout: 'hero',
      image: 'assets/frame-02-bar.webp',
      alt: 'Мужчина с сигаретой за столиком в джаз-баре тридцатых годов',
      speaker: 'РАССКАЗЧИК',
      text: 'Люблю тихие вечера. Особенно когда никто не пытается меня убить',
      duration: 10000, textDelay: 2000, textDuration: 4000, zoom: true,
      audio: {
        voice: null,
        beds: [{ id: 'room', gain: 1 }, { id: 'dishes', gain: 0.7 }, { id: 'jazz', gain: 0.65 }],
        effects: []
      }
    },
    {
      id: 'dasha', title: 'Даша у двери бара', layout: 'dasha',
      image: 'assets/Газетчица Даша у двери бара.png',
      alt: 'Газетчица Даша у двери бара с газетой «Переулок» в протянутой руке',
      speaker: 'ДАША', duration: 12000,
      phrases: [
        { text: 'Свежий „Переулок“!', start: 0, typing: 1200, end: 2500 },
        { text: 'Дерзкое ограбление банка!', start: 2700, typing: 1500, end: 5200 },
        { text: 'Главный подозреваемый — на первой полосе!', start: 5400, typing: 2200, end: 9200 },
        { text: 'Газеты, господа, газеты!', start: 9400, typing: 1200, end: 12000 }
      ],
      holdLastPhrase: true, zoom: { start: 0.9, delta: 0.1 },
      audio: {
        voice: null, // Живой голос Даши автор добавит позже. Синтеза голоса нет.
        beds: [{ id: 'rain', gain: 1 }, { id: 'jazz', gain: 0.12 }],
        effects: [{ src: null, at: 2000, gain: 0.35 }]
      }
    }
  ];
  root.AlleyStory = { audio, scenes };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.AlleyStory;
})(typeof window !== 'undefined' ? window : globalThis);
