
## Architecture

This code is based on WinQuake, although it has been adapted for modern web technologies and added many new features. Some are backported from Quake 2, some of them are original to this project.

### Client-Server-Master Architecture

The architecture consists of a client, server, and master server. The client and server can run in the same process (listen server) or in separate processes (dedicated server). The master server keeps track of public game servers and allows clients to find them.

### Client

The client is responsible for rendering, input handling, audio, and user interface. It communicates with the server to receive game state updates and send player actions. The client code is executed in Chrome or Firefox using WebGL for rendering and Web Audio API for audio.

### Server

The server manages the game state, processes player actions, and enforces game rules. It communicates with clients to send game state updates and receive player actions. The server code can run in node.js and uses WebSockets for network communication. The server code can also be run in the browser for listen servers and allows players to join via WebRTC peer-to-peer connections.

### Single player

In single player mode, both the client and server run in the same process. The client sends player actions directly to the server, and the server updates the game state and sends it back to the client using the loopback driver implementation.

## Origins

The code is originally based on WinQuake almost verbatim, however the goal of this project is to replace almost all of the original code with new implementations. The architecture is still inspired by id tech 3, GoldSrc engine and the Source engine. However, the code is not a direct port of those, but rather a new implementation that takes advantage of modern web technologies and design patterns.

