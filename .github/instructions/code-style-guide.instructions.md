Here is the code style guide for the QuakeShack Engine.
Please follow these rules when writing or modifying code.

## JSDoc Documentation

### General Rules

1.  **Always use JSDoc** for class properties instead of inline comments.
2.  **No `@returns {void}` annotations** - It's implied.
3.  **Avoid vague types** - Never use `unknown`, `*`, or `any`.
    - Example: Use `ArrayBuffer` instead of `any` for data.
4.  **No generic `object` type** - Create proper typedefs instead.
    - Example: Define `WorldspawnInfo` as `Record<string, string>` instead of just `object`.
    - In case an object is not really defined it, consider defining it.
5.  **Use specific types from imports**.

## Registry and Global Variables

### Registry Pattern

- **ALWAYS use destructuring** to get registry modules in EVERY file.
- **NEVER access registry modules directly** via properties (e.g., `registry.Con`).
- **Always include the destructuring prolog** at the top of the file, wrapped in a `registry.frozen` event listener if necessary.
- **Do not carry registry items in context objects**; they are singletons.

**Correct Pattern:**

```javascript
let { CL, COM, Con, Host, Mod, SCR, SV, Sys, V } = registry;

eventBus.subscribe("registry.frozen", () => {
  ({ CL, COM, Con, Host, Mod, SCR, SV, Sys, V } = registry);
});
```

### Registry Contents

- **In Registry:** `CL`, `COM`, `Con`, `Host`, `Mod`, `SCR`, `SV`, `Sys`, `V`.
- **NOT in Registry:** `GL` (import directly), `Cmd`, `Cvar`.

### Event Bus Usage

Use `eventBus` for **business logic events and lifecycle hooks**.

- **Good Candidates:** `'registry.frozen'`, `'gl.ready'`, `'game.start'`, `'model.loaded'`, `'player.spawn'`, `'frame.start'`.
- **Poor Candidates:** Direct function calls, return values needed, tight coupling, hot paths.
- All events are documented in `docs/events.md`.

### Global GL Context

- Use the global `gl` from the registry (accessible via `GL.gl` after `'gl.ready'`) instead of passing it as a parameter.

## File Organization

### No index.mjs Files

- **Avoid barrel exports**. Use direct imports instead.
- Example: Import `BrushModelRenderer` from `./renderer/BrushModelRenderer.mjs`, not `./renderer`.

## Method Parameters

### Unused Parameters

- **Use `_` prefix** for parameters that are intentionally unused (e.g., in interface implementations).

## Type Safety

### Import Paths

- **Verify import paths are correct** and relative to the current file.

### Return Types

- **Know your types**. Example: `Vector.toRotationMatrix()` returns `number[]`, not `Float32Array`.

### Use of `null` and `undefined`

- **Prefer `null` over `undefined`** for missing values.

### `null` initializations

- **Explicitly initialize variables to `null`** when they will later hold an object reference and provide JSDoc type annotations either as cast or an inline comment.
  - Example: `let model = /** @type {BaseModel} */ (null);`

### Empty Arrays

- **Initialize empty arrays with `[]`** instead of `new Array()` and provide JSDoc type annotations.
  - Example: `let vertices = /** @type {number[]} */ ([]);`

## Class and Interface Design

### Abstract Base Classes

- Throw `NotImplementedError` for abstract methods.
- Add unreachable return statements if needed for type inference.

### Protected and Private Methods

- **Use `_` prefix** for protected methods. Add `@protected` JSDoc tag.
- **Use `#` prefix** for private methods.

## Naming Conventions

- **Variables:** Descriptive names, camelCase. Avoid abbreviations.
  - `model` (or `clmodel`) instead of `m`.
  - `entity` instead of `ent` or `e`.
- **Constants:** UPPER_CASE.
- **Files:** PascalCase for classes (`BrushModelRenderer.mjs`), camelCase for utils (`modelUtils.mjs`). Always `.mjs`.

## Comments

- **Use for:** Complex algorithms ("why"), TODOs/FIXMEs (with context), workarounds.
- **Do NOT use for:** Obvious code, inline property descriptions (use JSDoc), commented-out code.

## Architecture Patterns

- **Strategy Pattern:** Use for polymorphic behavior (Abstract base -> Concrete impls -> Registry lookup).
- **Composition over Inheritance:** Shallow hierarchies, mixins/helpers.
- **Use Inheritance for:** Polymorphism, shared base functionality.

## Performance Considerations

- **Batch similar operations**.
- **Minimize state changes**.
- **Use streaming buffers** for dynamic geometry.
- **Cache expensive calculations**.
- **Use `for...of` loops** over `forEach`.

## Dangling Resources

- **Always clean up WebGL resources** (buffers, textures, shaders) when no longer needed.
- **Always truncate arrays** (e.g. `a.length = 0`) when reusing them to both avoid memory leaks and in case some reference is kept elsewhere.

## Common Pitfalls

- Do not access private properties externally.
- Do not mutate parameters unexpectedly.
- **Use `let` or `const`**, never `var`.
- Clean up WebGL resources.
- Validate array indices.
