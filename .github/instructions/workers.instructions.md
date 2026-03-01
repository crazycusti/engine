
This code base contains a unified Worker abstraction (`PlatformWorker`) that works across
both Node.js (`worker_threads`) and the browser (Web Workers).

Communication between the main thread and workers is done using message passing over the
eventBus. The worker code listens for messages from the main thread, processes them, and
sends back responses.

### Key files

- `source/engine/common/PlatformWorker.mjs` — Single worker wrapper that detects the
  platform at module load and normalises message, error, and shutdown APIs.
- `source/engine/common/WorkerFactories.mjs` — Maps worker names to factory functions
  using the `new Worker(new URL(...))` pattern for Vite static analysis. New workers
  **must** be registered here.
- `source/engine/common/WorkerManager.mjs` — Orchestrator that spawns workers and
  bridges the eventBus between the main thread and worker threads.
- `source/engine/common/WorkerFramework.mjs` — Bootstrap code that runs **inside** a
  worker thread; sets up a lean registry, Con proxy, and message bridge.

### Adding a new worker

1. Create the worker script in `source/engine/server/` (see `DummyWorker.mjs` for an example).
   The filename **must** end in `Worker.mjs`.
2. Register it in `WorkerFactories.mjs` with a `new Worker(new URL(...))` factory.

The dedicated build automatically discovers `*Worker.mjs` files and bundles them
into `dist/dedicated/workers/` via a secondary Rollup pass
(`dedicatedWorkerBundlePlugin` in `vite.config.dedicated.mjs`).

### How the Worker global works in Node.js

The dedicated server entry (`main-dedicated.mjs`) polyfills `globalThis.Worker` with
`worker_threads.Worker` so that `WorkerFactories.mjs` can use the same
`new Worker(url, opts)` constructor on every platform.
