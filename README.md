# The Quake Shack Engine

This is a modern JavaScript port of Quake 1 with some features sprinkled on top.

Added features include but not limited to:

* Dedicated server running in node.js with a console shell.
* Improved resource loading using asynchroneous code.
* Support for client-side game code.
* 32-bit texture support.
* WAD3 file support and texture support.
* Colored dynamic lighting support.
* Slightly improved console subsystem.
* Smooth animations using lerping.
* Somewhat optimized network code.
* Navigation mesh for smarter NPC behavior.
* Limited multithreading support.
* Limited BSPX support:
  * `LIGHTINGDIR`: used for per-pixel lighting on supported materials.
  * `RGBLIGHTING`: used for colorful lightmaps.
  * `LIGHTGRID_OCTREE`: used for smoothly lighting dynamically moving objects.
* Support for `LMSCALE`/`_lightmap_scale`, supporting higher resolution lightmaps.
* BSP2 format support for large maps.

Yet, there is still plenty to do.

Some features on the roadmap:

* Proper WAD3 support when maps refer them, loading them from external WAD, if not compiled in.
* Better network code with client-side predicition.
* More flexible rendering subsystem, making it easier to reuse model rendering etc.
* HLBSP/BSP30 support.

This is an educational and recreational project.
Though the vision is to provide an id tech 2 based game engine running in the browser for fun multiplayer projects.
The engine is supposed to be extensible and fun to work with. Made for boomer shooter enthusiasts.

## Documentation

### Turn-key ready build and deploy

Use Docker to build and start a container:

```sh
# make sure that the game repo is also cloned
git submodule update --init

# build the container image
./build.sh

# start the container
docker run --rm -ti -p 3000:3000 quakeshack
```

Open http://localhost:3000/ and enjoy the game.

This repository comes with the Quake 1 shareware game assets and computed navigation graphs for the first episode.

### Development environment

Firstly, you need to install the dependencies and tools (eslint, vite):

```sh
npm install
```

Also, make sure that the game repo is cloned:

```sh
git submodule update --init
```

Next, you need to start both the dedicated server and vite watcher like so:

```sh
# start vite in development mode in the background
npm run dev &

# start the dedicated server to serve both the virtual Quake filesystem and whatever vite is building for you
./dedicated.mjs -ip ::1 -port 3000
```

Open http://localhost:3000/ and enjoy hacking.

### Deploy to a CDN

You can deploy the built frontend code to a CDN such as Cloudflare and skip the virtual Quake fileystem by providing the URL where to get the game assets (basically everything extracted from the pak files) from.

You can set a custom URL to serve the assets like this:

```sh
VITE_CDN_URL_PATTERN="https://cdn.example.net/{gameDir}/{filename}"
```

However, it’s not necessary to provide a different URL, per default it will try to load files from `/qfs/{filename}`. You can skip the `{gameDir}` part, if you only want to serve one mod or the original game (`id1`).

Next run `npm run build:production` to build for production.

In `dist/` you’ll have everything you need to upload to your static web server or CDN provider.

**Tip**: Make sure to set the max-age as low as possible for `/index.html` so you can quickly rollout a new version. Each update will produce a different hash for cache busting.

### Launching a multiplayer session

It’s straight forward like back in WinQuake, start the dedicated server and type in:

```
maxplayers 8
coop 1
map e1m1
```

In your browser’s game console you can type in:

```
connect self
```

The `connect self` command will connect to the same webserver hosting the game frontend.

### Extending and hacking

These are the important directory structures:

| Directory | Description |
| - | - |
| data/id1 | game assets like pak files etc. |
| source/game/id | game code for id1 |
| engine/client | anything client-code related |
| engine/server | anything server-code related |
| engine/common | everything used in both client and server code |
| engine/network | networking code |
| shared | code that is used in both engine and game code |


There are two main entrypoints:

| File | Description |
| - | - |
| source/engine/main-browser.mjs | launcher for a full browser session |
| source/engine/main-dedicated.mjs | launcher for a dedicated server |


## Based on the work of

* https://github.com/lrusso/Quake1 (original port to the browser)
* https://github.com/id-Software/Quake (QuakeWorld)
