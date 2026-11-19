(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AlleyPilotTimeline = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  const PACE = Object.freeze({ captionCharacters: 85, typingCps: 28, readingCps: 16, readingWpm: 150, holdMs: 1200, gapMs: 450 });
  const rounded = value => Math.ceil(value / 100) * 100;
  const words = text => text.trim().split(/\s+/u).filter(Boolean).length;

  // Prefer complete sentences; a long sentence is split only at word boundaries.
  function splitText(text) {
    const sentences = String(text).trim().match(/.+?(?:[.!?…]+(?=\s|$)|$)/gu) || [];
    const pieces = [];
    let pending = '';
    for (const sentence of sentences) {
      for (const word of sentence.trim().split(/\s+/u)) {
        if (pending && Array.from(pending + ' ' + word).length > PACE.captionCharacters) {
          pieces.push(pending); pending = '';
        }
        pending += (pending ? ' ' : '') + word;
      }
      // A sentence boundary remains a natural pause between captions.
      if (pending) { pieces.push(pending); pending = ''; }
    }
    return pieces;
  }

  function buildScene(input) {
    let cursor = input.leadMs ?? 400;
    const phrases = [];
    for (const [index, block] of input.dialogue.entries()) {
      cursor += block.pauseBefore ?? (index ? PACE.gapMs : 0);
      for (const [part, text] of splitText(block.text).entries()) {
        if (part) cursor += 300;
        const typing = Math.max(600, rounded(Array.from(text).length / PACE.typingCps * 1000));
        const reading = Math.max(typing + PACE.holdMs, rounded(Array.from(text).length / PACE.readingCps * 1000), rounded(words(text) / PACE.readingWpm * 60000));
        phrases.push({ speaker: block.speaker, text, start: cursor, typing, end: cursor + reading });
        cursor += reading;
      }
    }
    const endCard = input.endCard;
    const tail = endCard ? endCard.pauseMs + endCard.fadeMs + endCard.holdMs : 500;
    const duration = Math.max(input.draftDuration, cursor + tail);
    if (!endCard && phrases.length) phrases.at(-1).end = duration;
    const scale = duration / input.draftDuration;
    const audioPlan = (input.soundPlan || []).flatMap(cue => cue.kind.replace('music_placeholder', 'music').split('+').map(kind => ({
      kind, name: cue.name, start: Math.round(cue.start * scale), end: Math.min(duration, Math.round(cue.end * scale)), src: null, status: 'planned'
    })));
    for (const phrase of phrases) audioPlan.push({ kind: 'voice', speaker: phrase.speaker, start: phrase.start, end: phrase.end, src: null, status: 'planned' });
    return {
      id: input.id, title: input.title, layout: input.layout || input.id,
      image: input.image, alt: input.alt, duration, draftDuration: input.draftDuration,
      speaker: input.dialogue[0]?.speaker || '', phrases,
      stageDirections: input.stageDirections || [],
      holdLastPhrase: !endCard, transitionMs: 200,
      zoom: input.id === 'panorama' ? { start: 1.02, delta: -.02 } : { start: 1, delta: .02 }, focus: '50% 50%',
      audio: { voice: null, beds: [], effects: [] }, audioPlan,
      ...(endCard ? { endCard: { ...endCard } } : {})
    };
  }

  function endCardState(scene, elapsed, options = {}) {
    const card = scene.endCard;
    if (!card || options.reading) return { visible: false, shade: 0, title: 0 };
    const duration = options.duration ?? scene.duration;
    const fadeStart = duration - card.fadeMs - card.holdMs;
    const titleStart = duration - card.holdMs;
    if (elapsed < fadeStart) return { visible: false, shade: 0, title: 0 };
    return {
      visible: true,
      shade: options.reducedMotion ? 1 : Math.max(0, Math.min(1, (elapsed - fadeStart) / card.fadeMs)),
      title: elapsed < titleStart ? 0 : options.reducedMotion ? 1 : Math.min(1, (elapsed - titleStart) / 350),
      text: card.text
    };
  }
  return { PACE, splitText, buildScene, endCardState };
});
