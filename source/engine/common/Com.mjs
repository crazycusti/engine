
import { registry, eventBus } from '../registry.mjs';

import Q from '../../shared/Q.mjs';
import { CorruptedResourceError } from './Errors.mjs';

import Cvar from './Cvar.mjs';
import W from './W.mjs';
import Cmd from './Cmd.mjs';
import { defaultBasedir, defaultGame } from './Def.mjs';

let { Con, Sys } = registry;

eventBus.subscribe('registry.frozen', () => {
  Con = registry.Con;
  Sys = registry.Sys;
});

/** @typedef {{ name: string; filepos: number; filelen: number;}[]} PackFile */
/** @typedef {{filename: any; pack: PackFile[];}} SearchPath */

export default class COM {
  /** @type {string[]} */
  static argv = [];

  /** @type {SearchPath[]} */
  static searchpaths = [];

  static hipnotic = false;
  static rogue = false;
  static standard_quake = true;
  static modified = false;

  /** @type {Function} */
  static LittleLong = null; // set in COM.Init

  /** @type {Cvar} */
  static registered = null;

  /** @type {Cvar|string} */ // FIXME: string turns into Cvar when jumping from InitArgv to Init
  static cmdline = null;

  /** @type {?AbortController} */
  static abortController = null;

  /** @type {SearchPath[]} */
  static gamedir = null;

  /** @type {string} mod name */
  static game = defaultGame;

  static DefaultExtension(path, extension) {
    for (let i = path.length - 1; i >= 0; i--) {
      const src = path.charCodeAt(i);
      if (src === 47) {
        break;
      }
      if (src === 46) {
        return path;
      }
    }
    return path + extension;
  }

  /**
   * Quake style parser.
   * @param {string} data string to parse
   * @returns {{token: string, data: string|null}} parsed token and remaining data to parse
   */
  static Parse(data) { // FIXME: remove charCodeAt code
    let token = '';
    let i = 0; let c;
    if (data.length === 0) {
      return { token, data: null };
    }

    let skipwhite = true;
    for (; ;) {
      if (skipwhite !== true) {
        break;
      }
      skipwhite = false;
      for (; ;) {
        if (i >= data.length) {
          return { token, data: null };
        }
        c = data.charCodeAt(i);
        if (c > 32) {
          break;
        }
        i++;
      }
      if ((c === 47) && (data.charCodeAt(i + 1) === 47)) {
        for (; ;) {
          if ((i >= data.length) || (data.charCodeAt(i) === 10)) {
            break;
          }
          i++;
        }
        skipwhite = true;
      }
    }

    if (c === 34) {
      i++;
      for (; ;) {
        c = data.charCodeAt(i);
        i++;
        if ((i >= data.length) || (c === 34)) {
          return { token, data: data.substring(i) };
        }
        token += String.fromCharCode(c);
      }
    }

    for (; ;) {
      if ((i >= data.length) || (c <= 32)) {
        break;
      }
      token += String.fromCharCode(c);
      i++;
      c = data.charCodeAt(i);
    }

    return { token, data: data.substring(i) };
  };

  static CheckParm(parm) {
    for (let i = 1; i < this.argv.length; i++) {
      if (this.argv[i] === parm) {
        return i;
      }
    }

    return null;
  };

  /**
   * Gets parameter from command line.
   * @param {string} parm parameter name
   * @returns {string|null} value of the parameter or null if not found
   */
  static GetParm(parm) {
    for (let i = 1; i < this.argv.length; i++) {
      if (this.argv[i] === parm) {
        return this.argv[i + 1] || null;
      }
    }

    return null;
  };

  static async CheckRegistered() {
    const h = await this.LoadFileAsync('gfx/pop.lmp');
    if (h === null) {
      Con.PrintSuccess('Playing shareware version.\n');
      eventBus.publish('com.registered', false);
      return false;
    }
    const check = new Uint8Array(h);
    const pop = [
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x66, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x66, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x66, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x67, 0x00, 0x00,
      0x00, 0x00, 0x66, 0x65, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x65, 0x66, 0x00,
      0x00, 0x63, 0x65, 0x61, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x61, 0x65, 0x63,
      0x00, 0x64, 0x65, 0x61, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x61, 0x65, 0x64,
      0x00, 0x64, 0x65, 0x64, 0x00, 0x00, 0x64, 0x69, 0x69, 0x69, 0x64, 0x00, 0x00, 0x64, 0x65, 0x64,
      0x00, 0x63, 0x65, 0x68, 0x62, 0x00, 0x00, 0x64, 0x68, 0x64, 0x00, 0x00, 0x62, 0x68, 0x65, 0x63,
      0x00, 0x00, 0x65, 0x67, 0x69, 0x63, 0x00, 0x64, 0x67, 0x64, 0x00, 0x63, 0x69, 0x67, 0x65, 0x00,
      0x00, 0x00, 0x62, 0x66, 0x67, 0x69, 0x6A, 0x68, 0x67, 0x68, 0x6A, 0x69, 0x67, 0x66, 0x62, 0x00,
      0x00, 0x00, 0x00, 0x62, 0x65, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x65, 0x62, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x62, 0x63, 0x64, 0x66, 0x64, 0x63, 0x62, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x62, 0x66, 0x62, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x61, 0x66, 0x61, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x65, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x64, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ];
    for (let i = 0; i < 256; i++) {
      if (check[i] !== pop[i]) {
        throw new CorruptedResourceError('gfx/pop.lmp', 'not genuine registered version');
      }
    }
    this.registered.set(true);
    Con.PrintSuccess('Playing registered version.\n');
    eventBus.publish('com.registered', true);
    return true;
  }

  static InitArgv(argv) {
    this.cmdline = (argv.join(' ') + ' ').substring(0, 256);
    for (let i = 0; i < argv.length; i++) {
      this.argv[i] = argv[i];
    }
    if (this.CheckParm('-safe')) {
      this.argv[this.argv.length] = '-nosound';
      this.argv[this.argv.length] = '-nocdaudio';
      this.argv[this.argv.length] = '-nomouse';
    }
    if (this.CheckParm('-rogue')) {
      this.rogue = true;
      this.standard_quake = false;
    } else if (this.CheckParm('-hipnotic')) {
      this.hipnotic = true;
      this.standard_quake = false;
    }

    eventBus.publish('com.argv.ready');
  }

  static async Init() {
    const swaptest = new ArrayBuffer(2);
    const swaptestview = new Uint8Array(swaptest);
    swaptestview[0] = 1;
    swaptestview[1] = 0;
    if ((new Uint16Array(swaptest))[0] === 1) { // CR: I’m pretty sure this is not useful in JavaScript at all
      this.LittleLong = (function (l) {
        return l;
      });
    } else {
      this.LittleLong = (function (l) {
        return (l >>> 24) + ((l & 0xff0000) >>> 8) + (((l & 0xff00) << 8) >>> 0) + ((l << 24) >>> 0);
      });
    }

    this.abortController = new AbortController();

    this.registered = new Cvar('registered', '0', Cvar.FLAG.READONLY, 'Set to 1, when not playing shareware.');
    // @ts-ignore: need to fix that later, this.cmdline is a string first, but then it’s turned into a Cvar.
    this.cmdline = new Cvar('cmdline', this.cmdline, Cvar.FLAG.READONLY, 'Command line used to start the game.');

    Cmd.AddCommand('path', this.Path_f);

    await this.InitFilesystem();
    await this.CheckRegistered();

    await W.LoadPalette('gfx/palette.lmp'); // CR: we early load the palette here, it’s needed in both dedicated and browser processes

    Sys.Print('COM.Init: low-level initialization completed.\n');

    eventBus.publish('com.ready');
  }

  static Shutdown() {
    Sys.Print('COM.Shutdown: signaling outstanding promises to abort\n');

    this.abortController.abort('COM.Shutdown');
  }

  static Path_f() {
    Con.Print('Files are served from the unified virtual filesystem.\n');
  }

  static WriteFile(filename, data, len) {
    filename = filename.toLowerCase();
    const dest = [];
    for (let i = 0; i < len; i++) {
      dest[i] = String.fromCharCode(data[i]);
    }
    try {
      localStorage.setItem('Quake.' + this.searchpaths[this.searchpaths.length - 1].filename + '/' + filename, dest.join(''));
    } catch (e) {
      Sys.Print('COM.WriteFile: failed on ' + filename + ', ' + e.message + '\n');
      return false;
    }
    Sys.Print('COM.WriteFile: ' + filename + '\n');
    return true;
  };

  static WriteTextFile(filename, data) {
    filename = filename.toLowerCase();
    try {
      localStorage.setItem('Quake.' + this.searchpaths[this.searchpaths.length - 1].filename + '/' + filename, data);
    } catch (e) {
      Sys.Print('COM.WriteTextFile: failed on ' + filename + ', ' + e.message + '\n');
      return false;
    }
    Sys.Print('COM.WriteTextFile: ' + filename + '\n');
    return true;
  };

  static GetNetpath(filename, gameDir = null) {
    if (gameDir === null) {
      gameDir = this.GetGamedir();
    }

    if (registry.urlFns && typeof registry.urlFns.cdnURL === 'function') {
      return registry.urlFns.cdnURL(filename, gameDir);
    }

    return `${location.protocol}//${location.host}/qfs/${filename}`;
  }

  /**
   * Get the current game directory
   * @returns {string} game name, e.g. 'id1'
   */
  static GetGamedir() {
    return this.searchpaths.length > 0
      ? this.searchpaths[this.searchpaths.length - 1].filename
      : defaultGame;
  }

  /**
   * @param {string} filename virtual filename
   * @returns {ArrayBuffer} binary content
   * @deprecated this blocks the main thread – use async version instead
   */
  static LoadFile(filename) {
    console.trace('sync IO requested', filename);

    filename = filename.toLowerCase();

    const xhr = new XMLHttpRequest();
    xhr.overrideMimeType('text/plain; charset=x-user-defined');

    eventBus.publish('com.fs.being', filename);

    // Determine file path based on active game directory
    const gameDir = this.GetGamedir();
    const netpath = this.GetNetpath(filename, gameDir);

    // 1) Try localStorage first
    const localData = localStorage.getItem(`Quake.${gameDir}/${filename}`);
    if (localData !== null) {
      Sys.Print(`COM.LoadFile: ${netpath} (localStorage)\n`);
      eventBus.publish('com.fs.end', filename);
      return Q.strmem(localData);
    }

    // 2) Load from pre-merged filesystem (all PAKs and priorities resolved at build time)
    xhr.open('GET', netpath, false);
    try {
      xhr.send();
    } catch {
      // File doesn't exist
    }

    if (xhr.status >= 200 && xhr.status <= 299) {
      Sys.Print(`COM.LoadFile: ${netpath}\n`);
      eventBus.publish('com.fs.end', filename);
      return Q.strmem(xhr.responseText);
    }

    // File not found
    Sys.Print(`COM.LoadFile: can't find ${filename}\n`);
    eventBus.publish('com.fs.end', filename);
    return null;
  };

  /**
   * @param {string} filename virtual filename
   * @returns {Promise<ArrayBuffer>} binary content
   */
  static async LoadFileAsync(filename) {
    filename = filename.toLowerCase();

    eventBus.publish('com.fs.being', filename);

    // Determine file path based on active game directory
    const gameDir = this.GetGamedir();
    const netpath = this.GetNetpath(filename, gameDir);

    // 1) Try localStorage first
    const localData = localStorage.getItem(`Quake.${gameDir}/${filename}`);
    if (localData !== null) {
      Sys.Print(`COM.LoadFileAsync: ${netpath} (localStorage)\n`);
      eventBus.publish('com.fs.end', filename);
      return Q.strmem(localData);
    }

    // 2) Load from pre-merged filesystem (all PAKs and priorities resolved at build time)
    try {
      const directResponse = await fetch(netpath, {
        signal: this.abortController.signal,
      });

      if (directResponse.ok) {
        const data = await directResponse.arrayBuffer();
        Sys.Print(`COM.LoadFileAsync: ${netpath}\n`);
        eventBus.publish('com.fs.end', filename);
        return data;
      }
    } catch {
      // File doesn't exist
    }

    // File not found
    Sys.Print(`COM.LoadFileAsync: can't find ${filename}\n`);
    eventBus.publish('com.fs.end', filename);
    return null;
  }

  /**
   * Lods a text file.
   * @param {string} filename filename
   * @returns {string} content of the file as a string
   * @deprecated use async version instead
   */
  static LoadTextFile(filename) {
    const buf = this.LoadFile(filename);
    if (buf === null) {
      return null;
    }
    const bufview = new Uint8Array(buf);
    const f = [];
    for (let i = 0; i < bufview.length; i++) {
      if (bufview[i] !== 13) {
        f[f.length] = String.fromCharCode(bufview[i]);
      }
    }
    return f.join('');
  }

  /**
   * Loads a text file.
   * @param {string} filename filename
   * @returns {Promise<string>} content of the file as a string
   */
  static async LoadTextFileAsync(filename) {
    const buf = await this.LoadFileAsync(filename);
    if (buf === null) {
      return null;
    }
    const bufview = new Uint8Array(buf);
    const f = [];
    for (let i = 0; i < bufview.length; i++) {
      if (bufview[i] !== 13) {
        f[f.length] = String.fromCharCode(bufview[i]);
      }
    }
    return f.join('');
  };

  /**
   * Add a game directory to the search path.
   * Note: PAK files are pre-extracted at build time, so we only track the directory.
   * @param {string} dir - directory name (e.g., 'id1', 'hellwave')
   */
  static async AddGameDirectory(dir) {
    /** @type {SearchPath} */
    const search = { filename: dir, pack: [] };
    this.searchpaths[this.searchpaths.length] = search;
    Con.Print(`Added game directory: ${dir}\n`);
  };

  static async InitFilesystem() {
    let search;

    let i = this.CheckParm('-basedir');
    if (i !== null) {
      search = this.argv[i + 1];
    }
    if (search !== undefined) {
      await this.AddGameDirectory(search);
    } else {
      await this.AddGameDirectory(defaultBasedir);
    }

    if (this.rogue === true) {
      await this.AddGameDirectory('rogue');
    } else if (this.hipnotic === true) {
      await this.AddGameDirectory('hipnotic');
    }

    i = this.CheckParm('-game');
    if (i !== null) {
      search = this.argv[i + 1];
      if (search !== undefined) {
        this.modified = true;
        this.game = search;
        await this.AddGameDirectory(search);
      }
    } else if (defaultGame !== defaultBasedir) {
      this.game = defaultGame;
      this.modified = true;
      await this.AddGameDirectory(defaultGame);
    }

    this.gamedir = [this.searchpaths[this.searchpaths.length - 1]];
  }
};
