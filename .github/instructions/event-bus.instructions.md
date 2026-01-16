
## Event Bus System

- To avoid circular dependencies, the event bus is used for certain lifecycle events and business logic events.
- All events are documented in `docs/events.md`.
- The game code can subscribe to engine events and vice versa.
- The engine can forcefully unsubscribe all listeners from the game when unloading it.
- Event bus will also allow communication between workers.
