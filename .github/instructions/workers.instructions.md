
This code base contains an abstraction of Node Workers and Web Workers to allow running server code in both Node.js and the browser.

Communication between the main thread and workers is done using message passing over the eventBus. The worker code listens for messages from the main thread, processes them, and sends back responses.

Take a look at `source/engine/server/DummyWorker.mjs` for an example implementation of a worker that can run in both Node.js and the browser.

Another good example is `source/engine/server/NavigationWorker.mjs` which runs pathfinding calculations in a separate thread to avoid blocking the main server thread.
