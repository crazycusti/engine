

## Source Directories

- Source code is located in the `source/` directory.
- The engine is organized in `source/engine/` and is divided into subdirectories based on functionality:
  - `source/engine/common/` - Shared code between client and server.
  - `source/engine/client/` - Client-specific code, such as rendering, input, and audio.
  - `source/engine/server/` - Server-specific code.
  - `source/engine/network/` - Networking code such as protocols and message handling.
- The game is organized in `source/game/` and follows a slightly different structure:
  - `source/game/id1/` - the original Quake game logic.
  - `source/game/baseq2/` - (future) Quake II game logic.
  - Game code must never directly import files from the engine; it should only use the public API exposed by the engine.
- There is code which is shared between the engine and game, located in `source/shared/`.
  - The idea is to keep engine-agnostic code here, such as math utilities, data structures, and algorithms.
  - Data structures and types implemented or declared in the engine, can be re-exported here.
