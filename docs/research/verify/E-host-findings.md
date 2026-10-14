# E20–E24 Host API Fact Verification

Read-only verification. Nothing under `C:\Users\you\AppData\Local\Programs\DeepSeek Harness\` was modified.
All paths below are relative to the workspace `F:\WorkSpace\dsh-plugin-remote-use\`.

**Path shorthands used in this document**

| Short | Absolute |
|---|---|
| `ASAR` | `.research\asar\dsh\node_modules\@deepseek-ai` |
| `ROOT` | `.research\asar-root\node_modules\@deepseek-ai` |
| `SKILL` | `ASAR\dsh-agent-preset\skills\cordis-plugin-development` |

Key discovery while working: `.research\asar-root\node_modules\@deepseek-ai\cordis\` contains the **Cordis TypeScript sources**
(`src\*.ts`), which are the authoritative signatures for E21 — more precise than the rollup bundle in `ASAR\cordis\lib\index.js`.
Also `ASAR\dsh-tool-cordis\lib\types\api-catalog.js` (609 KB) is a generated catalog of every DSH service signature + TS declaration.

---

## E20. `ctx.webServer.register(route)` / `ctx.webServer.registerUpgrade(route)`

### Verdict: ✅ **confirmed, with two corrections to the likely-wrong guesses in the design doc**

| Aspect | Accurate value |
|---|---|
| Service name on ctx | `ctx.webServer` (`super(ctx, "webServer")`) |
| Injected service list required? | **Yes** — the consuming plugin declares `export const inject = ['webServer']` (or `ctx.inject(['webServer'], cb)`) |
| `register(route)` param | `WebRoute` = `{ kind: 'exact' \| 'prefix'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void \| Promise<void> }` |
| `registerUpgrade(route)` param | `WebUpgradeRoute` = `{ path: string; handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void \| Promise<void> }` — **no `kind` field** |
| `register` returns | `() => void` — **a disposer, NOT a Promise** |
| `registerUpgrade` returns | `() => void` — **a disposer, NOT a Promise** |
| `method` field? | ❌ **does not exist.** Method dispatch is the handler's own job (real code checks `req.method` itself, see `dsh-client-hmr` below) |
| `match` field? | ❌ does not exist on the route. `match(pathname)` is a **method of the service**, not a route field |
| `kind` on upgrade route? | ❌ not read, not present. Upgrades are always exact-path |

### Evidence

`ASAR\dsh-host-webserver\lib\index.js:139` and `:157-162` — service name:

```js
var WebServer = class extends Service {
	...
	constructor(ctx, config) {
		super(ctx, "webServer");
```

`ASAR\dsh-host-webserver\lib\index.js:171-197` — the exact fields read and the disposer return:

```js
	/**
	* Register a named route. Duplicate (kind, path) throws — route patterns are
	* a composition-level contract, so a collision is a misconfiguration.
	* @param route - kind, path, and the owning handler.
	* @returns the disposer removing the route.
	*/
	register(route) {
		const table = route.kind === "exact" ? this.exact : this.prefixes;
		if (table.has(route.path)) throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`);
		table.set(route.path, route);
		return () => {
			table.delete(route.path);
		};
	}
	/**
	* Register an exact-path HTTP upgrade route. Duplicate paths throw because
	* one socket can have only one protocol owner.
	* @param route - pathname and handler owning negotiation plus socket use.
	* @returns the disposer removing the route.
	*/
	registerUpgrade(route) {
		if (this.upgrades.has(route.path)) throw new Error(`webserver: duplicate upgrade route "${route.path}"`);
		this.upgrades.set(route.path, route);
		return () => {
			this.upgrades.delete(route.path);
		};
	}
```

`ASAR\dsh-tool-cordis\lib\types\api-catalog.js:3423-3438` — generated signature catalog:

```
        key: 'webServer',
        ...
                signature: 'register(route: WebRoute): () => void',
                ...
                signature: 'registerUpgrade(route: WebUpgradeRoute): () => void',
```

`ASAR\dsh-tool-cordis\lib\types\api-catalog.js:7847-7852` and `:7887-7888` — the exact TS declarations:

```js
        name: 'WebRoute',
        declaration: 'export interface WebRoute {\n    kind: WebRouteKind;\n    path: string;\n    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;\n}',
        ...
        name: 'WebRouteKind',
        declaration: 'export type WebRouteKind = \'exact\' | \'prefix\';',
        ...
        name: 'WebUpgradeRoute',
        declaration: 'export interface WebUpgradeRoute {\n    path: string;\n    handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>;\n}',
```

### REAL consumer usage (verbatim)

**1) `register` with `kind: 'exact'` — `ASAR\dsh-webhook-github\lib\index.js:161-190`** (also shows the required `inject` list and the `ctx.effect` ownership):

```js
/** Host services required before the exact route can register. */
const inject = [
	"webServer",
	"webhookRuntime",
	"credentials"
];
...
/** Register one signed GitHub endpoint on the injected WebServer. */
function apply(ctx, config) {
	assertConfig(config);
	const route = {
		kind: "exact",
		path: config.path,
		handler: createGitHubWebhookHandler(ctx, {
			source: config.source,
			secretEnv: credentialRef(config.secretEnv),
			maxBodyBytes: config.maxBodyBytes
		})
	};
	ctx.effect(() => ctx.webServer.register(route), `webhook-github: ${config.path}`);
}
```

**2) `register` with `kind: 'prefix'` — `ASAR\dsh-client-connection\lib\index.js:640-656`:**

```js
	register(owner, channel, handler) {
		assertChannel(channel);
		const fetchHandler = rpcFetchHandler(channel, handler, this.operator);
		const route = {
			kind: "prefix",
			path: channel,
			handler: async (req, res) => {
				const admission = this.admit(req);
				if ("rejection" in admission) {
					res.writeHead(admission.rejection);
					res.end(admission.rejection === 401 ? "unauthorized" : "forbidden");
					return;
				}
				await bridge(req, res, fetchHandler);
			}
		};
		return owner.effect(() => owner.webServer.register(route), `client-connection: ${channel} rpc channel`);
	}
```

**3) `register` inside a real `ctx.effect` — `ASAR\dsh-client-hmr\lib\index.js:140-152`** (note: it checks `req.method` itself — there is no `method` route field):

```js
	ctx.effect(() => {
		const disposeRoute = ctx.webServer.register({
			kind: "exact",
			path: EVENTS_ENDPOINT,
			handler: (req, res) => {
				if (req.method !== "GET" && req.method !== "HEAD") {
					res.writeHead(405);
					res.end();
					return;
				}
				connect(res);
			}
		});
```

**4) `registerUpgrade` — `ASAR\dsh-api-gateway\lib\index.js:626-643`** (shows both `ctx.inject([...], cb)` and a *generator* `ctx.effect`, plus `yield <disposer>`):

```js
		ctx.inject(["connection", "webServer"], (webCtx) => {
			const listen = () => {
				const mux = new RemoteStreamMuxServer(...);
				webCtx.effect(function* () {
					yield () => mux.close();
					const route = {
						path: REMOTE_STREAM_MUX_PATH,
						handler: (req, socket, head) => {
							const admission = webCtx.connection.admit(req);
							if ("rejection" in admission) {
								rejectRemoteStreamUpgrade(socket, admission.rejection);
								return;
							}
							mux.handleUpgrade(req, socket, head, admission.peer);
						}
					};
					yield webCtx.webServer.registerUpgrade(route);
				}, `api-gateway: ${REMOTE_STREAM_MUX_PATH} WebSocket`);
			};
```

### Other verified facts on this service

- Config schema — `ASAR\dsh-host-webserver\lib\index.js:141-147`:
  ```js
  	static Config = z.object({
  		host: z.union([z.const("127.0.0.1"), z.const("0.0.0.0")]).required(),
  		port: z.natural().max(65535).required(),
  		compression: z.union([z.const("none"), z.const("gzip")]).default(DEFAULT_COMPRESSION),
  		compressionLevel: z.number().step(1).min(0).max(9).default(DEFAULT_COMPRESSION_LEVEL),
  		compressionThresholdBytes: z.natural().default(DEFAULT_COMPRESSION_THRESHOLD_BYTES)
  	});
  ```
- `registerFallback(handler)` also returns a disposer; a second registration throws (`:206-212`).
- Duplicate `(kind, path)` throws (`:179`); duplicate upgrade path throws (`:192`).
- `README.md:45` (prose confirmation): "`register(route)` adds a named `exact` or `prefix` HTTP route, `registerUpgrade(route)` adds an upgrade route for an exact pathname, and both return a disposer that removes the registration."

---

## E21. `ctx.effect(...)`, `ctx.on(...)`, `ctx.inject([...], cb)`

### Verdict: ✅ **confirmed — all three are Cordis 4 core APIs** (`@deepseek-ai/cordis`, `super(ctx, ...)` core, package version `~4.0.4` per `ASAR\dsh-host-webserver\package.json:30`)

Exact signatures (TypeScript sources, authoritative):

| API | Signature | Returns |
|---|---|---|
| `ctx.effect` | `effect(execute: () => SyncEffect, label?: string): Disposable<Promise<void>>`<br>`effect(execute: () => Effect, label?: string): AsyncDisposable<Promise<void>>` | a **disposer function** (`() => Promise<void>`), also awaitable |
| `ctx.on` | `on<K extends keyof Events>(name: K, listener: Events[K], options?: boolean \| EventOptions): () => boolean` | a **disposer function** returning `true` if it was still registered |
| `ctx.inject` | `inject(deps: Inject, callback: Plugin.Function<void>): Fiber & PromiseLike<Fiber>` | a **Fiber** (also thenable), NOT a disposer |

### E21 evidence — `ctx.effect`

`ROOT\cordis\src\fiber.ts:68-93` — what the callback may return:

```ts
/**
 * Function returned by an effect to release resources during disposal.
 *
 * Disposers run in reverse registration order when the owning fiber unloads;
 * they may be async, in which case unloading awaits them.
 */
export type Disposable<T = any> = () => T

/**
 * Effect body result accepted by `ctx.effect()` and plugin startup.
 *
 * Either a single disposer, a promise of one, or a (possibly async) iterable
 * yielding several — generator effects register each yielded disposer as it
 * is produced.
 */
export type Effect<T = any> =
  | SyncEffect<T>
  | AsyncEffect<T>

type SyncEffect<T = any> =
  | Disposable<T>
  | Iterable<Disposable<T>, void, void>

type AsyncEffect<T = any> =
  | Promise<Disposable<T>>
  | AsyncIterable<Disposable<T>, void, void>
```

`ROOT\cordis\src\fiber.ts:402-418` — the JSDoc + overloads (label arg is the **second** parameter, default `'anonymous'`):

```ts
  /**
   * Register a cleanup-aware effect on this fiber.
   *
   * `execute` runs immediately; the disposers it produces are collected and
   * run (in reverse order) either when the returned disposer is called or
   * when the fiber unloads, whichever comes first. Calling the disposer twice
   * is a no-op. Throws `CordisError('INACTIVE_EFFECT')` if the fiber is
   * already disposed, and `TypeError` if `execute` returns an invalid shape.
   *
   * @param execute — the effect body; see {@link Effect} for accepted shapes.
   * @param label — effect label shown in `getEffects()` diagnostics.
   * @returns a disposer that tears the effect down and settles once done.
   */
  effect(execute: () => SyncEffect, label?: string): Disposable<Promise<void>>
  /** Same as above for async effects; the disposer is also awaitable. */
  effect(execute: () => Effect, label?: string): AsyncDisposable<Promise<void>>
  effect(execute: () => Effect, label = 'anonymous'): any {
```

> So: **generator form is legal** (`effect(function* () { yield d1; yield d2 })`), a **plain disposer return is legal**, and a **Promise of a disposer is legal**. There is **no** `ctx.effect(execute, label)` where `label` is an options object.

`ctx.effect` is exposed on `ctx` because `Context extends Pick<Fiber, 'effect'>` — `ROOT\cordis\src\fiber.ts:9-14`:

```ts
declare module './context.ts' {
  export interface Context extends Pick<Fiber, 'effect'> {
    /** The fiber (plugin runtime instance) that owns this context. */
    fiber: Fiber
  }
}
```

### E21 evidence — `ctx.on`

`ROOT\cordis\src\events.ts:89-97`:

```ts
    /**
     * Register an event listener owned by the current fiber.
     *
     * @param name — the event name to listen for.
     * @param listener — called with the dispatch arguments.
     * @param options — listener options; a boolean is shorthand for `prepend`.
     * @returns a disposer removing the listener; `true` if it was still registered.
     */
    on<K extends keyof Events>(name: K, listener: Events[K], options?: boolean | EventOptions): () => boolean
```

`ROOT\cordis\src\events.ts:111-117` — the options object:

```ts
/** Options accepted by `ctx.on()` and `ctx.once()`. */
export interface EventOptions {
  /** Add the listener before existing listeners for the same event. */
  prepend?: boolean
  /** Receive the event regardless of context filter checks. */
  global?: boolean
}
```

Runtime equivalent in the shipped bundle — `ASAR\cordis\lib\index.js:360-380` (identical semantics; note `ctx.on` internally is itself implemented as a fiber effect):

```js
	on(name, listener, options) {
		if (typeof options !== "object") options = { prepend: options };
		this.ctx.fiber.assertActive();
		listener = this.ctx.reflect.bind(listener);
		const result = this.bail(this.ctx, "internal/listener", name, listener, options);
		if (result) return result;
		const hooks = this._hooks[name] ||= [];
		const label = `ctx.on(${typeof name === "string" ? JSON.stringify(name) : name.toString()})`;
		return this.register(label, hooks, listener, options);
	}
```

### E21 evidence — `ctx.inject`

`ROOT\cordis\src\registry.ts:164-187`:

```ts
declare module './context.ts' {
  export interface Context {
    /**
     * Run a callback once the requested services are available.
     *
     * Shorthand for `ctx.plugin({ inject, apply: callback })`: the callback
     * is unloaded and re-run whenever a required service changes.
     *
     * @param deps — required services, as an array or a name → config map.
     * @param callback — plugin body called with `(ctx, config)`.
     * @returns the fiber; awaiting it settles once loading finished.
     */
    inject(deps: Inject, callback: Plugin.Function<void>): Fiber & PromiseLike<Fiber>
```

`ROOT\cordis\src\registry.ts:296-301` — the runtime:

```ts
  inject(inject: Inject, callback: Plugin.Function<void>) {
    return this.plugin({ inject, apply: callback, name: callback.name })
  }
```

**Return value note worth flagging to the design doc:** `ctx.inject` does **not** return a disposer — it returns a Fiber. Cleanup comes from *inside* the callback: because `inject` is sugar for `ctx.plugin({ inject, apply })`, the callback's **returned disposer (or yielded disposers) are collected as the new fiber's effect body**. Real sample proves this:

`F:\WorkSpace\dsh-plugin-notify\lib\index.js:699-720` (verbatim; this is the notify plugin's whole `apply`):

```js
  // Session-title service when it is composed; the event feed below is the fallback.
  ctx.inject(['sessionTitle'], (child) => {
    state.sessionTitle = child.sessionTitle
    return () => {
      state.sessionTitle = null
    }
  })

  ctx.on('session/event', (session, event) => {
    try {
      handleSessionEvent(state, ctx, session, event)
    } catch (error) {
      log(ctx, 'warn', 'session event handling failed', error)
    }
  })

  // Warm the probes in the background so the first Settings page render is fast.
  void refreshProbes(state, { force: true }).catch(() => {})

  ctx.inject(['webServer'], (child) => {
    child.effect(() => child.webServer.register(makeRoute(state, ctx)), 'dsh-plugin-notify: settings route')
  })
```

and the plugin's own JSDoc at `F:\WorkSpace\dsh-plugin-notify\lib\index.js:689-691`:

```js
/**
 * Plugin body. Every registration is owned by `ctx.effect`/`ctx.on`, so the
 * plugin disposes cleanly when it is disabled or replaced.
```

`F:\WorkSpace\dsh-plugin-notify\lib\client.js:613-625` (browser-half usage):

```js
    const inject = ['slots', 'locale']

    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-plugin-notify: dictionaries')
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'dsh-plugin-notify',
        order: 40,
        label: () => t('nav'),
        locale: NS,
      }, NotifySection))
    }
```

**`dsh-plugin-code-quality` uses only the static `inject` export form — `F:\WorkSpace\dsh-plugin-code-quality\lib\index.js:15-37`:**

```js
/** Cordis plugin name. */
export const name = 'dsh-plugin-code-quality'

/**
 * The skill registry is the only service required. With this injection the
 * plugin starts only once `ctx.skills` exists, and every registration unwinds
 * with the plugin's own fiber.
 */
export const inject = ['skills']

/**
 * ...
 * @param ctx - the Cordis context carrying `ctx.skills`.
 */
export function apply(ctx) {
  for (const skill of SKILLS) ctx.skills.register(skill)
}
```

**Note on the task brief:** the two sample plugins have **no `src/` directory** — they ship `lib/*.js` directly (`F:\WorkSpace\dsh-plugin-notify\`, `F:\WorkSpace\dsh-plugin-code-quality\`). The official skill confirms this is normal for installed packages: `SKILL.md:32` — "installed packages ship built `lib/index.js` and `lib/types/**/*.d.ts` with JSDoc under that same `packageDir`, not `src/`".

Official-guide confirmation of these three ownership rules — `SKILL\references\host-plugin.md:54`:

```
Register every resource inside `apply` with `ctx.effect` or `ctx.on` and return its cleanup. A plugin that declares `Config` validates the row's `config` at activation; ...
```

and `SKILL\references\practices.md:20`:

```
- Put optional services in `inject` or `ctx.inject([...], ...)` so the plugin stays inactive in profiles without them instead of throwing.
```

---

## E22. `dsh.bundle.patch` and `dsh.client` in a plugin's `package.json`

### Verdict: ✅ **confirmed for both.** Neither has a Schemastery/JSON-Schema object; both are hand-rolled validators. Quoted below.

### `dsh.bundle.patch`

**Schema:** `string | string[]` of package-relative file paths. **No other fields are accepted under `dsh.bundle`** (nothing reads them).

`ASAR\dsh-app-boot\lib\index.js:488-509`:

```js
/**
* The patch files a bundle declares, as written: one file for a string
* `patch`, the listed files in order for an array.
* @param bundle - the bundle's `dsh.bundle` declaration, as read from package.json.
* @returns the package-relative patch file paths in application order.
* @throws {Error} when `patch` is neither a string nor a list of strings.
*/
function bundlePatchFiles(bundle) {
	const declared = typeof bundle.patch === "string" ? [bundle.patch] : bundle.patch;
	if (!Array.isArray(declared) || !declared.every((file) => typeof file === "string")) throw new Error("dsh.bundle.patch must be a file path or a list of file paths");
	return declared;
}
/**
* Resolve a bundle declaration to its ordered absolute patch files.
* @param packageDir - absolute directory of the bundle package.
* @param bundle - the bundle's `dsh.bundle` declaration, as read from package.json.
* @returns the absolute patch file paths in application order.
* @throws {Error} when `patch` is neither a string nor a list of strings.
*/
function bundlePatchPaths(packageDir, bundle) {
	return bundlePatchFiles(bundle).map((file) => join(packageDir, file));
}
```

**Semantics** — `ASAR\dsh-app-boot\lib\index.js:466-475`:

```
* A profile is a directory under `$DSH_HOME/profiles/<name>` holding a
* `package.json` (out-of-tree plugin dependencies plus the profile manifest
* `dsh.profile` with its ordered `bundles` list) and a `cordis.patch.yml`
* (the user's own patch layer, applied after every bundle layer). Bundles are
* npm packages whose manifest declares
* `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` (one file, or an
* ordered list of files); the tree is composed by applying each bundle's patch
* lists in `dsh.profile.bundles` order over an empty entry list, then the
* profile's own patches, then any launcher layers (`--patch` files and
* flag-derived patches).
```

Identifier check used by Plugin Manager (a package is a "bundle" iff this field exists) — `ASAR\dsh-plugin-manager\lib\index.js:228` and `:1786`:

```js
	return manifest.dsh?.bundle?.patch === void 0 ? void 0 : manifest;
```
```js
					if (manifest?.dsh?.bundle === void 0) throw new ManagementFailure("not-bundle");
```

Official guide — `SKILL\references\host-plugin.md:3`:

```
A bundle is a package whose `package.json` declares `dsh.bundle.patch`; the YAML patch inserts plugin entries.
```

and `host-plugin.md:9-27` (canonical minimal manifest + patch):

```json
{
  "name": "@local/my-plugin",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./index.js" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```
```yaml
- insert:
    - id: my-plugin
      name: '@local/my-plugin'
      config: {}
```

### `dsh.client`

**Schema** (the authoritative validator, `parseDshClient`) — `ASAR\dsh-client-modules\lib\index.js:52-75` (byte-identical copy at `lib\client.js:52-75`):

```js
/**
* Narrow an unknown parsed JSON value to the `dsh.client` declaration. Shared
* by the node half's Loader scan and the roster generator, so both read a
* package's browser declaration through one validator.
* @param pkgName - package name used as the diagnostic prefix.
* @param value - the raw `dsh.client` field of the package manifest.
* @returns the validated declaration, or undefined when the field is absent.
* @throws {Error} when the field is present but any member is malformed.
*/
function parseDshClient(pkgName, value) {
	if (value === void 0) return void 0;
	if (typeof value !== "object" || value === null) throw new Error(`client-modules: ${pkgName} has a non-object dsh.client declaration`);
	const decl = value;
	if (typeof decl.platform !== "string") throw new Error(`client-modules: ${pkgName} dsh.client.platform must be a string`);
	const inject = optionalStringArray(pkgName, "dsh.client.inject", decl.inject);
	const external = optionalStringArray(pkgName, "dsh.client.external", decl.external);
	if (decl.immediately !== void 0 && typeof decl.immediately !== "boolean") throw new Error(`client-modules: ${pkgName} dsh.client.immediately must be a boolean`);
	return {
		platform: decl.platform,
		...inject !== void 0 ? { inject } : {},
		...external !== void 0 ? { external } : {},
		...decl.immediately !== void 0 ? { immediately: decl.immediately } : {}
	};
}
```

**Admitted fields:**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `platform` | `string` | **required** | Only the literal `"web"` is honoured; any other value makes the client half be ignored entirely |
| `inject` | `string[]` | optional | Module ids that must be present before activation (ordering; informational per `practices.md:35`) |
| `external` | `string[]` | optional | Non-baseline runtime imports the bundle requires from the browser module table |
| `immediately` | `boolean` | optional | Load eagerly instead of lazily |

**Only `"web"` is accepted** — `ASAR\dsh-client-modules\lib\index.js:713-728`:

```js
		const decl = parseDshClient(packageName, dsh !== null && typeof dsh === "object" ? dsh.client : void 0);
		if (decl === void 0 || decl.platform !== "web") {
			this.pkgMeta.set(sourceKey, null);
			return null;
		}
		const clientRel = clientExportOf(packageName, pkg.exports);
		if (clientRel === void 0) throw new Error(`client-modules: ${packageName} declares dsh.client but exports no "./client" bundle`);
		const resolved = {
			packageName,
			meta: {
				clientPath: join(dirname(pkgPath), clientRel),
				...decl.inject !== void 0 ? { inject: decl.inject } : {},
				external: decl.external ?? [],
				immediately: decl.immediately === true
			}
		};
```

So a `dsh.client` declaration **also requires `exports["./client"]`** in the same `package.json`, else it throws at scan time.

Official guide — `SKILL\references\ui-plugin.md:3`:

```
Read `templates/decoration/` with the file-read tool and write its files into your bundle directory: its `package.json` adds a `dsh.client` section (`platform`, `immediately`, `inject`) and a `./client` export beside the bundle patch.
```

Official template — `SKILL\templates\decoration\package.json:1-15`:

```json
{
  "name": "@local/my-decoration",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./index.js", "./client": "./client.js" },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "immediately": true,
      "inject": ["@deepseek-ai/dsh-client-ui-conversation"]
    }
  }
}
```

### Comparison with the two REAL sample plugins

**`F:\WorkSpace\dsh-plugin-notify\package.json:48-56`** — uses **both** fields (dual-face host + client):

```json
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    },
    "client": {
      "platform": "web",
      "inject": []
    }
  },
```
with the matching export at `:25-31`:
```json
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",
    ...
  },
```

**`F:\WorkSpace\dsh-plugin-code-quality\package.json:42-46`** — uses **only** `dsh.bundle.patch` (host-only, no browser half):

```json
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  },
```
`package.json:21-28` confirms no `./client` export exists.

Both sample patch files are one `insert:` with one row, and the row id is the plugin's stable identity:
`F:\WorkSpace\dsh-plugin-notify\cordis.patch.yml:11-13`

```yaml
- insert:
    - id: dsh-plugin-notify
      name: '@hope_phenom/dsh-plugin-notify'
```

`F:\WorkSpace\dsh-plugin-code-quality\cordis.patch.yml:11-13`

```yaml
- insert:
    - id: code-quality
      name: '@hope_phenom/dsh-plugin-code-quality'
```

The loader patch dialect (what may go inside the patched YAML) is documented at `ASAR\dsh-agent-preset\skills\cordis-composition-reference\SKILL.md:10-25`; row fields are exactly (`SKILL.md:18`): "A row has `id`, `name` (the plugin package specifier; inserted relative paths are anchored beside their patch file), optional `config`, and optional `disabled`, `inject`, `intercept`, and `isolate`."

---

## E23. After install, does changing a plugin's JS require a restart?

### Verdict: ✅ **Yes for the host (Node) half — restart required by default.** The browser half can reload without restart (different mechanism).

### `dsh-hmr` Config — exact schema

`ASAR\dsh-hmr\lib\index.js:235-247`:

```js
		config;
		/** Cordis-compatible watcher defaults. */
		static Config = z.object({
			base: z.string(),
			root: z.array(String).role("table").default(["."]),
			ignored: z.array(String).role("table").default([
				"**/node_modules",
				"**/.*",
				"cache",
				"data"
			]),
			debounce: z.natural().role("ms").default(100)
		});
		/** Absolute base directory used to resolve module watch roots. */
		baseDir;
```

| Field | Type | Default | Notes |
|---|---|---|---|
| `base` | `string` | *none* (optional) | If absent, `baseDir` = `ctx.baseUrl` |
| `root` | `string[]` | `["."]` (schema) — **overridden to `[]` in the shipped composition** | Watch roots, relative to `baseDir` |
| `ignored` | `string[]` | `["**/node_modules", "**/.*", "cache", "data"]` | picomatch patterns — **not overridden in the shipped composition** |
| `debounce` | natural (ms) | `100` | Debounce for the change batch |

JSDoc for the service constructor — `ASAR\dsh-hmr\lib\index.js:313-320` (this is where `config.base` and `config.root` are actually used):

```js
		constructor(ctx, config) {
			super(ctx, "hmr");
			this.config = config;
			this.ownerContext = ctx;
			if (!this.ctx.loader.internal) throw new Error("--expose-internals is required for HMR service");
			this.internal = this.ctx.loader.internal;
			this.baseDir = fileURLToPath(new URL(config.base || ".", ctx.baseUrl));
		}
```

and `ASAR\dsh-hmr\lib\index.js:378-392`:

```js
			const { loader } = this.ctx;
			const { root, ignored } = this.config;
			if (!this.config.base) this.ctx.logger.info("watching %o", root);
			else this.ctx.logger.info("watching %o in %s", root, this.baseDir);
			const match = picomatch(ignored);
			const watchBaseDir = realpathSync(this.baseDir);
			const mainJob = process.argv[1] === void 0 ? void 0 : this.internal.loadCache.get(pathToFileURL(resolve(process.argv[1])).href);
			if (mainJob) this.externals = await loadDependencies(mainJob);
			else this.externals = /* @__PURE__ */ new Set();
			this.watcher = watch(root, {
				...this.config,
				cwd: watchBaseDir,
				ignored: (path) => match(relative(watchBaseDir, path)),
				ignoreInitial: true
			});
```

`root: []` short-circuits readiness — `ASAR\dsh-hmr\lib\index.js:438-444`:

```js
			const ready = Promise.withResolvers();
			let readyState = root.length === 0 ? "resolved" : "pending";
			if (root.length === 0) ready.resolve();
```

### The actual configured value of `hmr.config.root` in DSH core

`ASAR\dsh-base\cordis.patch.yml:27-32` — **`root: []`**:

```yaml
    # Profile configuration reloads by default; module roots are opt-in.
    - id: hmr
      name: '@deepseek-ai/dsh-hmr'
      disabled: !!js "!ctx.get('profileContext')"
      config:
        root: []
```

I searched **every** `*.yml`/`*.yaml` under `ASAR\` for an `hmr` row: the only occurrences are
`dsh-base\cordis.patch.yml:28` (above), `dsh-acp-app\cordis.patch.yml:23-24` (`- id: hmr` / `disabled: true`),
and `dsh-headless\cordis.patch.yml:33-34` (`- id: hmr` / `disabled: true`).
**No shipped composition sets a non-empty `root`.**

So in the shipped Web/Desktop profile, `dsh-hmr` watches **only** profile configuration files, not module files.
Those configuration watches are hard-coded, independent of `config.root` — `ASAR\dsh-hmr\lib\index.js:353-376`:

```js
				const manifestPath = join(profile.dir, "package.json");
				const patchFiles = [profile.patchPath, join(profile.home, PROFILE_PATCH_FILENAME)];
				...
				for (const filename of patchFiles) await this.watchConfig(filename, () => refresh(false));
				await this.watchConfig(manifestPath, () => refresh(true));
```

`ASAR\dsh-headless\README.md:84` names this policy explicitly: "…disables the shared HMR row…".
`ASAR\dsh-acp-app\README.md:63`: "**Configuration changes require restart** — the `acp-app` bundle disables HMR in YAML…".

### Corroborating docs

- `SKILL\references\host-plugin.md:60`: "Installing a new bundle can activate through HMR; **replacing an installed package requires restart to load a fresh JavaScript module generation.** Do not infer updated browser code from an unchanged slot id."
- `F:\WorkSpace\dsh-plugin-notify\README.md:58`: "Installing a new bundle applies live; **replacing** an installed package of the same name needs a process restart to load a fresh JS module generation."
- `F:\WorkSpace\dsh-plugin-code-quality\README.md:39-40`: "Then fully restart the profile. Replacing a package that is already loaded needs a new module generation — HMR only covers bundles that were not loaded before."

And the mechanism that *produces* `restart-required`, `ASAR\dsh-plugin-manager\lib\index.js:1799-1803`:

```js
				return this.configure(async () => {
					if (options?.enabled !== false) await this.selectBundle(name, true);
					if (Object.hasOwn(before, name)) return "restart-required";
					if (options?.enabled !== false) result.warnings = await this.reload();
				});
```

(`before` is the profile's `dependencies` map from before the pnpm install — a package already present → `restart-required`.)

### Can `hmr.config.root` point at a plugin's SOURCE directory for hot reload?

**Verdict: ⚠️ uncertain / partially possible — I found no shipped or documented example, and two defaults work against it.**

What the code establishes (facts, not guesses):

1. `root` entries are resolved against `baseDir`, which is `config.base` if set, else `ctx.baseUrl`; the chokidar watcher runs with `cwd = realpathSync(baseDir)` and picomatch is applied to `relative(watchBaseDir, path)` (`dsh-hmr\lib\index.js:319`, `:378-392`).
2. The default `ignored` contains `**/node_modules` (`dsh-hmr\lib\index.js:240-245`). A profile-installed third-party plugin lives under `<profile>/node_modules/...` (per `dsh-app-boot\lib\index.js:477-481`: "a bundle name resolves first from the dsh installation … then from the profile directory. Pnpm-managed entries in the profile's `node_modules` resolve first."), so its files are ignored unless the user also overrides `ignored`.
3. A change only reloads a module if that module is in Node's `internal.loadCache` — `dsh-hmr\lib\index.js:410-413`:
   ```js
   						if (this.internal.loadCache.has(url)) {
   							this.stashed.add(url);
   							continue;
   						}
   ```
   A path that is watched but not loaded is merely emitted as `hmr/change` (`:414-416`), which reloads nothing.
4. The reload path clears the ESM `loadCache` + CJS `require.cache` for accepted files and re-imports, then `registry.delete(plugin)` + re-`registry.plugin(replacement, previousConfig)` — `dsh-hmr\lib\index.js:566-663`. Note `loadDependencies` and `analyzeChanges` both skip `node_modules` (`:201`, `:478`) for *dependency* traversal, though the directly-stashed file itself can still be reloaded.
5. `config.base` and `root` can be set from a patch layer, and the profile's own `cordis.patch.yml` may target `- id: hmr` with `config: { root: [...], ignored: [...], base: ... }` (loader dialect, `cordis-composition-reference\SKILL.md:12-18`).

I did **not** find any shipped config, README, or test that sets a plugin directory as an `hmr` root, so I cannot assert "yes, this works" — **未找到** an example. Searched keywords: `hmr`, `root:`, `ignored:`, `dsh-hmr` across `ASAR\**\*.yml`, `ASAR\**\cordis.patch.yml`, and `ASAR\dsh-agent-preset\skills\**`. The only `hmr` doc statements found are the three quoted in "Corroborating docs" above, all of which say *restart*.

### The other, working, no-restart mechanism: client-plugin HMR (`dsh-client-hmr`)

`ASAR\dsh-client-hmr\lib\index.js:3-22` and `:9-17`:

```js
/** System SSE endpoint pushing graph/rebuilt frames (wire protocol constant). */
const EVENTS_ENDPOINT = "/plugins/events";
...
/**
* Host transport for Web client graph changes and rebuilt bundles. One interval
* stat-polls every graph row's client bundle (polling by design: network mounts
* deliver no inotify events), reports changes through
* `clientModules.rebuilt(id)`, and serves the `/plugins/events` SSE channel
* broadcasting graph/rebuilt frames to the browser half (src/client/).
* The Web composition mounts this transport for live graph updates;
* a development rebuild watcher also supplies bundle changes.
*/
/** Cordis plugin name. */
const name = "client-hmr";
/** Required services: the client graph and Web route registry. */
const inject = ["clientModules", "webServer"];
const Config = z.object({ pollIntervalMs: z.number().step(1).min(1).default(500) });
```

**No `vite` is involved in the installed-plugin reload path.** The browser half reloads because the host stat-polls each graph row's `client` bundle file every 500 ms and pushes a `rebuilt` SSE frame; the browser then re-materializes the module factory. The page-facing receipt of a new client bundle therefore does **not** need a restart, while the Node half does. (`ASAR\dsh-client-hmr\lib\invariant.js` exists but was not required for this verdict.)

The vite/HMR dev watcher mentioned in the same JSDoc ("a development rebuild watcher also supplies bundle changes") belongs to the DSH source-checkout dev flow, not to the installed-plugin path; I found no evidence of it in the shipped asar beyond that sentence — **未找到** its implementation in `ASAR\` (searched `vite` in `ASAR\dsh-client-hmr\**` and `ASAR\dsh-client-modules\lib\index.js`).

---

## E24. Where does the plugin loader look for a third-party plugin's config?

### Verdict: ✅ **confirmed — and the shape is a YAML *array*, not a `plugins: { ... }` map**

**Path:** `$DSH_HOME/profiles/<profile-name>/cordis.patch.yml`

- `$DSH_HOME` resolves as: explicit config → `$DSH_HOME` env var → `~/.dsh` (`ROOT`-level package `ASAR\dsh-home-paths\lib\index.js:73-76`):
  ```js
  function resolveDshHome(configured, env = process.env) {
  	const fromEnv = env[DSH_HOME_ENV];
  	return resolve(expandHomePath(configured ?? (fromEnv !== void 0 && fromEnv.trim().length > 0 ? fromEnv : defaultDshHome())));
  }
  ```
  with `DSH_HOME_ENV = "DSH_HOME"` (`:15`) and `DSH_HOME_DIR_NAME = ".dsh"` (`:11`).
- `ASAR\dsh-app-boot\lib\index.js:484-487`:
  ```js
  /** Directory under the Harness home holding every profile. */
  const PROFILES_DIR = "profiles";
  /** The user patch layer inside a profile directory (hot-reloaded on long-lived surfaces). */
  const PROFILE_PATCH_FILENAME = "cordis.patch.yml";
  ```
- `ASAR\dsh-app-boot\lib\index.js:524-527`:
  ```js
  function resolveProfileDir(name, home = resolveDshHome()) {
  	if (name === "" || name.includes("/") || name.includes("\\") || name === "." || name === ".." || name === "node_modules") throw new Error(`dsh: invalid profile name ${JSON.stringify(name)}`);
  	return join(home, PROFILES_DIR, name);
  }
  ```
- `ASAR\dsh-app-boot\lib\index.js:558-562` — the file's own generated template states the shape:
  ```js
  const PROFILE_PATCH_TEMPLATE = `# Your patch layer for this dsh profile, applied after every bundle layer:
  # a top-level YAML array of loader patch entries (id-targeted config
  # overrides, disables, and insert lists; \`!!js\` expressions allowed).
  []
  `;
  ```
- `ASAR\dsh-app-boot\lib\index.js:576-589` shows it is written to `join(dir, PROFILE_PATCH_FILENAME)`.

**Shape of a plugin's Config entry:** a top-level YAML **sequence** whose items are loader patch entries; a plugin's config is an entry with the row's `id` (plus optionally `name`) and a `config:` mapping.

`ASAR\dsh-config-editor\lib\index.js:96-110` is the canonical writer (it *adds* the record when absent):

```js
				if (!isSeq(document.contents)) throw new Error("Profile patch must be a YAML sequence");
				document.contents.flow = false;
				const index = document.contents.items.findLastIndex((item, index) => isMap(item) && document.getIn([index, "id"]) === entry.options.id && !item.has("insert") && (!item.has("name") || document.getIn([index, "name"]) === entry.options.name));
				...
				else if (index < 0) document.add(document.createNode({
					id: entry.options.id,
					name: entry.options.name,
					config: next
				}));
				else document.setIn([index, "config"], document.createNode(next));
```

`ASAR\dsh-config-editor\lib\index.js:23-26` confirms the file is the profile patch:

```js
	/** The profile patch edited by this service. */
	get documentPath() {
		return this.ownerContext.profileContext.patchPath;
	}
```

`ASAR\dsh-plugin-manager\lib\types\patch.js:6-13` is the same dialect for enable/disable (`disabled`, not `config`):

```js
/** Replace the last matching override or append one after existing insertions.
 * @param filename Current profile patch file.
 * @param id Unique composition entry id.
 * @param name Module name used to match name-qualified overrides.
 * @param enabled Desired entry enablement.
 * @returns Whether the file changed.
 */
export async function writePluginEnabled(filename, id, name, enabled) {
```

So the effective YAML for a third-party plugin `@hope_phenom/dsh-plugin-notify` (row id `dsh-plugin-notify`, see its own `cordis.patch.yml:12`) is:

```yaml
- id: dsh-plugin-notify
  name: '@hope_phenom/dsh-plugin-notify'
  config:
    # ... the plugin's Config fields, replaced WHOLESALE (never deep-merged)
```

**`plugins: { 'dsh-plugin-x': { ... } }` is WRONG.** There is no such key anywhere: `dsh-config-editor` rejects a non-sequence document (`"Profile patch must be a YAML sequence"`, `:96`), `dsh-plugin-manager\lib\types\patch.js:29-30` also rejects it (`'Profile patch must be a YAML sequence'`), and `cordis-composition-reference\SKILL.md:15-16` documents the array-of-entries dialect:

```
- A patch with an `id` and no `insert` targets the existing row with that id. Supplied fields replace the row's fields; `config` is replaced wholesale, never deep-merged, so restate every field the row needs. A truthy `name` asserts the existing plugin name rather than renaming it.
```

**Two additional config locations, for completeness:**
1. The **home-level** user patch layer `$DSH_HOME/cordis.patch.yml` — `ASAR\dsh\lib\profile-boot-BZ2ZjNWi.js:110-116`:
   ```
   * The home-level user patch layer (`$DSH_HOME/cordis.patch.yml`), applied
   ...
   	return join(resolveDshHome(), PROFILE_PATCH_FILENAME);
   ```
   `dsh-hmr` watches exactly `[profile.patchPath, join(profile.home, PROFILE_PATCH_FILENAME)]` (`ASAR\dsh-hmr\lib\index.js:354`), and `dsh-config-editor` refuses a write that would be overridden by it (`config-editor\lib\index.js:122`).
2. **Bundle-declared** defaults come from the bundle's own patch, addressed by the same row `id`.

Sample READMEs confirm the user-facing flow (no separate config file is documented for either sample; `dsh-plugin-notify` deliberately avoids `Config` and uses its own `settings.json` under `%USERPROFILE%\.dsh\storages\`):
- `F:\WorkSpace\dsh-plugin-notify\README.md:183`: "A self-owned `settings.json` plus a self-registered HTTP route, instead of a `Config` schema with volatile fields. A profile-installed bundle cannot `import '@deepseek-ai/schemastery'` at runtime …, and free-form configuration such as executable paths does not belong in the profile's `cordis.patch.yml`."
- `F:\WorkSpace\dsh-plugin-notify\README.md:52-53`: `dsh plugin --profile desktop add "F:\WorkSpace\dsh-plugin-notify"`.
- `F:\WorkSpace\dsh-plugin-code-quality\README.md:18`: `dsh plugin --profile <your-profile> add @hope_phenom/dsh-plugin-code-quality`.

---

## Verdict summary

| Item | Verdict | One-line correction / confirmation |
|---|---|---|
| **E20** | ✅ confirmed (with corrections) | `register({kind:'exact'\|'prefix', path, handler})`, `registerUpgrade({path, handler})`; both return a **disposer** `() => void`, not a Promise. No `method`/`match` fields. Service is `ctx.webServer` and must be declared in `inject`. |
| **E21** | ✅ confirmed | `ctx.effect(execute, label?)` → disposer; `execute` may return a disposer, a Promise of one, or (async) iterable/generator of them. `ctx.on(name, listener, options?)` → `() => boolean`; `options` = `boolean`(prepend) or `{prepend?, global?}`. `ctx.inject(deps, cb)` → **Fiber**, not a disposer (cleanup via the callback's returned/yielded disposers). All three are Cordis 4 core. |
| **E22** | ✅ confirmed | `dsh.bundle.patch`: `string \| string[]`, package-relative, **no other sub-fields**. `dsh.client`: `{ platform: string (only "web" honoured, required), inject?: string[], external?: string[], immediately?: boolean }` **and** requires `exports["./client"]`. |
| **E23** | ✅ confirmed (host half) / ⚠️ uncertain (root→plugin source) | Shipped `dsh-base` sets `hmr.config.root: []` — "module roots are opt-in" — so by default only profile config is hot-reloaded and **JS changes need a restart**. The client half reloads live via `dsh-client-hmr` (500 ms stat-poll + `/plugins/events` SSE), no vite. Pointing `hmr.config.root` at a plugin source dir is *mechanically plausible* but **unproven** (no shipped example; default `ignored: ["**/node_modules", ...]` blocks profile-installed plugin paths). |
| **E24** | ✅ confirmed (with correction) | `$DSH_HOME/profiles/<name>/cordis.patch.yml` (`$DSH_HOME` = env `DSH_HOME` else `~/.dsh`), a **top-level YAML sequence** of `{id, name?, config?, disabled?, inject?, intercept?, isolate?}` entries. `plugins: { 'x': {...} }` is **wrong** — not a supported shape; `config` is replaced wholesale, never deep-merged. |
