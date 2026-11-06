/* Local, optional Web Audio playback. The original voice buffer is never processed. */
(function (root) {
  'use strict';

  const CHANNELS = ['voice', 'ambience', 'music', 'effects'];
  const clamp = value => Math.max(0, Math.min(1, Number(value) || 0));
  const milliseconds = (value, fallback = 0) => Number.isFinite(value) ? Math.max(0, value) : fallback;

  class AlleyAudio {
    constructor(config = {}, { onStatus } = {}) {
      this.config = config;
      this.onStatus = typeof onStatus === 'function' ? onStatus : () => {};
      this.context = null;
      this._channels = {};
      this._volumes = Object.fromEntries(CHANNELS.map(channel => [channel, clamp(config.volumes?.[channel] ?? 1)]));
      this._buffers = new Map();
      this._loads = new Map();
      this._voices = new Set();
      this._missing = new Set();
      this._sources = new Set();
      this._beds = new Map();
      this._voice = null;
      this._scene = null;
      this._elapsed = 0;
      this._playing = false;
      this._state = 'idle';
      this._preparations = 0;
      this._loadTimeout = milliseconds(config.loadTimeout, 10000) || 10000;
    }

    // Call directly from a user gesture: context construction and resume happen
    // before the first await, including when previously decoded buffers are reused.
    async prepare(scenes = []) {
      let resumed;
      try {
        if (!this.context || this.context.state === 'closed') {
          const AudioContext = root.AudioContext || root.webkitAudioContext;
          if (!AudioContext) throw new Error('Web Audio is unavailable');
          this.context = new AudioContext();
          for (const channel of CHANNELS) {
            const duck = this.context.createGain();
            const volume = this.context.createGain();
            volume.gain.value = this._volumes[channel];
            duck.connect(volume);
            volume.connect(this.context.destination);
            this._channels[channel] = { duck, volume };
          }
          const stateChanged = () => this._emit();
          if (this.context.addEventListener) this.context.addEventListener('statechange', stateChanged);
          else this.context.onstatechange = stateChanged;
        }
        resumed = this.context.resume();
      } catch (_) {
        this._state = 'unavailable';
        this._emit();
        return this.getStatus();
      }

      const paths = new Set();
      for (const scene of scenes) {
        const audio = scene.audio || {};
        if (audio.voice?.src) {
          this._voices.add(audio.voice.src);
          paths.add(audio.voice.src);
        }
        for (const bed of audio.beds || []) {
          const source = this.config.beds?.[bed.id]?.src;
          if (source) paths.add(source);
        }
        for (const effect of audio.effects || []) if (effect.src) paths.add(effect.src);
      }
      this._preparations += 1;
      this._state = 'loading';
      this._emit();
      try {
        // A browser may refuse resume outside a gesture; a subsequent gesture can
        // retry it. Loading still succeeds, and no preparation starts a source.
        await Promise.all([
          this._within(resumed).catch(() => {}),
          ...[...paths].map(source => this._load(source))
        ]);
      } finally {
        this._preparations -= 1;
        this._state = this._preparations ? 'loading' : 'ready';
        this._emit();
      }
      return this.getStatus();
    }

    _within(promise, onTimeout) {
      return new Promise((resolve, reject) => {
        const timeout = root.setTimeout(() => {
          if (onTimeout) onTimeout();
          reject(new Error('Local audio preparation timed out'));
        }, this._loadTimeout);
        Promise.resolve(promise).then(value => {
          root.clearTimeout(timeout);
          resolve(value);
        }, error => {
          root.clearTimeout(timeout);
          reject(error);
        });
      });
    }

    async _load(source) {
      if (this._loads.has(source)) return this._loads.get(source);
      const promise = (async () => {
        const controller = root.AbortController ? new root.AbortController() : null;
        try {
          // Only project-local files: configuration cannot introduce a remote
          // sample, protocol-relative URL, data URL or synthetic voice service.
          if (typeof source !== 'string' || source.trim() !== source || /[\u0000-\u001f\u007f]/.test(source) || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(source) || source.includes('\\')) {
            throw new Error('Only local audio files are supported');
          }
          const buffer = await this._within((async () => {
            const options = { credentials: 'same-origin', mode: 'same-origin', redirect: 'error' };
            if (controller) options.signal = controller.signal;
            const response = await root.fetch(source, options);
            if (!response.ok) throw new Error('Audio file is unavailable');
            const decoded = await this.context.decodeAudioData(await response.arrayBuffer());
            if (!decoded || !Number.isFinite(decoded.duration) || decoded.duration <= 0) throw new Error('Invalid audio');
            return decoded;
          })(), () => controller?.abort());
          this._buffers.set(source, buffer);
          this._missing.delete(source);
          return buffer;
        } catch (_) {
          this._buffers.set(source, null);
          this._missing.add(source);
          return null;
        }
      })();
      this._loads.set(source, promise);
      return promise;
    }

    durationFor(scene) {
      const voice = scene?.audio?.voice;
      const buffer = voice?.src && this._buffers.get(voice.src);
      return buffer ? milliseconds(voice.start, 2000) + buffer.duration * 1000 + milliseconds(voice.tail, 1500) : scene.duration;
    }

    play(scene, elapsedMs = 0, { crossfade = false } = {}) {
      if (!this.context || this.context.state !== 'running' || !scene) return false;
      const elapsed = milliseconds(elapsedMs);
      const sameScene = this._scene === scene;
      // An accidental duplicate play call must not layer another voice or loop.
      if (sameScene && this._playing && Math.abs(elapsed - this._elapsed) < 100) {
        this.tick(elapsed);
        return true;
      }
      const resume = sameScene && !this._playing;
      this._stopSpeechAndEffects();
      if (!resume) this._changeBeds(scene, elapsed, crossfade);
      this._scene = scene;
      this._elapsed = elapsed;
      this._playing = true;
      for (const track of this._beds.values()) {
        if (!track.record) this._startBed(track);
        this._scheduleFade(track, elapsed);
      }
      this._scheduleDucking(scene, elapsed);
      this._startVoice(scene, elapsed);
      this._startEffects(scene, elapsed);
      this._emit();
      return true;
    }

    _changeBeds(scene, elapsed, crossfade) {
      const fadeDuration = crossfade ? milliseconds(this.config.crossfade, 2000) : 0;
      if (!fadeDuration) this._clearBeds();
      const wanted = new Map((scene.audio?.beds || []).map(bed => [bed.id, bed]));
      for (const [id, track] of this._beds) {
        const next = wanted.get(id);
        track.fade = { from: this._fadeValue(track, this._elapsed), to: next ? clamp(next.gain ?? 1) : 0, start: elapsed, duration: fadeDuration };
      }
      for (const [id, bed] of wanted) {
        if (this._beds.has(id)) continue;
        const definition = this.config.beds?.[id];
        const buffer = definition?.src && this._buffers.get(definition.src);
        if (!buffer) continue;
        const channel = CHANNELS.includes(definition.channel) ? definition.channel : 'ambience';
        const gain = this.context.createGain();
        gain.connect(this._channels[channel].duck);
        const target = clamp(bed.gain ?? 1);
        const track = { id, buffer, gain, channel, loop: definition.loop !== false, offset: 0, record: null,
          fade: { from: fadeDuration ? 0 : target, to: target, start: elapsed, duration: fadeDuration } };
        this._beds.set(id, track);
      }
    }

    _fadeValue(track, elapsed) {
      const fade = track.fade;
      const progress = fade.duration ? clamp((elapsed - fade.start) / fade.duration) : 1;
      return fade.from + (fade.to - fade.from) * progress;
    }

    _scheduleFade(track, elapsed) {
      const now = this.context.currentTime;
      const parameter = track.gain.gain;
      parameter.cancelScheduledValues(now);
      parameter.setValueAtTime(this._fadeValue(track, elapsed), now);
      const remaining = track.fade.start + track.fade.duration - elapsed;
      if (remaining > 0) parameter.linearRampToValueAtTime(track.fade.to, now + remaining / 1000);
    }

    _duckValue(channel, scene, elapsed) {
      const voice = scene.audio?.voice;
      const buffer = voice?.src && this._buffers.get(voice.src);
      if (channel === 'voice' || !buffer) return 1;
      const settings = this.config.duck || {};
      const floor = clamp(settings[channel] ?? 1);
      const start = milliseconds(voice.start, 2000);
      const end = start + buffer.duration * 1000;
      const attack = milliseconds(settings.attack, 400);
      const release = milliseconds(settings.release, 800);
      if (elapsed < start) return 1 - (1 - floor) * (attack ? clamp((elapsed - Math.max(0, start - attack)) / Math.min(attack, start || attack)) : 0);
      if (elapsed < end) return floor;
      return floor + (1 - floor) * (release ? clamp((elapsed - end) / release) : 1);
    }

    _scheduleDucking(scene, elapsed) {
      const now = this.context.currentTime;
      const voice = scene.audio?.voice;
      const buffer = voice?.src && this._buffers.get(voice.src);
      const start = milliseconds(voice?.start, 2000);
      const end = start + (buffer?.duration || 0) * 1000;
      const boundaries = buffer ? [Math.max(0, start - milliseconds(this.config.duck?.attack, 400)), start, end, end + milliseconds(this.config.duck?.release, 800)] : [];
      for (const channel of CHANNELS) {
        const parameter = this._channels[channel].duck.gain;
        parameter.cancelScheduledValues(now);
        parameter.setValueAtTime(this._duckValue(channel, scene, elapsed), now);
        for (const boundary of [...new Set(boundaries)].sort((a, b) => a - b)) {
          if (boundary > elapsed) parameter.linearRampToValueAtTime(this._duckValue(channel, scene, boundary), now + (boundary - elapsed) / 1000);
        }
      }
    }

    _source(buffer, destination, when, offset, { loop = false, gain = null } = {}) {
      const source = this.context.createBufferSource();
      source.buffer = buffer;
      source.loop = loop;
      // No playback-rate change, filters, compression, fading or trimming of voice.
      source.connect(destination);
      const record = { source, when, offset, loop, gain, disposed: false };
      this._sources.add(record);
      source.onended = () => {
        if (record.disposed) return;
        this._dispose(record, false);
        if (this._voice === record) this._voice = null;
        this._emit();
      };
      // Omitting the duration argument allows the entire original buffer to end naturally.
      source.start(when, offset);
      return record;
    }

    _startBed(track) {
      const offset = track.loop ? track.offset % track.buffer.duration : track.offset;
      if (offset >= track.buffer.duration) return;
      track.record = this._source(track.buffer, track.gain, this.context.currentTime, offset, { loop: track.loop });
    }

    _startVoice(scene, elapsed) {
      const voice = scene.audio?.voice;
      const buffer = voice?.src && this._buffers.get(voice.src);
      if (!buffer) return;
      const start = milliseconds(voice.start, 2000);
      const offset = Math.max(0, (elapsed - start) / 1000);
      if (offset >= buffer.duration) return;
      this._voice = this._source(buffer, this._channels.voice.volume, this.context.currentTime + Math.max(0, start - elapsed) / 1000, offset);
    }

    _startEffects(scene, elapsed) {
      for (const effect of scene.audio?.effects || []) {
        const buffer = effect.src && this._buffers.get(effect.src);
        if (!buffer) continue;
        const at = milliseconds(effect.at);
        const offset = Math.max(0, (elapsed - at) / 1000);
        if (offset >= buffer.duration) continue;
        const gain = this.context.createGain();
        gain.gain.value = clamp(effect.gain ?? 1);
        gain.connect(this._channels.effects.duck);
        this._source(buffer, gain, this.context.currentTime + Math.max(0, at - elapsed) / 1000, offset, { gain });
      }
    }

    tick(elapsedMs) {
      if (!this._playing) return;
      this._elapsed = milliseconds(elapsedMs);
      for (const [id, track] of this._beds) {
        if (track.fade.to === 0 && this._elapsed >= track.fade.start + track.fade.duration) {
          if (track.record) this._dispose(track.record);
          track.gain.disconnect();
          this._beds.delete(id);
        }
      }
      // Voice ends only through BufferSource.onended, never a guessed scene timer.
    }

    pause() {
      if (!this.context) return;
      const now = this.context.currentTime;
      for (const track of this._beds.values()) {
        if (!track.record) continue;
        track.offset = track.record.offset + Math.max(0, now - track.record.when);
        if (track.loop) track.offset %= track.buffer.duration;
        this._dispose(track.record);
        track.record = null;
      }
      this._stopSpeechAndEffects();
      this._playing = false;
      this._emit();
    }

    stop() {
      this._playing = false;
      this._stopSpeechAndEffects();
      this._clearBeds();
      this._scene = null;
      this._elapsed = 0;
      this._emit();
    }

    _stopSpeechAndEffects() {
      const beds = new Set([...this._beds.values()].map(track => track.record));
      for (const record of [...this._sources]) if (!beds.has(record)) this._dispose(record);
      this._voice = null;
    }

    _clearBeds() {
      for (const track of this._beds.values()) {
        if (track.record) this._dispose(track.record);
        track.gain.disconnect();
      }
      this._beds.clear();
    }

    _dispose(record, stop = true) {
      if (!record || record.disposed) return;
      record.disposed = true;
      record.source.onended = null;
      if (stop) {
        try { record.source.stop(); } catch (_) { /* A naturally ended source is already silent. */ }
      }
      record.source.disconnect();
      if (record.gain) record.gain.disconnect();
      this._sources.delete(record);
    }

    setVolume(channel, value) {
      if (!CHANNELS.includes(channel)) return;
      this._volumes[channel] = clamp(value);
      const parameter = this._channels[channel]?.volume.gain;
      if (parameter) {
        const now = this.context.currentTime;
        parameter.cancelScheduledValues(now);
        parameter.setValueAtTime(this._volumes[channel], now);
      }
    }

    getStatus() {
      const loading = [...this._voices].some(source => !this._buffers.has(source));
      const voice = !this._voices.size ? 'none' : loading ? 'loading' : [...this._voices].some(source => !this._buffers.get(source)) ? 'missing' : 'ready';
      let message = 'Локальный звук готов.';
      if (this._state === 'idle') message = 'Звук включится после нажатия «Начать».';
      else if (this._state === 'loading') message = 'Подготавливаем локальный звук…';
      else if (this._state === 'unavailable') message = 'Звук недоступен в этом браузере. Показ работает без звука.';
      else if (voice === 'missing') message = root.location?.protocol === 'file:' ? 'Для локального звука откройте плеер через HTTP-сервер. Запись голоса пока не подключена.' : 'Запись голоса пока не подключена. Показ работает без неё.';
      else if (this._missing.size) message = 'Некоторые локальные звуки недоступны. Показ продолжается.';
      return { state: this._state, voice, message, missing: [...this._missing], activeSources: this._sources.size,
        playing: this._playing, elapsed: this._elapsed, contextState: this.context?.state || 'unavailable',
        voiceActive: Boolean(this._playing && this.context?.state === 'running' && this._voice && this.context.currentTime >= this._voice.when) };
    }

    _emit() { this.onStatus(this.getStatus()); }
  }

  root.AlleyAudio = AlleyAudio;
  if (typeof module === 'object' && module.exports) module.exports = AlleyAudio;
})(typeof window === 'object' ? window : globalThis);
