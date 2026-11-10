/* Local, optional Web Audio playback. The original voice buffer is never processed. */
(function (root) {
  'use strict';

  const CHANNELS = ['voice', 'ambience', 'music', 'effects'];
  const clamp = value => Math.max(0, Math.min(1, Number(value) || 0));
  const milliseconds = (value, fallback = 0) => Number.isFinite(value) ? Math.max(0, value) : fallback;

  class AlleyAudio {
    constructor(config = {}, { onStatus, resolveMedia } = {}) {
      this.config = config;
      this.onStatus = typeof onStatus === 'function' ? onStatus : () => {};
      this.context = null;
      this._channels = {};
      this._volumes = Object.fromEntries(CHANNELS.map(channel => [channel, clamp(config.volumes?.[channel] ?? 1)]));
      this._master = null;
      this._masterVolume = 1;
      this._muted = false;
      this._lastAudibleVolume = 1;
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
      this._resolveMedia = typeof resolveMedia === 'function' ? resolveMedia : null;
      this._generation = 0;
      this._loadControllers = new Set();
    }

    // A project preview replaces sources, never the user's output or channel levels.
    // The generation also invalidates files still being read/decoded by an older draft.
    reconfigure(config = {}, options = {}) {
      this._generation += 1;
      for (const controller of this._loadControllers) controller.abort();
      this._loadControllers.clear();
      this.stop();
      this.config = config;
      if (Object.prototype.hasOwnProperty.call(options, 'resolveMedia')) {
        this._resolveMedia = typeof options.resolveMedia === 'function' ? options.resolveMedia : null;
      }
      this._buffers.clear();
      this._loads.clear();
      this._voices.clear();
      this._missing.clear();
      this._preparations = 0;
      this._loadTimeout = milliseconds(config.loadTimeout, 10000) || 10000;
      this._state = 'idle';
      this._emit();
      return this.getStatus();
    }

    setMediaResolver(resolveMedia) {
      return this.reconfigure(this.config, { resolveMedia });
    }

    // Call directly from a user gesture: context construction and resume happen
    // before the first await, including when previously decoded buffers are reused.
    async prepare(scenes = []) {
      const generation = this._generation;
      let resumed;
      try {
        if (!this.context || this.context.state === 'closed') {
          const AudioContext = root.AudioContext || root.webkitAudioContext;
          if (!AudioContext) throw new Error('Web Audio is unavailable');
          this.context = new AudioContext();
          // One final gain controls every channel, including the unprocessed voice.
          // Apply a preselected mute before any connection can produce sound.
          this._master = this.context.createGain();
          this._master.gain.value = this.getMasterState().effectiveVolume;
          this._master.connect(this.context.destination);
          for (const channel of CHANNELS) {
            const duck = this.context.createGain();
            const volume = this.context.createGain();
            volume.gain.value = this._volumes[channel];
            duck.connect(volume);
            volume.connect(this._master);
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
        for (const track of this._projectTracks(scene)) {
          paths.add(track.src);
          if (track.kind === 'voice') this._voices.add(track.src);
        }
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
        if (generation === this._generation) {
          this._preparations -= 1;
          this._state = this._preparations ? 'loading' : 'ready';
          this._emit();
        }
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
      const generation = this._generation;
      const context = this.context;
      const resolveMedia = this._resolveMedia;
      const promise = (async () => {
        const controller = root.AbortController ? new root.AbortController() : null;
        if (controller) this._loadControllers.add(controller);
        try {
          // Only project-local files: configuration cannot introduce a remote
          // sample, protocol-relative URL, data URL or synthetic voice service.
          const media = typeof source === 'string' && /^director-media:([A-Za-z0-9_-]+)$/.exec(source);
          if (typeof source !== 'string' || source.trim() !== source || /[\u0000-\u001f\u007f]/.test(source) || (!media && /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(source)) || source.includes('\\')) {
            throw new Error('Only local audio files are supported');
          }
          const buffer = await this._within((async () => {
            let bytes;
            if (media) {
              if (!resolveMedia) throw new Error('Local project media is unavailable');
              const blob = await resolveMedia(media[1]);
              // No object URL or network source can be supplied by an imported project.
              if (!blob || typeof blob.arrayBuffer !== 'function' || !Number.isFinite(blob.size)
                || blob.size <= 0 || blob.size > 32 * 1024 * 1024) throw new Error('Invalid local audio file');
              bytes = await blob.arrayBuffer();
            } else {
              const options = { credentials: 'same-origin', mode: 'same-origin', redirect: 'error' };
              if (controller) options.signal = controller.signal;
              const response = await root.fetch(source, options);
              if (!response.ok) throw new Error('Audio file is unavailable');
              bytes = await response.arrayBuffer();
            }
            const decoded = await context.decodeAudioData(bytes);
            if (!decoded || !Number.isFinite(decoded.duration) || decoded.duration <= 0) throw new Error('Invalid audio');
            return decoded;
          })(), () => controller?.abort());
          if (generation !== this._generation) return null;
          this._buffers.set(source, buffer);
          this._missing.delete(source);
          return buffer;
        } catch (_) {
          if (generation === this._generation) {
            this._buffers.set(source, null);
            this._missing.add(source);
          }
          return null;
        } finally {
          if (controller) this._loadControllers.delete(controller);
        }
      })();
      this._loads.set(source, promise);
      return promise;
    }

    durationFor(scene) {
      const voice = scene?.audio?.voice;
      const buffer = voice?.src && this._buffers.get(voice.src);
      let duration = buffer ? milliseconds(voice.start, 2000) + buffer.duration * 1000 + milliseconds(voice.tail, 1500) : scene.duration;
      const projectVoices = this._projectTracks(scene).filter(track => track.kind === 'voice');
      if (projectVoices.length) {
        duration = Math.max(duration, scene.duration);
        for (const track of projectVoices) {
          const decoded = this._buffers.get(track.src);
          if (decoded) duration = Math.max(duration, milliseconds(track.start) + decoded.duration * 1000 + milliseconds(track.tail, 1500));
        }
      }
      return duration;
    }

    _projectTracks(scene) {
      return (Array.isArray(scene?.audio?.tracks) ? scene.audio.tracks : [])
        .filter(track => track && CHANNELS.includes(track.kind) && typeof track.src === 'string');
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
      this._startProjectTracks(scene, elapsed);
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

    _voiceRanges(scene) {
      const voice = scene.audio?.voice;
      const buffer = voice?.src && this._buffers.get(voice.src);
      const ranges = buffer ? [{ start: milliseconds(voice.start, 2000), duration: buffer.duration * 1000 }] : [];
      for (const track of this._projectTracks(scene)) {
        const decoded = track.kind === 'voice' && this._buffers.get(track.src);
        if (decoded) ranges.push({ start: milliseconds(track.start), duration: decoded.duration * 1000 });
      }
      return ranges.map(range => ({ start: range.start, end: range.start + range.duration }));
    }

    _speechStrength(range, elapsed, attack, release) {
      if (elapsed < range.start) {
        const lead = Math.min(attack, range.start);
        return lead ? clamp((elapsed - (range.start - lead)) / lead) : 0;
      }
      if (elapsed < range.end) return 1;
      return release ? 1 - clamp((elapsed - range.end) / release) : 0;
    }

    _duckValue(channel, scene, elapsed) {
      if (channel === 'voice') return 1;
      const ranges = this._voiceRanges(scene);
      if (!ranges.length) return 1;
      const settings = this.config.duck || {};
      const floor = clamp(settings[channel] ?? 1);
      const attack = milliseconds(settings.attack, 400);
      const release = milliseconds(settings.release, 800);
      const strength = Math.max(...ranges.map(range => this._speechStrength(range, elapsed, attack, release)));
      return 1 - (1 - floor) * strength;
    }

    _scheduleDucking(scene, elapsed) {
      const now = this.context.currentTime;
      const ranges = this._voiceRanges(scene);
      const attack = milliseconds(this.config.duck?.attack, 400);
      const release = milliseconds(this.config.duck?.release, 800);
      const boundaries = [...new Set(ranges.flatMap(range => [Math.max(0, range.start - attack), range.start, range.end, range.end + release]))].sort((a, b) => a - b);
      // Intersections keep overlapping voice attack/release envelopes linear and exact.
      const corners = [...boundaries];
      for (let index = 1; index < corners.length; index += 1) {
        const left = corners[index - 1], right = corners[index];
        for (let a = 0; a < ranges.length; a += 1) for (let b = a + 1; b < ranges.length; b += 1) {
          const first = this._speechStrength(ranges[a], left, attack, release) - this._speechStrength(ranges[b], left, attack, release);
          const last = this._speechStrength(ranges[a], right, attack, release) - this._speechStrength(ranges[b], right, attack, release);
          if (first * last < 0) boundaries.push(left + (right - left) * first / (first - last));
        }
      }
      for (const channel of CHANNELS) {
        const parameter = this._channels[channel].duck.gain;
        parameter.cancelScheduledValues(now);
        parameter.setValueAtTime(this._duckValue(channel, scene, elapsed), now);
        for (const boundary of [...new Set(boundaries)].sort((a, b) => a - b)) {
          if (boundary > elapsed) parameter.linearRampToValueAtTime(this._duckValue(channel, scene, boundary), now + (boundary - elapsed) / 1000);
        }
      }
    }

    _source(buffer, destination, when, offset, { loop = false, gain = null, kind = null, trackId = null } = {}) {
      const source = this.context.createBufferSource();
      source.buffer = buffer;
      source.loop = loop;
      // No playback-rate change, filters, compression, fading or trimming of voice.
      source.connect(destination);
      const record = { source, when, offset, loop, gain, kind, trackId, disposed: false };
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

    _startProjectTracks(scene, elapsed) {
      for (const track of this._projectTracks(scene)) {
        const buffer = this._buffers.get(track.src);
        if (!buffer) continue;
        const start = milliseconds(track.start);
        const loop = track.kind !== 'voice' && Boolean(track.loop);
        let offset = Math.max(0, (elapsed - start) / 1000);
        if (loop) offset %= buffer.duration;
        else if (offset >= buffer.duration) continue;
        const gain = this.context.createGain();
        gain.gain.value = clamp(track.gain ?? 1);
        // Voice is never ducked, accelerated, filtered, or cut to a duration argument.
        gain.connect(this._channels[track.kind][track.kind === 'voice' ? 'volume' : 'duck']);
        this._source(buffer, gain, this.context.currentTime + Math.max(0, start - elapsed) / 1000,
          offset, { loop, gain, kind: track.kind, trackId: track.id || null });
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

    getMasterState() {
      return { volume: this._masterVolume, muted: this._muted,
        effectiveVolume: this._muted ? 0 : this._masterVolume };
    }

    _applyMasterVolume() {
      const parameter = this._master?.gain;
      if (parameter && this.context?.state !== 'closed') {
        const now = this.context.currentTime;
        parameter.cancelScheduledValues(now);
        parameter.setValueAtTime(this.getMasterState().effectiveVolume, now);
      }
      // Gain changes deliberately leave sources, scene time and status callbacks alone.
      return this.getMasterState();
    }

    setMasterVolume(value) {
      this._masterVolume = clamp(value);
      if (this._masterVolume > 0) this._lastAudibleVolume = this._masterVolume;
      this._muted = this._masterVolume === 0;
      return this._applyMasterVolume();
    }

    setMuted(muted) {
      this._muted = Boolean(muted);
      if (!this._muted && this._masterVolume === 0) this._masterVolume = this._lastAudibleVolume;
      return this._applyMasterVolume();
    }

    toggleMuted() { return this.setMuted(!this._muted); }

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
        master: this.getMasterState(),
        voiceActive: Boolean(this._playing && this.context?.state === 'running'
          && ((this._voice && this.context.currentTime >= this._voice.when)
            || [...this._sources].some(record => record.kind === 'voice' && this.context.currentTime >= record.when))) };
    }

    _emit() { this.onStatus(this.getStatus()); }
  }

  root.AlleyAudio = AlleyAudio;
  if (typeof module === 'object' && module.exports) module.exports = AlleyAudio;
})(typeof window === 'object' ? window : globalThis);
