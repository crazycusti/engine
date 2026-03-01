# The Quake Shack Engine

This is a modern JavaScript port of Quake 1 with some features sprinkled on top.

Added features include but not limited to:

* Dedicated server running in node.js with a console shell.
* Improved resource loading using asynchronous code.
* Support for client-side game code.
* 32-bit texture support.
* WAD3 file support and texture support.
* Colored dynamic and static lighting support, supporting both BSPX/RGBLIGHTING lumps and `.lit` files.
* [PBR materials](./docs/qsmat-format.md) support.
* Slightly improved console subsystem.
* Smooth animations using lerping.
* Somewhat optimized network code.
* Navigation mesh for smarter NPC behavior.
* Multithreading support.
* Limited BSPX support:
  * `LIGHTINGDIR`: used for per-pixel lighting on supported materials.
  * `RGBLIGHTING`: used for colorful lightmaps.
  * `LIGHTGRID_OCTREE`: used for smoothly lighting dynamically moving objects.
  * `BRUSHLIST`: used for non-hull collision detection using Quake 2 based Pmove code path
* Support for `LMSCALE`/`_lightmap_scale`, supporting higher resolution lightmaps.
* BSP2 format support for large maps.
* Static skybox support, like in Half-Life 1 and Quake 2.
* Automatic area portals infrastructure for dynamic sound and rendering culling, though experimental.
* Semi-transparent model (through `alpha` entity key) support.
* [Volumetric fog support](./docs/volumetric-fog.md) through `func_fog` and opt-in for automatically fogging turbulents.
* Peer-to-peer multiplayer support using [WebRTC](./docs/webrtc.md).

Yet, there is still plenty to do.

Some features on the roadmap:

* Semi-transparent turbulent (water, lava, slime) support.
* Proper WAD3 support when maps refer them, loading them from external WAD, if not compiled in.
* Better network code with client-side prediction.
* More flexible rendering subsystem, making it easier to reuse model rendering etc.
* HLBSP/BSP30 support.

This is an educational and recreational project.
Though the vision is to provide an id tech 2 based game engine running in the browser for fun multiplayer projects.
The engine is supposed to be extensible and fun to work with. Made for boomer shooter enthusiasts.

Work on this project is supported by LLMs. Please read [LLM.md](./LLM.md) for more information on this matter.

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
npm run dedicated:start
```

Open http://localhost:3000/ and enjoy hacking.

### Production environment

The dedicated server can be started using `npm run dedicated:start`, but this will run with many `console.assert(…)` in hot paths and is only really suitable for development work.

That’s why you should compile the dedicated server with `npm run dedicated:build:production` and start it using `npm run dedicated:start:production`.

### Deploy to a CDN

You can deploy the built frontend code to a CDN such as Cloudflare and skip the virtual Quake filesystem by providing the URL where to get the game assets (basically everything extracted from the pak files) from.

You can set a custom URL to serve the assets like this:

```sh
VITE_CDN_URL_PATTERN="https://cdn{shard}.example.net/{gameDir}/{filename}"
```

However, it’s not necessary to provide a different URL, per default it will try to load files from `/qfs/{filename}`. You can skip the `{gameDir}` part, if you only want to serve one mod or the original game (`id1`).

Also `{shard}` is not required, but highly recommended to speed up fetching assets.

Next run `npm run build:production` to build for production.

In `dist/browser/` you’ll have everything you need to upload to your static web server or CDN provider.

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

### Dedicated metrics to InfluxDB

For long-running debugging you can enable periodic dedicated-server metrics export to InfluxDB.
Both InfluxDB v1 and v2 are supported.

Enable via environment variables before launch (v2 example):

```sh
INFLUXDB_ENABLE=1 \
INFLUXDB_VERSION=2 \
INFLUXDB_URL="http://127.0.0.1:8086" \
INFLUXDB_ORG="my-org" \
INFLUXDB_BUCKET="quakeshack" \
INFLUXDB_TOKEN="your-token" \
./dedicated.mjs -ip ::1 -port 3000
```

Or set at runtime via console/cfg (v2):

```cfg
seta influxdb_enable 1
seta influxdb_version 2
seta influxdb_url "http://127.0.0.1:8086"
seta influxdb_org "my-org"
seta influxdb_bucket "quakeshack"
set influxdb_token "your-token"
seta influxdb_interval 10
```

v1 example:

```cfg
seta influxdb_enable 1
seta influxdb_version 1
seta influxdb_url "http://127.0.0.1:8086"
seta influxdb_database "quakeshack"
seta influxdb_username "admin"
set influxdb_password "secret"
seta influxdb_retention_policy "autogen"
seta influxdb_precision "ms"
```

Relevant cvars:

- `influxdb_enable`
- `influxdb_version` (`auto|1|2`)
- `influxdb_url`
- `influxdb_database` (v1)
- `influxdb_username` (v1)
- `influxdb_password` (v1)
- `influxdb_retention_policy` (v1)
- `influxdb_consistency` (v1)
- `influxdb_token`
- `influxdb_org`
- `influxdb_bucket`
- `influxdb_precision` (`ns|us|ms|s`, default `ms`)
- `influxdb_tags` (global tags, e.g. `env=dev,instance=local`)
- `influxdb_interval` (seconds)
- `influxdb_batch_size`
- `influxdb_max_queue`
- `influxdb_timeout_ms`
- `influxdb_measurement_prefix`

### Extending and hacking

These are the important directory structures:

| Directory | Description |
| - | - |
| data/id1 | game assets like pak files etc. |
| source/game/id1 | game code for id1 |
| source/engine/client | anything client-code related |
| source/engine/server | anything server-code related |
| source/engine/common | everything used in both client and server code |
| source/engine/network | networking code |
| source/shared | code that is used in both engine and game code |


There are two main entrypoints:

| File | Description |
| - | - |
| source/engine/main-browser.mjs | launcher for a full browser session |
| source/engine/main-dedicated.mjs | launcher for a dedicated server |

Please also checkout the [documentation](./docs/). There are many more features that have been added to the original engine.

## Based on the work of

* https://github.com/lrusso/Quake1 (original port to the browser)
* https://github.com/id-Software/Quake (QuakeWorld)
* https://github.com/id-Software/Quake-2 (Quake 2)
* https://github.com/andrei-drexler/ironwail (implementation details of some new features)
* https://github.com/fte-team/fteqw (understanding the BSPX features in detail)
