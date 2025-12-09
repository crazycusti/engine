import Vector from '../../shared/Vector.mjs';
import Cmd from '../common/Cmd.mjs';
import Cvar from '../common/Cvar.mjs';
import Q from '../../shared/Q.mjs';
import { eventBus, registry } from '../registry.mjs';

let { CL, COM, Con, Host, Mod } = registry;

eventBus.subscribe('registry.frozen', () => {
  CL = registry.CL;
  COM = registry.COM;
  Con = registry.Con;
  Host = registry.Host;
  Mod = registry.Mod;
});

export class SFX {
  static STATE = {
    NEW: 'new',
    LOADING: 'loading',
    AVAILABLE: 'available',
    FAILED: 'failed',
  };

  /** @param {string} name sfx filename */
  constructor(name) {
    this.name = name;
    this.cache = null;
    this.state = SFX.STATE.NEW;
    this.loadtime = null;

    this._availableQueue = [];
  }

  queueAvailableHandler(handler) {
    this._availableQueue.push(handler);

    return this;
  }

  makeAvailable() {
    this.state = SFX.STATE.AVAILABLE;

    while (this._availableQueue.length > 0) {
      const handler = this._availableQueue.shift();
      handler(this);
    }

    return this;
  }

  async load() {
    if (this.state !== SFX.STATE.NEW) {
      return false;
    }

    return await S.LoadSound(this);
  }

  play() {
    S.LocalSound(this);
  }
}

class SoundBaseChannel {
  static STATE = {
    NOT_READY: 'not-ready',
    STOPPED: 'stopped',
    PLAYING: 'playing',
  };

  /**
   * @param {typeof S} S Sound system reference
   */
  constructor(S) {
    this._S = S;
    this.reset();
  }

  reset() {
    this.stop();

    this.sfx = null;

    this.origin = new Vector();
    this.dist_mult = 0;
    this.entnum = null;
    this.entchannel = null;

    this.end = 0.0;
    this.pos = 0.0;

    this.master_vol = 0.0;
    this.channel_vol = 0.0;
    this.pan = 0.0;

    this._playFailedTime = null;
    this._state = SoundBaseChannel.STATE.NOT_READY;

    return this;
  }

  /**
   * @param {SFX} sfx sfx to play
   * @returns {this} this channel
   */
  withSfx(sfx) {
    this.sfx = sfx;

    if (!sfx) {
      this.reset();
    }

    return this;
  }

  // eslint-disable-next-line no-unused-vars, @typescript-eslint/require-await
  static async decodeAudioData(rawData) {
    return null;
  }

  loadData() {
    return this;
  }

  stop() {
    return this;
  }

  start() {
    return this;
  }

  pause() {
    return this;
  }

  resume() {
    return this;
  }

  updateVol() {
    return this;
  }

  updateLoop() {
    return this;
  }

  /**
   * (Re)computes pan and channel_vol for a channel based on the listener position/orientation.
   * @returns {this} the channel
   */
  spatialize() {
    // local sound goes full volume and center pan
    if (this.entnum === CL.state.viewentity) {
      this.pan = 0.0;
      this.channel_vol = this.master_vol;
      this.updateVol();
      return this;
    }

    // Calculate distance from the listener
    const source = new Vector(
      this.origin[0] - this._S._listenerOrigin[0],
      this.origin[1] - this._S._listenerOrigin[1],
      this.origin[2] - this._S._listenerOrigin[2],
    );

    let dist = Math.hypot(source[0], source[1], source[2]);
    if (dist !== 0.0) {
      source[0] /= dist;
      source[1] /= dist;
      source[2] /= dist;
    }
    dist *= this.dist_mult;

    // Dot product with the listener’s right vector
    const dot = source.dot(this._S._listenerRight);

    const adjustedVolume = (1.0 - dist);

    this.pan = dot;
    this.channel_vol = Math.max(0, adjustedVolume * this.master_vol);

    this.updateVol();

    return this;
  }
}

class AudioContextChannel extends SoundBaseChannel {
  static async decodeAudioData(rawData) {
    return await S._context.decodeAudioData(rawData);
  }

  reset() {
    super.reset();

    this._nodes = null;
    this._startTime = null; // used for AudioContextChannel to track when playback started

    return this;
  }

  loadData() {
    if (!this._S._started || !this.sfx || this.sfx.state === SFX.STATE.FAILED) {
      this._state = SoundBaseChannel.STATE.NOT_READY;
      return this;
    }

    const sc = this.sfx.cache;

    const nodes = {
      source: this._S._context.createBufferSource(),
      panner: this._S._context.createStereoPanner(),
      gain: this._S._context.createGain(),
      effectWet: this._S._context.createGain(),
      effectDry: this._S._context.createGain(),
    };

    nodes.source.buffer = sc.data;

    // looping
    if (sc.loopstart !== null) {
      nodes.source.loop = true;
      nodes.source.loopStart = sc.loopstart;
      nodes.source.loopEnd = sc.data.duration;
    }

    // Chain: Source -> Panner -> Gain -> (Wet/Dry) -> Destination
    nodes.source.connect(nodes.panner);
    nodes.panner.connect(nodes.gain);

    nodes.gain.connect(nodes.effectDry);
    nodes.gain.connect(nodes.effectWet);

    // Connect to the context destination
    nodes.effectDry.connect(this._S._context.destination);

    // Connect underwater effect if available
    if (this._S._underwaterFilter) {
      nodes.effectWet.connect(this._S._underwaterFilter.input);
      this._S._underwaterFilter.output.connect(this._S._context.destination);
    } else {
      nodes.effectWet.connect(this._S._context.destination);
    }

    this._nodes = nodes;

    // Set initial volume
    this.updateVol();

    this._state = SoundBaseChannel.STATE.STOPPED;

    return this;
  }

  updateVol() {
    if (!this._nodes) {
      return this;
    }

    this._nodes.panner.pan.value = Math.min(1, Math.max(-1, this.pan));
    this._nodes.gain.gain.value = this.channel_vol * this._S.volume.value;

    if (this._S._listenerUnderwater && this.entchannel >= 0) {
      this._nodes.effectWet.gain.value = 1.0;
      this._nodes.effectDry.gain.value = 0.0;
    } else {
      this._nodes.effectWet.gain.value = 0.0;
      this._nodes.effectDry.gain.value = 1.0;
    }

    return this;
  }

  stop() {
    // Stop regardless of state if we have an active source
    try {
      if (this._nodes && this._nodes.source) {
        this._nodes.source.stop(0);
      }
    } catch {
      // ignore exceptions from stopping an already stopped source
    }

    this._startTime = null;
    // discard nodes so we recreate them on resume (AudioBufferSourceNodes are single-use)
    this._nodes = null;

    this._state = SoundBaseChannel.STATE.STOPPED;
    return this;
  }

  start() {
    if (this._state !== SoundBaseChannel.STATE.STOPPED) {
      return this;
    }

    if (this._nodes && this._nodes.source) {
      // record start time so we can calculate pausing offset
      try {
        this._nodes.source.start(0, this.pos);
      } catch {
        // if starting fails, try to recreate nodes and start again
        this.loadData();
        if (this._nodes && this._nodes.source) {
          this._nodes.source.start(0, this.pos);
        }
      }
      this._startTime = this._S._context.currentTime;
    }

    this._state = SoundBaseChannel.STATE.PLAYING;
    return this;
  }

  pause() {
    // Pause must capture playback position and stop the source. On resume we'll recreate nodes.
    if (this._state !== SoundBaseChannel.STATE.PLAYING) {
      return this;
    }

    if (this._nodes && this._nodes.source && this._startTime !== null) {
      const now = this._S._context.currentTime;
      let elapsed = now - this._startTime;

      // Advance position by elapsed
      this.pos += elapsed;

      // If looped, wrap into loop region
      const sc = this.sfx && this.sfx.cache;
      if (sc && sc.data && sc.loopstart !== null) {
        const duration = sc.data.duration;
        const loopStart = sc.loopstart;
        const loopLen = duration - loopStart;
        if (loopLen > 0) {
          if (this.pos >= duration) {
            this.pos = loopStart + ((this.pos - loopStart) % loopLen);
          }
        }
      }
    }

    // Stop and drop nodes
    try {
      if (this._nodes && this._nodes.source) {
        this._nodes.source.stop(0);
      }
    } catch {
      // ignore
    }
    this._nodes = null;
    this._startTime = null;
    this._state = SoundBaseChannel.STATE.STOPPED;

    return this;
  }

  resume() {
    if (this._state === SoundBaseChannel.STATE.PLAYING) {
      return this;
    }

    // Recreate nodes if needed and start from stored pos
    if (!this._nodes) {
      this.loadData();
    }

    // Ensure we have data and are allowed to start
    if (!this._nodes || !this.sfx || this.sfx.state === SFX.STATE.FAILED) {
      return this;
    }

    // Clip pos to duration for non-looped sounds
    try {
      const sc = this.sfx.cache;
      if (sc && sc.data) {
        const duration = sc.data.duration;
        if (sc.loopstart === null && this.pos >= duration) {
          // nothing to resume
          return this;
        }
      }
    } catch {
      // ignore
    }

    this.start();
    return this;
  }
}

/** @typedef {{input: GainNode, output: GainNode}} SpecialEffectFilter */

const S = {
  /** @type {SoundBaseChannel[]} */
  _channels: [],
  /** @type {SoundBaseChannel[]} */
  _staticChannels: [],
  /** @type {SoundBaseChannel[]} */
  _ambientChannels: [],
  /** @type {SFX[]} */
  _knownSfx: [],

  // Listener state
  _listenerOrigin: new Vector(),
  _listenerForward: new Vector(),
  _listenerRight: new Vector(),
  _listenerUp: new Vector(),
  _listenerUnderwater: false,

  _started: false,
  /** @type {AudioContext|null} */
  _context: null,

  // Cvars
  _precache: null,
  _nosound: null,
  _ambientLevel: null,
  _ambientFade: null,

  // Public Cvars
  volume: null,
  bgmvolume: null,

  // Event listeners
  _eventListeners: [],

  // Optional special effects
  /** @type {SpecialEffectFilter?} */
  _underwaterFilter: null,

  _NewChannel() {
    return new this._channelDriver(this);
  },

  /**
   * Picks or finds an available channel for a new sound to Play on.
   * Possibly kills an older channel from same entnum/entchannel.
   * @param {number} entnum entity number that owns the sound
   * @param {number} entchannel channel index for the entity (0 = any, -1 = local)
   * @returns {SoundBaseChannel} allocated or reused channel
   */
  PickChannel(entnum, entchannel) {
    let i;
    let channel = null;

    // If entchannel != 0, see if there is an existing channel with the same
    // entnum and entchannel. If so, kill it.
    if (entchannel !== 0) {
      for (i = 0; i < this._channels.length; i++) {
        channel = this._channels[i];
        if (!channel) {
          continue;
        }
        const matchingEnt = (channel.entnum === entnum);
        const matchingChan = (channel.entchannel === entchannel) || (entchannel === -1);
        if (matchingEnt && matchingChan) {
          // Kill old
          channel.reset();
          break;
        }
      }
    }

    // If entchannel == 0 or we never found a free channel, pick a free or new channel.
    if ((entchannel === 0) || (i === this._channels.length)) {
      for (i = 0; i < this._channels.length; i++) {
        channel = this._channels[i];
        if (!channel || !channel.sfx) {
          break;
        }
      }
    }
    if (i === this._channels.length) {
      // No free channel found, allocate a new one
      this._channels[i] = this._NewChannel();
    }
    this._channels[i].reset();
    return this._channels[i];
  },

  //
  // --- Initialization
  //

  Init() {
    Cmd.AddCommand('play', this.Play_f.bind(this));
    Cmd.AddCommand('playvol', this.PlayVol_f.bind(this));
    Cmd.AddCommand('stopsound', this.StopAllSounds.bind(this));
    Cmd.AddCommand('soundlist', this.SoundList_f.bind(this));

    this._nosound = new Cvar('nosound', COM.CheckParm('-nosound') ? '1' : '0', Cvar.FLAG.READONLY);
    this.volume = new Cvar('volume', '0.7', Cvar.FLAG.ARCHIVE);
    this._precache = new Cvar('precache', '1');
    this.bgmvolume = new Cvar('bgmvolume', '1', Cvar.FLAG.ARCHIVE);
    this._ambientLevel = new Cvar('ambient_level', '0.3');
    this._ambientFade = new Cvar('ambient_fade', '100');

    // Attempt to create an AudioContext
    try {
      this._context = new AudioContext({sampleRate: 22050});
      this._channelDriver = AudioContextChannel;

      this._underwaterFilter = this._MakeUnderwaterChain();
      this._started = true;
    } catch (err) {
      Con.Print(`S.Init: failed to initialize AudioContext (${err.message}). Sound disabled.\n`);
      this._started = false;
    }

    if (!this._started) {
      return;
    }

    // Initialize ambient channels
    for (const ambientSfx of ['water1', 'wind2']) {
      const name = `ambience/${ambientSfx}.wav`;

      const sfx = this.PrecacheSound(name);

      if (!sfx) {
        return;
      }

      const ch = this._NewChannel().withSfx(sfx);

      this._ambientChannels.push(ch);

      sfx.queueAvailableHandler(() => {
        ch.loadData();
        ch.updateVol();
        ch.start();

        if (sfx.cache.loopstart === null) {
          Con.Print(`S.Init: Sound ${name} not looped\n`);
        }
      });

      if (sfx.state === SFX.STATE.NEW) {
          this.LoadSound(sfx).catch((error) => {
            if (!this._started) {
              return;
            }
            Con.Print(`S.Init: async load of ambient ${name} failed, ${error}\n`);
          });
        }
    }

    this._eventListeners.push(eventBus.subscribe('client.paused', () => this._PauseAllSounds()));
    this._eventListeners.push(eventBus.subscribe('client.unpaused', () => this._ResumeAllSounds()));

    Con.Print('Sound subsystem initialized.\n');
  },

  Shutdown() {
    for (const unsubscribe of this._eventListeners) {
      unsubscribe();
    }
    this.StopAllSounds();
    setTimeout(() => this.StopAllSounds(), 1000); // poor man’s version of fixing issues
    this._started = false;
    setTimeout(() => {
      this._knownSfx = [];
    }, 1001);
    Con.Print('S.Shutdown: sound subsystem shut down.\n');
  },

  //
  // --- Sound data loading
  //

  /**
   * Slowly load all other pending files
   */
  LoadPendingFiles() {
    const pendingSfx = this._knownSfx.filter((sfx) => sfx.state === SFX.STATE.NEW);

    if (pendingSfx.length === 0) {
      return;
    }

    const promises = [];

    // load up to four at a time
    for (let i = 0; i < Math.min(pendingSfx.length, 4); i++) {
      promises.push(pendingSfx[i].load());
    }

    // wait for all of them, process next batch
    Promise.all(promises).then(() => {
      this.LoadPendingFiles();
    }).catch((err) => {
      Con.PrintError(`S.LoadPendingFiles: Error while loading pending sounds: ${err.message || err}\n`);
    });
  },

  /**
   * Precache a sound by name. Optionally load it if precache cvar is set.
   * @param {string} name sound filename
   * @returns {SFX|null} The SFX object or null if sound is disabled.
   */
  PrecacheSound(name) {
    if (this._nosound.value !== 0) {
      return null;
    }
    // Search known list
    let sfx = this._knownSfx.find((k) => k.name === name);
    if (!sfx) {
      sfx = new SFX(name);
      this._knownSfx.push(sfx);
    }
    if (this._precache.value !== 0) {
      // we do not need all sounds right away, let’s prioritize them
      if (sfx.state === SFX.STATE.NEW) {
        this.LoadSound(sfx).catch((error) => {
          if (!this._started) {
            return;
          }

          Con.Print(`S.PrecacheSound: async precaching ${name} failed, ${error}\n`);
        });
      }
    }
    return sfx;
  },

  async PrecacheSoundAsync(name) {
    if (this._nosound.value !== 0) {
      return null;
    }
    // Search known list
    let sfx = this._knownSfx.find((k) => k.name === name);
    if (!sfx) {
      sfx = new SFX(name);
      this._knownSfx.push(sfx);
    }
    if (this._precache.value !== 0) {
      // we do not need all sounds right away, let’s prioritize them
      if (sfx.state === SFX.STATE.NEW) {
        await this.LoadSound(sfx);
      }
    }
    return sfx;
  },

  /**
   * Actually load sound data and decode it.
   * @param {SFX} sfx The SFX object to load
   * @returns {Promise<boolean>} Resolves to true if loaded, false if failed or sound disabled.
   */
  async LoadSound(sfx) {
    if (!this._started || this._nosound.value !== 0) {
      sfx.state = SFX.STATE.FAILED;
      return false;
    }

    if (sfx.state === SFX.STATE.LOADING) {
      throw new Error('LoadSound on isLoading = true');
    }

    if ([SFX.STATE.AVAILABLE, SFX.STATE.FAILED].includes(sfx.state)) {
      // Already loaded or given up on
      return sfx.cache !== null;
    }

    const sc = {
      length: null,
      size: null,
      data: null,
      loopstart: null,
    };

    sfx.state = SFX.STATE.LOADING;
    sfx.loadtime = Host.realtime || null;
    const data = await COM.LoadFile(`sound/${sfx.name}`);

    if (!data) {
      if (!this._started) {
        return false;
      }

      Con.Print(`S.LoadSound: Couldn't load ${sfx.name}\n`);
      sfx.state = SFX.STATE.FAILED;
      return false;
    }

    if (!this._started) {
      Con.Print(`S.LoadSound: Loaded sound ${sfx.name} after sound subsystem shutdown.\n`);
      sfx.state = SFX.STATE.FAILED;
      return false;
    }

    // Parse loop info from WAV chunks
    const loopInfo = this._ParseWavLoopInfo(data, sfx.name);

    try {
      sc.data = await this._channelDriver.decodeAudioData(data);
    } catch (e) {
      Con.PrintError(`S.LoadSound: decodeAudioData failed for ${sfx.name}: ${e.message}\n`);
      sfx.state = SFX.STATE.FAILED;
      return false;
    }

    sc.length = sc.data.duration;
    sc.size = data.byteLength;

    if (loopInfo.loopstartSamples !== null) {
      sc.loopstart = loopInfo.loopstartSamples / sc.data.sampleRate;
      Con.DPrint(`S.LoadSound: ${sfx.name} loopstart ${loopInfo.loopstartSamples} samples -> ${sc.loopstart}s\n`);
    }

    // eslint-disable-next-line require-atomic-updates
    sfx.cache = sc;
    sfx.makeAvailable();

    return true;
  },

  _ParseWavLoopInfo(data, name) {
    const view = new DataView(data);
    // Minimal WAV sanity check
    if (data.byteLength < 12 || view.getUint32(0, true) !== 0x46464952 || view.getUint32(8, true) !== 0x45564157) {
      Con.PrintWarning(`S._ParseWavLoopInfo: ${name} not a valid WAV file\n`);
      return { loopstartSamples: null };
    }

    let p = 12;
    let loopstartSamples = null;
    let cueFound = false;
    let cueLoopStart = null;

    while (p + 8 <= data.byteLength) {
      const chunkId = view.getUint32(p, true);
      const chunkSize = view.getUint32(p + 4, true);

      const remain = data.byteLength - (p + 8);
      let actualChunkSize = chunkSize;
      if (chunkSize > remain) {
        actualChunkSize = remain;
      }

      switch (chunkId) {
        case 0x20657563: // 'cue '
          if (actualChunkSize >= 28) {
            cueFound = true;
            cueLoopStart = view.getUint32(p + 32, true);
          }
          break;
        case 0x5453494c: // 'LIST'
          if (cueFound && actualChunkSize >= 4) {
            let q = p + 8 + 4; // skip list type
            const listEnd = p + 8 + actualChunkSize;
            while (q + 8 <= listEnd) {
              const subId = view.getUint32(q, true);
              const subSize = view.getUint32(q + 4, true);
              if (subId === 0x6b72616d && subSize >= 4) { // 'mark'
                // Found loop length in samples?
                // The original code used this to calculate totalSamples, but didn't use it for loopstart directly?
                // Actually original code: totalSamples = loopstart + maybeSampleCount
                // But sc.loopstart was set from cueLoopStart / sampleRate.
                // So we just need cueLoopStart.
                break;
              }
              q += subSize + 8;
              if (q & 1) {
                q += 1;
              }
            }
          }
          break;
        case 0x6c706d73: // 'smpl'
          if (actualChunkSize >= 60) { // 36 header + 24 loop descriptor
            try {
              const numLoops = view.getUint32(p + 8 + 28, true);
              if (numLoops >= 1) {
                const loopOffset = p + 8 + 36;
                const startSample = view.getUint32(loopOffset + 8, true);
                loopstartSamples = startSample;
              }
            } catch {
              Con.PrintWarning(`S._ParseWavLoopInfo: ${name} 'smpl' parse failure\n`);
            }
          }
          break;
      }

      p += actualChunkSize + 8;
      if (p & 1) {
        p += 1;
      }
    }

    if (loopstartSamples === null && cueLoopStart !== null) {
      loopstartSamples = cueLoopStart;
    }

    return { loopstartSamples };
  },

  //
  // --- Playing sounds
  //

  StartSound(entnum, entchannel, sfx, origin, vol, attenuation) {
    if (!this._started || this._nosound.value !== 0 || !sfx) {
      return;
    }

    if (this._context && this._context.state === 'suspended') {
      this._context.resume().catch((err) => {
        Con.Print(`S.StartSound: failed to resume context, ${err.message}\n`);
      });
    }

    // 1) Create a local callback that sets up the channel once data is loaded
    const onDataAvailable = (sc) => {
      // Pick or free a channel
      const targetChan = this.PickChannel(entnum, entchannel).withSfx(sfx);
      targetChan.origin = origin.copy();
      targetChan.dist_mult = attenuation * 0.001;
      targetChan.master_vol = vol;
      targetChan.entnum = entnum;
      targetChan.entchannel = entchannel;

      // Spatialize
      targetChan.spatialize();

      // Out of reach
      if (targetChan.channel_vol <= 0) {
        return;
      }

      targetChan.pos = 0.0;
      targetChan.end = Host.realtime + sc.length;

      // Load channel data
      targetChan.loadData();

      // Play immediately
      targetChan.start();
    };

    if (sfx.state === SFX.STATE.AVAILABLE) {
      // 2) If already cached, call onDataAvailable immediately
      onDataAvailable(sfx.cache);
      return;
    }

    if (sfx.state === SFX.STATE.NEW) {
      // 3) Not cached yet
      this.LoadSound(sfx).then((res) => {
        if (!res) {
          return;
        }

        // jump back up to playing it
        onDataAvailable(sfx.cache);
      }).catch((err) => {
        Con.PrintError(`S.StartSound: failed to LoadSound ${sfx.name}, ${err.message || err}\n`);
      });
      return;
    }
  },

  StopSound(entnum, entchannel) {
    if (this._nosound.value !== 0) {
      return;
    }

    // release that channel
    const ch = this._channels.find((ch) => ch && ch.entnum === entnum && ch.entchannel === entchannel);

    console.assert(ch, 'valid channel', entnum, entchannel);

    ch.stop();
  },

  StopAllSounds() {
    if (this._nosound.value !== 0) {
      return;
    }

    // Ambient channels
    for (const ch of this._ambientChannels) {
      ch.channel_vol = 0;
      ch.updateVol();
    }

    // Dynamic channels
    while (this._channels.length > 0) {
      const ch = this._channels.shift();
      ch.stop();
    }

    // Static channels
    while (this._staticChannels.length > 0) {
      const ch = this._staticChannels.shift();
      ch.stop();
    }
  },

  _PauseAllSounds() {
    if (this._nosound.value !== 0) {
      return;
    }

    for (const ch of this._channels) {
      ch.pause();
    }

    for (const ch of this._ambientChannels) {
      ch.pause();
    }

    for (const ch of this._staticChannels) {
      ch.pause();
    }
  },

  _ResumeAllSounds() {
    if (this._nosound.value !== 0) {
      return;
    }

    for (const ch of this._channels) {
      ch.resume();
    }

    for (const ch of this._ambientChannels) {
      ch.resume();
    }

    for (const ch of this._staticChannels) {
      ch.resume();
    }
  },

  StaticSound(sfx, origin, vol, attenuation) {
    if (!this._started || this._nosound.value !== 0 || !sfx) {
      return;
    }

    const ss = this._NewChannel().withSfx(sfx);
    ss.origin = origin.copy();
    ss.master_vol = vol;
    ss.dist_mult = attenuation * 0.000015625;

    this._staticChannels.push(ss);

    const onDataAvailable = (sc) => {
      if (sc.loopstart === null) {
        Con.PrintWarning(`S.StaticSound: Sound ${sfx.name} not looped, assuming start 0\n`);
        sc.loopstart = 0;
      }

      ss.loadData();
      ss.end = Host.realtime + sc.length;

      ss.spatialize();
      ss.start();
    };

    if (sfx.state === SFX.STATE.AVAILABLE) {
      onDataAvailable(sfx.cache);
      return;
    }

    if (sfx.state === SFX.STATE.LOADING || sfx.state === SFX.STATE.NEW) {
      sfx.queueAvailableHandler((sfx) => onDataAvailable(sfx.cache));
      return;
    }
  },

  //
  // --- Console Commands
  //

  SoundList_f() {
    let total = 0;
    for (let i = 0; i < this._knownSfx.length; i++) {
      const sfx = this._knownSfx[i];
      let sizeStr = '';
      const flags = [];

      switch (sfx.state) {
        case SFX.STATE.AVAILABLE: {
          const sc = sfx.cache;
          sizeStr = sc.size.toString();
          total += sc.size;
          if (sc.loopstart !== null) {
            flags.push('L');
          }
        }
          break;
        case SFX.STATE.FAILED:
          sizeStr = 'FAILED';
          break;
        case SFX.STATE.LOADING:
          sizeStr = 'LOADING';
          break;
        case SFX.STATE.NEW:
          sizeStr = 'NEW';
          break;
        default:
          sizeStr = `(${sfx.state})`;
      }

      sizeStr = `${flags.join('').padEnd(3, ' ')} ${sizeStr.padEnd(8, ' ')}`;

      Con.Print(`${sizeStr} : ${sfx.name}\n`);
    }
    Con.Print(`Total resident: ${total}\n`);
  },

  Play_f(...samples) {
    if (this._nosound.value !== 0) {
      return;
    }
    // e.g. "play misc/hit1 misc/hit2"
    for (const sample of samples) {
      const sfxName = COM.DefaultExtension(sample, '.wav');
      const sfx = this.PrecacheSound(sfxName);
      if (sfx) {
        this.StartSound(CL.state.viewentity, 0, sfx, this._listenerOrigin, 1.0, 1.0);
      }
    }
  },

  PlayVol_f(...args) {
    if (this._nosound.value !== 0) {
      return;
    }
    // e.g. "playvol misc/hit1 0.5 misc/hit2 0.2"
    for (let i = 0; i < args.length; i += 2) {
      const sfxName = COM.DefaultExtension(args[i], '.wav');
      const volume = Q.atof(args[i + 1] || 0);
      const sfx = this.PrecacheSound(sfxName);
      if (sfx) {
        this.StartSound(CL.state.viewentity, 0, sfx, this._listenerOrigin, volume, 1.0);
      }
    }
  },

  //
  // --- Per-frame updates
  //

  UpdateAmbientSounds() {
    if (!CL.state.worldmodel) {
      for (const ch of this._ambientChannels) {
        ch.channel_vol = 0;
        ch.updateVol();
      }

      // no map yet
      return;
    }

    const l = Mod.PointInLeaf(this._listenerOrigin, CL.state.worldmodel);
    if (!l || this._ambientLevel.value === 0) {
      // turn off all ambients

      for (const ch of this._ambientChannels) {
        ch.channel_vol = 0;
        ch.updateVol();
      }
      return;
    }

    // ramp up/down volumes
    for (let i = 0; i < this._ambientChannels.length; i++) {
      const ch = this._ambientChannels[i];
      let vol = this._ambientLevel.value * l.ambient_level[i];
      if (vol < 8.0) {
        vol = 0.0;
      }
      vol /= 255.0;

      // fade
      if (ch.master_vol < vol) {
        ch.master_vol += (Host.frametime * this._ambientFade.value) / 255.0;
        if (ch.master_vol > vol) {
          ch.master_vol = vol;
        }
      } else if (ch.master_vol > vol) {
        ch.master_vol -= (Host.frametime * this._ambientFade.value) / 255.0;
        if (ch.master_vol < vol) {
          ch.master_vol = vol;
        }
      }

      if (ch.master_vol > 1.0) {
        ch.master_vol = 1.0;
      }

      ch.channel_vol = ch.master_vol;

      ch.updateVol();
    }
  },

  UpdateDynamicSounds() {
    for (let i = 0; i < this._channels.length; i++) {
      const ch = this._channels[i];

      if (!ch || !ch.sfx) {
        continue;
      }

      if (Host.realtime >= ch.end) {
        const sc = ch.sfx.cache;
        // If it's looped, try to wrap around
        if (sc.loopstart !== null) {
          ch.updateLoop();
        } else {
          // no longer needed, release channel
          ch.reset();
          continue;
        }
      }

      // Re-Spatialize
      ch.spatialize();
    }
  },

  UpdateStaticSounds() {
    // Spatialize all static channels
    for (const ch of this._staticChannels) {
      ch.spatialize();

      // Only load sound files when really needed
      if (ch.sfx.state === SFX.STATE.NEW && ch.channel_vol > 0) {
        ch.sfx.load().catch((err) => {
          Con.Print(`S.UpdateStaticSounds: failed to lazy load ${ch.sfx.name}, ${err.message}\n`);
        });
      }
    }

    // Combine channels that share the same sfx
    for (let i = 0; i < this._staticChannels.length; i++) {
      const ch = this._staticChannels[i];
      if (ch.channel_vol <= 0.0) {
        continue;
      }
      for (let j = i + 1; j < this._staticChannels.length; j++) {
        const ch2 = this._staticChannels[j];
        if (ch.sfx === ch2.sfx) {
          // Weighted average for pan
          const totalVol = ch.channel_vol + ch2.channel_vol;
          if (totalVol > 0) {
            ch.pan = (ch.pan * ch.channel_vol + ch2.pan * ch2.channel_vol) / totalVol;
            ch.channel_vol = totalVol;
          }
          ch2.channel_vol = 0.0;
        }
      }
    }
  },

  /**
   * Respatialize all sounds based on the current listener position/orientation.
   * @param {Vector} origin origin
   * @param {Vector} forward angle vector forward
   * @param {Vector} right angle vector right
   * @param {Vector} up angle vector up
   * @param {boolean} underwater whether the listener is underwater (for special effects)
   */
  Update(origin, forward, right, up, underwater) {
    if (this._nosound.value !== 0) {
      return;
    }

    // Copy listener info
    this._listenerOrigin[0] = origin[0];
    this._listenerOrigin[1] = origin[1];
    this._listenerOrigin[2] = origin[2];

    this._listenerForward[0] = forward[0];
    this._listenerForward[1] = forward[1];
    this._listenerForward[2] = forward[2];

    this._listenerRight[0] = right[0];
    this._listenerRight[1] = right[1];
    this._listenerRight[2] = right[2];

    this._listenerUp[0] = up[0];
    this._listenerUp[1] = up[1];
    this._listenerUp[2] = up[2];

    this._listenerUnderwater = underwater;

    // Bound volume [0..1]
    if (this.volume.value < 0.0) {
      Cvar.Set('volume', 0.0);
    } else if (this.volume.value > 1.0) {
      Cvar.Set('volume', 1.0);
    }

    this.UpdateAmbientSounds();
    this.UpdateDynamicSounds();
    this.UpdateStaticSounds();
  },

  /**
   * Plays a local sound (non-spatialized)
   * @param {SFX} sfx sound to play
   */
  LocalSound(sfx) {
    // Plays a sound at the view entity, entchannel = -1
    this.StartSound(CL.state.viewentity, -1, sfx, Vector.origin, 1.0, 1.0);
  },

  _MakeUnderwaterChain({
    cutoffHz = 900,       // main muffling cutoff
    highShelfCut = -18,   // dB cut above ~1 kHz
    lowShelfBoost = 3,    // gentle bass lift
    wobbleHz = 0.25,      // LFO speed; set 0 to disable
    wobbleDepth = 250,    // Hz of cutoff modulation
  } = {}) {
    const input = this._context.createGain();
    const output = this._context.createGain();

    // Tone-shaping
    const lowShelf = this._context.createBiquadFilter();
    lowShelf.type = 'lowshelf';
    lowShelf.frequency.value = 120;
    lowShelf.gain.value = lowShelfBoost;

    // Two cascaded lowpasses → steeper slope
    const lp1 = this._context.createBiquadFilter();
    lp1.type = 'lowpass';
    lp1.frequency.value = cutoffHz;
    lp1.Q.value = 0.6;

    const lp2 = this._context.createBiquadFilter();
    lp2.type = 'lowpass';
    lp2.frequency.value = cutoffHz;
    lp2.Q.value = 0.6;

    const highShelf = this._context.createBiquadFilter();
    highShelf.type = 'highshelf';
    highShelf.frequency.value = 1000;
    highShelf.gain.value = highShelfCut;

    // (Optional) a couple of allpass filters to smear transients slightly
    const ap1 = this._context.createBiquadFilter(); ap1.type = 'allpass'; ap1.frequency.value = 600;
    const ap2 = this._context.createBiquadFilter(); ap2.type = 'allpass'; ap2.frequency.value = 1400;

    // Dynamics to tame plosives/attacks (water is dense!)
    const comp = this._context.createDynamicsCompressor();
    comp.threshold.value = -26;
    comp.knee.value = 20;
    comp.ratio.value = 4;
    comp.attack.value = 0.003;
    comp.release.value = 0.25;

    // Wire it up
    input
      .connect(lowShelf)
      .connect(lp1)
      .connect(lp2)
      .connect(highShelf)
      .connect(ap1)
      .connect(ap2)
      .connect(comp)
      .connect(output);

    // Optional slow wobble of the cutoff → “pressure” vibe
    if (wobbleHz > 0 && wobbleDepth > 0) {
      const lfo = this._context.createOscillator();
      const lfoGain = this._context.createGain();
      lfo.frequency.value = wobbleHz;
      lfoGain.gain.value = wobbleDepth;       // Hz of modulation
      lfo.connect(lfoGain);
      // Modulate both lowpasses together
      lfoGain.connect(lp1.frequency);
      lfoGain.connect(lp2.frequency);
      lfo.start();
    }

    // Expose I/O
    return { input, output };
  },
};

export default S;
