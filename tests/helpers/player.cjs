const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../../player.js'), 'utf8');
const config = fs.readFileSync(path.join(__dirname, '../fixtures/legacy-story.cjs'), 'utf8');
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

// Фальшивый аудиоадаптер проверяет транспорт; сам движок проверяется отдельно.
function player({ voiceSeconds = null, preparation = Promise.resolve(), reducedMotion = false, extraScene = false, blockedVoice = false, masterVolume = 1, masterMuted = false, story: providedStory = null } = {}) {
  let now = 0, nextId = 0, audio;
  const pending = new Map();
  function makeElement() {
    const classes = new Set(), classChanges = [];
    return {
      classChanges,
      textContent: '', attributes: {}, handlers: {}, disabled: false, hidden: false, children: [], value: '',
      style: { setProperty(name, value) { this[name] = value; } },
      classList: { toggle(name, enabled) { const before = classes.has(name); if (enabled) classes.add(name); else classes.delete(name); if (before !== Boolean(enabled)) classChanges.push({name,present:Boolean(enabled)}); }, contains: name => classes.has(name) },
      setAttribute(name, value) { this.attributes[name] = value; }, getAttribute(name) { return this.attributes[name]; },
      set src(value) { this.attributes.src = value; }, get src() { return this.attributes.src; },
      appendChild(child) { this.children.push(child); }, replaceChildren(...children) { this.children = children; }, addEventListener(name, handler) { this.handlers[name] = handler; }
    };
  }
  const ids = Object.fromEntries(['frame','speaker','dialogue','accessible-dialogue','counter','back','next','start','cinema','comic','status','hint','progress','audio-status','volume-voice','volume-ambience','volume-music','volume-effects','end-card','end-card-title'].map(id => [id, makeElement()]));
  const screen = makeElement(), caption = makeElement();
  const preference = { matches: reducedMotion, addEventListener(name, handler) { this.change = handler; } };
  const document = { hidden: false, handlers: {}, getElementById: id => ids[id], createElement: makeElement,
    querySelector: selector => selector === '.screen' ? screen : caption,
    addEventListener(name, handler) { this.handlers[name] = handler; } };
  class FakeAudio {
    constructor(settings, { onStatus }) { audio = this; this.settings = settings; this.onStatus = onStatus; this.events = []; this.attempts = []; this.ready = false; this.blocked = blockedVoice; this.masterVolume = masterVolume; this.masterMuted = masterMuted; this.contextState = 'running'; this.preparation = preparation; }
    async prepare() { this.events.push({ type: 'prepare' }); await this.preparation; this.contextState = 'running'; this.ready = true; this.onStatus({ message: voiceSeconds ? 'Голос готов' : 'Запись ещё не добавлена. Показ без голоса.', contextState: 'running' }); }
    reconfigure(settings, {resolveMedia} = {}) { this.settings = settings; this.resolver = resolveMedia; this.ready = false; this.playing = false; this.events.push({type:'reconfigure'}); }
    setMediaResolver(resolveMedia) { this.resolver = resolveMedia; this.events.push({type:'resolver'}); }
    durationFor(scene) { return this.ready && voiceSeconds && scene.audio.voice ? voiceSeconds * 1000 + scene.audio.voice.start + scene.audio.voice.tail : scene.duration; }
    play(scene, elapsed, options = {}) { const attempt = { type: 'play', id: scene.id, elapsed, crossfade: Boolean(options.crossfade) }; this.attempts.push(attempt); if (this.blocked) return false; this.events.push(attempt); this.playing = true; }
    getStatus() { return { voice: this.ready && voiceSeconds ? 'ready' : 'missing', contextState: this.contextState }; }
    setContextState(state) { this.contextState = state; this.onStatus({message:'Состояние контекста изменилось',contextState:state}); }
    getMasterState() { return { volume: this.masterVolume, muted: this.masterMuted, effectiveVolume: this.masterMuted ? 0 : this.masterVolume }; }
    // Master gain changes do not emit onStatus or restart any source.
    setMasterVolume(value) { this.masterVolume = Number(value); this.masterMuted = this.masterVolume === 0; return this.getMasterState(); }
    setMuted(value) { this.masterMuted = Boolean(value); return this.getMasterState(); }
    tick(elapsed) { this.elapsed = elapsed; }
    pause() { this.events.push({ type: 'pause' }); this.playing = false; }
    stop() { this.events.push({ type: 'stop' }); this.playing = false; }
    setVolume(channel, value) { this.events.push({ type: 'volume', channel, value }); }
  }
  const window = { AlleyPilotTimeline: require('../../pilot-timeline.js'), AlleyAudio: FakeAudio, handlers: {}, matchMedia: () => preference, addEventListener(name, handler) { this.handlers[name] = handler; } };
  const context = vm.createContext({ document, window, performance: { now: () => now },
    requestAnimationFrame: callback => { pending.set(++nextId, callback); return nextId; }, cancelAnimationFrame: id => pending.delete(id) });
  if (providedStory) window.AlleyStory = JSON.parse(JSON.stringify(providedStory));
  else vm.runInContext(config, context);
  if (extraScene) window.AlleyStory.scenes.push({ id:'extra', title:'Проверка конфигурации', image:'assets/frame-3.svg', duration:2000, text:'', audio:{voice:null,beds:[],effects:[]} });
  vm.runInContext(source, context);
  return {
    ids, audio, screen, caption, preference, document, window, scenes: window.AlleyStory.scenes,
    click(id) { if (!ids[id].disabled) return ids[id].handlers.click(); },
    advance(ms) { now += ms; const callbacks = [...pending.values()]; pending.clear(); callbacks.forEach(fn => fn(now)); },
    go(index) { const current = Number(ids.counter.textContent.match(/\d+/)[0]) - 1; for (let i = current; i < index; i++) this.click('next'); for (let i = current; i > index; i--) this.click('back'); },
    changeMaster(values) {
      const previous = audio.getMasterState();
      if (Object.hasOwn(values, 'volume')) audio.setMasterVolume(values.volume);
      if (Object.hasOwn(values, 'muted')) audio.setMuted(values.muted);
      return context.handleMasterChange(audio.getMasterState(), previous);
    },
    get scheduled() { return pending.size; }
  };
}

function scale(p) { return Number(p.ids.frame.style.transform.match(/[\d.]+/)[0]); }


module.exports = { player, deferred, scale };
