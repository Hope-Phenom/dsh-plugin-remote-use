# D15–D19 ACP API signature verification

Scope: read-only verification against

- SDK 1.4.0 source: `F:\WorkSpace\dsh-plugin-remote-use\.research\sdk\sdk\`
- DSH ACP client/server bridge: `F:\WorkSpace\dsh-plugin-remote-use\.research\asar\dsh\node_modules\@deepseek-ai\dsh-acp\lib\index.js`

**Note on `.d.ts`:** the task brief expected TypeScript declaration files to be the most authoritative source. **They are not present in the extracted tree.** `package.json` declares `"types": "dist/acp.d.ts"` (`sdk/package.json:24`) and `exports["."].types = "./dist/acp.d.ts"` (`sdk/package.json:27`), but only `.js` files were extracted. The authoritative evidence below is therefore the shipped JS implementation, cross-checked against `schema/schema.json` and the generated zod schemas.

---

## D15. `acp.client(...)` and the accurate method names

### Verdict: ❌ **WRONG** (as stated) — 3 distinct errors

**Error 1 — there is no `acp` namespace object.** A grep for a namespace/object literal named `acp` in the SDK entry point returns nothing:

```
pwsh> Select-String -Path '...\sdk\sdk\dist\acp.js' -Pattern 'acp\s*=|const acp|var acp\b|namespace acp'
(no output)
```

`acp` is only the *import alias* used by consumers (`import * as acp from "@agentclientprotocol/sdk"`, e.g. `sdk/dist/examples/client.js:7`). The entry point exports **named** bindings.

**Error 2 — `client` is a function, not a method on a namespace.** `sdk/dist/acp.js:852`:

```js
export function client(options) {
    return new ClientApp(options);
}
```

It takes **one** `options` object (`{ name }` is the only field read — `acp.js:866-869`), **not** `client(stream, handlers)` and not `client(handlerObject)`.

**Error 3 — the returned object has NO `initialize` / `newSession` / `prompt` / `cancel` / `loadSession` / `resumeSession` / `listSessions` / `closeSession` / `setSessionConfigOption` / `authenticate` methods.** Those are **agent-side** operations. `client(...)` returns a `ClientApp`, and the *client* calls agent-side methods through the `ctx` argument of `connectWith`.

### The actual `ClientApp` public method list (name + parameter list)

Class declared at `sdk/dist/acp.js:863` (`export class ClientApp {`). Exact declarations, in source order:

| Line | Declaration |
|---|---|
| 866 | `constructor(options = {}) {` |
| 883 | `connect(target) {` |
| 886 | `connectWith(target, op) {` |
| 896 | `onConnect(handler) {` |
| 900 | `onRequest(method, handlerOrParams, handler) {` |
| 910 | `onNotification(method, handlerOrParams, handler) {` |
| 920 | `request(spec, handler) {` |
| 924 | `notification(spec, handler) {` |
| 928 | `connectConnection(target) {` |
| 951 | `openStreamConnection(stream) {` |

(`[appBuilder]()` at 876 and `[runClientConnectHandlers](connection)` at 880 are `/** @internal */` symbol-keyed, not public API.)

Canonical usage, `sdk/dist/examples/client.js:90-95`:

```js
        const promptResult = await acp
            .client({ name: "example-client" })
            .onRequest(acp.methods.client.session.requestPermission, (ctx) => client.requestPermission(ctx.params))
            .onRequest(acp.methods.client.fs.writeTextFile, (ctx) => client.writeTextFile(ctx.params))
            .onRequest(acp.methods.client.fs.readTextFile, (ctx) => client.readTextFile(ctx.params))
            .connectWith(stream, async (ctx) => {
```

Confirmation in `sdk/README.md:50`:

> If you're building a [Client](https://agentclientprotocol.com/protocol/overview#client), start with `client({ name })`, register client-side handlers such as `requestPermission(...)` and `sessionUpdate(...)`, then run your agent workflow with `connectWith(stream, async (ctx) => ...)`.

### The method-name registry is `acp.methods`, a *constant map* — not client methods

`sdk/dist/acp.js:55` (`export const methods = {`). Full shape, exact keys:

- `methods.agent`: `initialize`, `authenticate`, `logout`, `providers.{list,set,disable}`, `session.{new,load,list,delete,fork,resume,close,setMode,setConfigOption,prompt,cancel}`, `nes.{start,suggest,accept,reject,close}`, `document.{didOpen,didChange,didClose,didSave,didFocus}` (`acp.js:56-92`)
- `methods.client`: `session.{requestPermission,update}`, `fs.{writeTextFile,readTextFile}`, `terminal.{create,output,release,waitForExit,kill}`, `elicitation.{create,complete}` (`acp.js:93-113`)
- `methods.protocol`: `cancelRequest` (`acp.js:114-116`)

### `ClientSideConnection` — the legacy class, and its true method list

Declared `sdk/dist/acp.js:1437` (`export class ClientSideConnection {`), **explicitly deprecated** at `acp.js:1451`:

```
     * @deprecated Prefer `client({ name }).connectWith(stream, async (ctx) => ...)`.
```

**Construction signature** (`acp.js:1453`) — it takes a *function that receives the connection and returns a Client handler object*, plus a stream:

```js
    constructor(toClient, stream) {
        this.connection = legacyClientApp(toClient(this))[appBuilder]()
            .connect(stream, stableConnectionOptions);
    }
```

Declared methods on `ClientSideConnection` (all take a single `params` object unless noted): `initialize` (1469), `newSession` (1489), `loadSession` (1507), `unstable_forkSession` (1527), `listSessions` (1539), `deleteSession` (1547), `resumeSession` (1561), `closeSession` (1572), `setSessionMode` (1590), `setSessionConfigOption` (1599), `authenticate` (1613), `unstable_listProviders` (1627), `unstable_setProvider` (1641), `unstable_disableProvider` (1655), `logout` (1661), `prompt` (1677), `cancel` (1693), `unstable_startNes` (1703), `unstable_suggestNes` (1713), `unstable_closeNes` (1723), `unstable_didOpenDocument` (1733), `unstable_didChangeDocument` (1743), `unstable_didCloseDocument` (1753), `unstable_didSaveDocument` (1763), `unstable_didFocusDocument` (1773), `unstable_acceptNes` (1783), `unstable_rejectNes` (1793), `request(method, params, options)` (1796), `notify(method, params)` (1800), `extMethod(method, params)` (1808), `extNotification(method, params)` (1816), plus getters `signal` (1847) and `closed` (1865).

**Important negative findings for the claimed method set:**

- ❌ **`terminalOutput`, `readTextFile`, `writeTextFile` are NOT on `ClientSideConnection`.** Those are **client-side** handlers the agent calls; on the agent side they live on `AgentContext`/`AgentSideConnection`. The only matches in the 1437–1868 class body are absent — grep confirms the class ends at line 1868 with only `signal`/`closed` after 1816.
- ❌ **`extMethod`/`extNotification` exist but are deprecated**: `acp.js:1806` `@deprecated Use {@link request}.` and `acp.js:1814` `@deprecated Use {@link notify}.`
- ❌ **`setSessionMode` is the correct name** — not `setSessionConfigOption`-style variants, and there is no plain `setMode`. Confirmed `acp.js:1590` `setSessionMode(params) {`.
- ✅ `initialize`, `newSession`, `prompt`, `cancel`, `loadSession`, `resumeSession`, `listSessions`, `closeSession`, `setSessionConfigOption`, `authenticate` **are all present** on `ClientSideConnection` — but they are agent-side calls, so the doc must not describe them as "methods on the returned object" of `client(...)`.
- ❌ No `acp.client(...)`-returned `deleteSession`: `deleteSession` appears on `ClientSideConnection` (1547) but `ClientApp` has no such method; session deletion via the new API goes through `ctx.request(methods.agent.session.delete, ...)`.

### `SessionBuilder` (declared `acp.js:366`)

`constructor(cx, request)` (369); `static create(cx, request)` (374, internal); `toRequest()` (383); `withAdditionalDirectories(additionalDirectories)` (392); `withMcpServer(mcpServer)` (402); `start(options)` (416); `withSession(op)` (423).

Note `acp.js:196-198` — a bare string cwd builds `{ cwd, mcpServers: [] }`:

```js
        return SessionBuilder.create(this, {
            cwd: cwdOrRequest,
            mcpServers: [],
        });
```

### `ActiveSession` (declared `acp.js:440`)

`constructor(cx, sessionResponse, updates, registrations)` (445); getters `sessionId` (458), `modes` (464), `meta` (470, returns `sessionResponse._meta`), `newSessionResponse` (476); `prompt(prompt, options)` (487); `nextUpdate()` (507); `readText()` (517, async); `dispose()` (538); `[Symbol.dispose]()` (547); `promptBlocks(prompt)` (550).

---

## D16. `createWebSocketStream(serverUrl, opts)`

### Verdict: ✅ **CONFIRMED** with one naming caveat (`opts` is spelled `options`)

Declaration — `sdk/dist/ws-stream.js:26`:

```js
export function createWebSocketStream(serverUrl, options = {}) {
    return new WebSocketStreamTransport(serverUrl, options).stream;
}
```

**Every option field name**, taken from the only reads of the object (`ws-stream.js:42-47`):

```js
        const WebSocketCtor = resolveWebSocket(options.WebSocket);
        const cookiePolicy = options.cookies ?? "include";
        this.cookieStore = options.cookieStore ?? new MemoryAcpCookieStore();
        this.ownsCookieStore = options.cookieStore === undefined;
        this.socket = new WebSocketCtor(serverUrl, options.protocols, {
            headers: createConstructorHeaders(options.headers, cookiePolicy, this.cookieStore),
        });
```

| Field | Type / default | Evidence |
|---|---|---|
| `WebSocket` | constructor; falls back to `globalThis.WebSocket`, else throws | `ws-stream.js:42`, `244-251` |
| `cookies` | `"include"` default; any other value skips cookie attachment | `ws-stream.js:43`, `201` |
| `cookieStore` | `AcpCookieStore`; defaults to `new MemoryAcpCookieStore()` | `ws-stream.js:44-45` |
| `protocols` | passed as 2nd arg to the WebSocket ctor | `ws-stream.js:46` |
| `headers` | header record; merged with stored cookies | `ws-stream.js:47`, `199-210` |

There is **no** `timeout`, `reconnect`, `retries`, `maxRetries`, `origin`, or `auth` field. The thrown message when no ctor is available (`ws-stream.js:251`):

```js
    throw new Error("createWebSocketStream requires globalThis.WebSocket or options.WebSocket");
```

JSDoc (`ws-stream.js:9-10`): *"In Node, pass a WebSocket constructor such as `ws.WebSocket` via `options.WebSocket`."*

Only these five fields are read in the whole file — verified by grepping `options\.` (matches at lines 42, 43, 44, 45, 46, 47 only).

### Exports map key for `/experimental/ws-client`

### Verdict: ✅ **CONFIRMED** — exact key is `"./experimental/ws-client"`

Verbatim from `sdk/package.json:41-45`:

```json
    "./experimental/ws-client": {
      "types": "./dist/ws-stream.d.ts",
      "import": "./dist/ws-stream.js",
      "default": "./dist/ws-stream.js"
    },
```

Full `exports` map for context (`sdk/package.json:25-58`): keys are exactly `"."`, `"./experimental/v2"`, `"./experimental/http-client"`, `"./experimental/ws-client"`, `"./experimental/server"`, `"./experimental/node"`, `"./schema/schema.json"`, `"./schema/v2/schema.unstable.json"`. Note `"./experimental/server"` maps to `./dist/server.js` and `"./experimental/node"` to `./dist/node-adapter.js`.

---

## D17. `AcpServer` from `./experimental/server`

### Verdict: ❌ **WRONG on constructor params (partially)**, ✅ **CONFIRMED on `prepareWebSocketUpgrade()` return shape**

**Import path check:** `@agentclientprotocol/sdk/experimental/server` → `./dist/server.js` (`sdk/package.json:46-50`). So "`./experimental/server`" is right; in a consumer it is the subpath `/experimental/server`.

**Constructor** — `sdk/dist/server.js:19-21`. It takes **one options object**, not positional arguments:

```js
    constructor(options) {
        this.agent = resolveAgent(options);
    }
```

`options` must contain **exactly one** of `agent`, `createAgent`, `createLegacyAgent` — enforced at runtime (`server.js`, `resolveAgent`):

```js
    const sourceCount = (options.agent ? 1 : 0) +
        (options.createAgent ? 1 : 0) +
        (options.createLegacyAgent ? 1 : 0);
    if (sourceCount !== 1) {
        throw new Error("AcpServer requires exactly one of agent, createAgent, or createLegacyAgent");
    }
```

and `hasAgent` is `Boolean(options.agent || options.createAgent || options.createLegacyAgent)`. The accepted agent shape is `{ connect(stream, connectOptions) }`, built for `createAgent` as:

```js
        return {
            connect: (stream, connectOptions) => options.createAgent().connect(stream, connectOptions ?? {}),
        };
```

Class fields (`server.js:16-18`): `agent`, `registry = new ConnectionRegistry()`, `webSocketSessions = new Set()`.

**`prepareWebSocketUpgrade()`** — declared at `sdk/dist/server.js:36`. It takes an optional options object (`prepareWebSocketUpgrade(options = {})`), and returns an object with **exactly three** keys: `connectionId`, `accept(socket)`, `reject()`. Verbatim (`server.js:35-65`):

```js
    /** Creates a WebSocket connection before accepting the HTTP upgrade. */
    prepareWebSocketUpgrade(options = {}) {
        const agent = agentOverride(options, this.agent);
        const connection = this.registry.createPendingConnection(agent);
        let isSettled = false;
        return {
            connectionId: connection.connectionId,
            accept: (socket) => {
                if (isSettled) {
                    throw new Error("ACP WebSocket upgrade has already been settled");
                }
                isSettled = true;
                const session = handleWebSocketConnection(socket, {
                    registry: this.registry,
                    agent,
                    connection,
                });
                this.webSocketSessions.add(session);
                void session.closed.finally(() => {
                    this.webSocketSessions.delete(session);
                });
            },
            reject: () => {
                if (isSettled) {
                    return;
                }
                isSettled = true;
                this.registry.discard(connection.connectionId);
            },
        };
    }
```

Accurate return shape:

```ts
{
  connectionId: string,
  accept(socket): void,   // throws if already settled
  reject(): void          // no-op if already settled
}
```

Doc comment (`server.js:11-13`) explains why `connectionId` is exposed: *"For WebSocket upgrades, use `{@link prepareWebSocketUpgrade}` so adapters can attach `Acp-Connection-Id` to the `101 Switching Protocols` response."*

Other public methods: `handleRequest(req, options = {})` (23, async; POST→handlePost, GET→handleGet, DELETE→handleDelete, else `textResponse("Method Not Allowed", 405)`), `close()` (67, async).

**❌ Not found in DSH:** no DSH package imports `AcpServer` or the `/experimental/server` subpath. A recursive content grep over all of `...\asar\dsh\node_modules\@deepseek-ai\` for `experimental/ws-client|experimental/server|createWebSocketStream|AcpServer` returned **no matches**. DSH's ACP bridge is stdio-only, not HTTP/WS: `dsh-acp/lib/index.js:1319`

```js
	const stream = config.stream ?? ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
```

---

## D18. Client-side `session/update` subscription and `session/request_permission` answering

### Verdict: ✅ **CONFIRMED** on `outcome` shape; ❌ **WRONG** if the doc says "subscribe by property/event name"

**How a client subscribes (SDK ≥ this version):** by ACP **method-string key**, via `onNotification` / `onRequest` on the `ClientApp` returned by `client(...)`. It is *not* a subscribe-by-handler-name scheme.

`sdk/dist/acp.js:910` (`onNotification(method, handlerOrParams, handler)`) and `acp.js:900` (`onRequest(...)`). Canonical form — `sdk/dist/examples/ws-client.js:44-48`:

```js
    const { initialized, result } = await acp
        .client({ name: "ws-example-client" })
        .onRequest(acp.methods.client.session.requestPermission, (ctx) => client.requestPermission(ctx.params))
        .onNotification(acp.methods.client.session.update, (ctx) => client.sessionUpdate(ctx.params))
        .connectWith(stream, async (ctx) => {
```

Resolved literals: `methods.client.session.update` = `CLIENT_METHODS.session_update` = `"session/update"`; `methods.client.session.requestPermission` = `"session/request_permission"` (`acp.js:93-97`). If an unknown method string is passed, `onRequest` throws (`acp.js:906`): `` `Unknown ACP request method '${method}'. Pass a params parser for custom methods.` ``

**Legacy/deprecated route** (`sdk/dist/acp.js:1106-1109`) — this is where the "handler object with `sessionUpdate` / `requestPermission`" form lives. `legacyClientApp(implementation)` wires exactly these implementation members:

```js
function legacyClientApp(implementation) {
    const app = client()
        .onRequest(schema.CLIENT_METHODS.session_request_permission, (ctx) => implementation.requestPermission(ctx.params))
        .onNotification(schema.CLIENT_METHODS.session_update, (ctx) => implementation.sessionUpdate(ctx.params))
        .onRequest(schema.CLIENT_METHODS.fs_write_text_file, async (ctx) => (await implementation.writeTextFile?.(ctx.params)) ?? {})
        .onRequest(schema.CLIENT_METHODS.fs_read_text_file, async (ctx) => (await implementation.readTextFile?.(ctx.params)))
        .onRequest(schema.CLIENT_METHODS.terminal_create, async (ctx) => (await implementation.createTerminal?.(ctx.params)))
        .onRequest(schema.CLIENT_METHODS.terminal_output, async (ctx) => (await implementation.terminalOutput?.(ctx.params)))
        .onRequest(schema.CLIENT_METHODS.terminal_release, async (ctx) => (await implementation.releaseTerminal?.(ctx.params)) ?? {})
        .onRequest(schema.CLIENT_METHODS.terminal_wait_for_exit, async (ctx) => (await implementation.waitForTerminalExit?.(ctx.params)))
        .onRequest(schema.CLIENT_METHODS.terminal_kill, async (ctx) => (await implementation.killTerminal?.(ctx.params)) ?? {});
```

Optional members, gated by presence checks: `createElicitation` (1117-1119), `completeElicitation` (1120-1122), `extMethod(method, params)` (1123-1135), `extNotification(method, params)` (1136-1148).

So the **complete exact member-name list** of the legacy client handler object is:

`requestPermission`, `sessionUpdate`, `writeTextFile?`, `readTextFile?`, `createTerminal?`, `terminalOutput?`, `releaseTerminal?`, `waitForTerminalExit?`, `killTerminal?`, `createElicitation?`, `completeElicitation?`, `extMethod?`, `extNotification?`

All receive a **single `params` object** (note `extMethod`/`extNotification` take `(method, params)`).

### `ClientSideConnection` construction signature (what handler object it takes)

`sdk/dist/acp.js:1453`:

```js
    constructor(toClient, stream) {
        this.connection = legacyClientApp(toClient(this))[appBuilder]()
            .connect(stream, stableConnectionOptions);
    }
```

**It takes a *factory function* `toClient(connection) => ClientImplementation`, not a handler object and not a params object.** The factory is invoked immediately with the not-yet-fully-constructed `this` (so `toClient` must not use the connection eagerly). JSDoc (`acp.js:1445-1447`):

```
     * @param toClient - A function that creates a Client handler to process incoming agent requests
     * @param stream - The bidirectional message stream for communication. Typically created using
     *                 {@link ndJsonStream} for stdio-based connections.
```

Documented construction (`acp.js:1831`): `const connection = new ClientSideConnection(client, stream);`

### `RequestPermissionRequest` fields

`sdk/dist/schema/zod.gen.js:340-345`:

```js
export const zRequestPermissionRequest = z.object({
    sessionId: zSessionId,
    toolCall: zToolCallUpdate,
    options: z.array(zPermissionOption),
    _meta: defaultOnError(z.record(z.string(), z.unknown()).nullish(), () => undefined),
});
```

### `PermissionOption` fields

`sdk/dist/schema/zod.gen.js:327-332`:

```js
export const zPermissionOption = z.object({
    optionId: zPermissionOptionId,
    name: z.string(),
    kind: zPermissionOptionKind,
    _meta: defaultOnError(z.record(z.string(), z.unknown()).nullish(), () => undefined),
});
```

`kind` literal set (`zod.gen.js:318-323`): `"allow_once" | "allow_always" | "reject_once" | "reject_always"` — **snake_case**, not camelCase.

### `RequestPermissionResponse` field names and `outcome` discriminated union — EXACT

`RequestPermissionResponse` has exactly **two** fields: `outcome` (required) and `_meta`. `sdk/dist/schema/zod.gen.js:2758-2761`:

```js
export const zRequestPermissionResponse = z.object({
    outcome: zRequestPermissionOutcome,
    _meta: defaultOnError(z.record(z.string(), z.unknown()).nullish(), () => undefined),
});
```

The `outcome` discriminated union, `zod.gen.js:2747-2754` — **the discriminant key is `outcome` and it is NESTED, so the value is `{ outcome: { outcome: "selected", optionId } }`**:

```js
export const zRequestPermissionOutcome = z.union([
    z.object({
        outcome: z.literal("cancelled"),
    }),
    zSelectedPermissionOutcome.and(z.object({
        outcome: z.literal("selected"),
    })),
]);
```

and `zod.gen.js:2740-2743`:

```js
export const zSelectedPermissionOutcome = z.object({
    optionId: zPermissionOptionId,
    _meta: defaultOnError(z.record(z.string(), z.unknown()).nullish(), () => undefined),
});
```

Independent confirmation from the protocol JSON Schema, `sdk/schema/schema.json:8029-8062` — `"discriminator": { "propertyName": "outcome" }` with `const: "cancelled"` and `const: "selected"`, and `"required": ["outcome"]` (`schema.json:8025`). The **selected** variant is `allOf` `SelectedPermissionOutcome` (`schema.json:8064-8074`, providing `optionId`).

**Exact literals:** `"selected"`, `"cancelled"` (British spelling, double-l, single `l` before `ed` — not `"canceled"`).

**So:** `{ outcome: { outcome: 'selected', optionId } }` ✅ and `{ outcome: { outcome: 'cancelled' } }` ✅ — but only if the doc's outer wrapper is included. A doc writing `{outcome:'selected', optionId}` **flat** is ❌ **WRONG**: that fails zod validation on `zRequestPermissionResponse` (the outer `outcome` must itself be an object).

Working example, `sdk/dist/examples/client.js:24-29`:

```js
                return {
                    outcome: {
                        outcome: "selected",
                        optionId: params.options[optionIndex].optionId,
                    },
                };
```

and `sdk/dist/examples/ws-client.js:7-12`:

```js
        return {
            outcome: {
                outcome: "selected",
                optionId: params.options[0]?.optionId ?? "allow",
            },
        };
```

### `SessionNotification` (the payload of `session/update`)

`sdk/dist/schema/zod.gen.js:2073-2077`:

```js
export const zSessionNotification = z.object({
    sessionId: zSessionId,
    update: zSessionUpdate,
    _meta: defaultOnError(z.record(z.string(), z.unknown()).nullish(), () => undefined),
});
```

**The payload field is `update` (singular), NOT `sessionUpdate`.** The discriminator `sessionUpdate` lives *inside* `update`. Confirmed by the router at `acp.js:680-685`:

```js
        const notification = validate.zSessionNotification.parse(message.params);
        const update = {
            kind: "session_update",
            notification,
            update: notification.update,
        };
```

and by consumer code `sdk/dist/examples/ws-client.js:14-16`:

```js
    async sessionUpdate(params) {
        const update = params.update;
        if (update.sessionUpdate === "agent_message_chunk") {
```

### `SessionUpdate` discriminant values — complete list

`sdk/dist/schema/zod.gen.js:2019-2065` (`zSessionUpdate`), 15 variants in source order:

`"user_message_chunk"`, `"agent_message_chunk"`, `"agent_thought_chunk"`, `"tool_call"`, `"tool_call_update"`, `"plan"`, `"plan_update"`, `"plan_removed"`, `"available_commands_update"`, `"current_mode_update"`, `"config_option_update"`, `"session_info_update"`, `"usage_update"`, `"compaction_update"`, `"compaction_summary_chunk"`.

Each is a `.and()` intersection with the payload schema, e.g. (`zod.gen.js:2023-2025`):

```js
    zContentChunk.and(z.object({
        sessionUpdate: z.literal("agent_message_chunk"),
    })),
```

### Additional D18-relevant fact

`SessionUpdateRouter.handleMessage` intercepts `session/update` **before** user handlers and returns `Handled.no(message)` in both branches (`acp.js:676-692`), so a `connectWith` + `nextUpdate()` flow and an `onNotification(...session.update...)` handler are alternative routes. Both are wired in `ClientApp`'s constructor (`acp.js:870-873`).

---

## D19. ACP `session/new` request fields, and what DSH enforces

### Verdict: ✅ **CONFIRMED** — the field names are `cwd`, `additionalDirectories`, `mcpServers`, `_meta`

SDK zod schema, `sdk/dist/schema/zod.gen.js:2422-2427`:

```js
export const zNewSessionRequest = z.object({
    cwd: z.string(),
    additionalDirectories: defaultOnError(vecSkipError(z.string()).optional(), () => []),
    mcpServers: requiredDefaultOnError(vecSkipError(zMcpServer), () => []),
    _meta: defaultOnError(z.record(z.string(), z.unknown()).nullish(), () => undefined),
});
```

`sdk/schema/schema.json:6787` states the wire requirement:

```json
      "required": ["cwd", "mcpServers"],
```

Field descriptions (`schema.json:6758-6785`):

- `cwd` — *"The working directory for this session. Must be an absolute path."*
- `additionalDirectories` — *"Additional workspace roots for this session. Each path must be absolute. … When omitted or empty, no additional roots are activated for the new session."* Marked `"x-deserialize-default-on-error": true` and `"x-deserialize-skip-invalid-items": true` (so malformed entries are **dropped, not rejected**, by SDK deserialization).
- `mcpServers` — *"List of MCP (Model Context Protocol) servers the agent should connect to."* Same two `x-deserialize-*` flags.

`"x-side": "agent"`, `"x-method": "session/new"` (`schema.json:6788-6789`). There is **no** `cwd`-alias, no `sessionId`, no `workspace`, no `mode`, no `model`, no `env`, no `title` field in `NewSessionRequest`.

The SDK client helper confirms the minimal shape it constructs — `acp.js:194-198` sends `{ cwd, mcpServers: [] }`, and `cloneNewSessionRequest` (`acp.js:349-357`) defensively copies `additionalDirectories` and `mcpServers`.

### What DSH actually enforces/validates

DSH registers the server-side handler against the SDK composable API, `dsh-acp/lib/index.js:1320-1323`:

```js
	const connection = agent({ name: "deepseek-harness-acp" }).onRequest(methods.agent.initialize, ({ params }) => implementation.initialize(params)).onRequest(methods.agent.authenticate, async ({ params }) => {
		await implementation.authenticate(params);
		return {};
	}).onRequest(methods.agent.session.new, ({ params, signal }) => implementation.newSession(params, signal)).onRequest(methods.agent.session.list, ({ params, signal }) => implementation.listSessions(params, signal)).onRequest(methods.agent.session.resume, ({ params, signal }) => implementation.resumeSession(params, signal)).onRequest(methods.agent.session.close, ({ params }) => implementation.closeSession(params)).onRequest(methods.agent.session.setConfigOption, ({ params, signal }) => implementation.setSessionConfigOption(params, signal)).onRequest(methods.agent.session.prompt, ({ params, signal }) => implementation.prompt(params, signal)).onNotification(methods.agent.session.cancel, ({ params }) => implementation.cancel(params)).connect(stream);
```

(Note: the whole `agent(...)` chain is on **line 1323** — a single long bundled line. It does **not** support `session/load`, and DSH's README says so.)

`newSession` handler, `dsh-acp/lib/index.js:1168-1186`:

```js
		async newSession(params, signal) {
			assertOpen();
			validateWorkspaceParams(params);
			const sessionId = brandString(randomUUID());
			let record;
			try {
				record = await AcpSession.create(ctx, {
					sessionId,
					cwd: params.cwd,
					mcpServers: params.mcpServers,
					agentOptions: agentOptions(config),
					fallbackSelection: initialSelection(config),
					signal,
					notify
				});
			} catch (error) {
				if (error instanceof AcpMcpConfigError) throw invalidParams(error.message);
				throw error;
			}
```

**The enforcement function** — `dsh-acp/lib/index.js:1409-1413`:

```js
/** Reject workspace features outside the automation contract. */
function validateWorkspaceParams(params) {
	if (!isAbsolute(params.cwd)) throw invalidParams(`cwd must be an absolute path: ${params.cwd}`);
	if (params.additionalDirectories !== void 0 && params.additionalDirectories !== null && params.additionalDirectories.length > 0) throw invalidParams("additionalDirectories is not supported");
}
```

Summary of DSH enforcement for `session/new`:

| Field | DSH behavior | Evidence |
|---|---|---|
| `cwd` | **Required to be absolute**; otherwise `-32602`. Error text: `` cwd must be an absolute path: <cwd> `` | `index.js:1411` |
| `additionalDirectories` | **Rejected outright** if present and non-empty; `-32602` with `` additionalDirectories is not supported `` (empty array or `null`/`undefined` passes) | `index.js:1412` |
| `mcpServers` | Validated during `AcpSession.create`: duplicate normalized names, stdio `command` must be an absolute path, transport type must be `stdio`/`http`, URLs and headers checked. `AcpMcpConfigError` is mapped to `-32602` | `index.js:225-294`, `1184` |
| `_meta` | Not read or validated by DSH | — (no matches for `_meta` in the `newSession` path) |
| Session spec correctness | Any `params` object failing `zNewSessionRequest` is rejected by the SDK *before* reaching DSH (e.g. missing `cwd`) | `acp.js:595` `newSession: requestSpec(schema.AGENT_METHODS.session_new, validate.zNewSessionRequest)` |

**Error code confirmation:** `invalidParams` (used above) → `RequestError.invalidParams`, which is literally `-32602`. `sdk/dist/jsonrpc.js:1014-1015`:

```js
    static invalidParams(data, additionalMessage) {
        return new RequestError(-32602, `Invalid params${additionalMessage ? `: ${additionalMessage}` : ""}`, data);
    }
```

DSH defines its own thin wrapper at `dsh-acp/lib/index.js:649-651`:

```js
function invalidParams$1(detail) {
	return RequestError.invalidParams(void 0, detail);
}
```

**`cwd` identity checks on resume** (not `new`): `resumeSession` calls `validateWorkspaceParams` too (`index.js:1210`, so an absolute `cwd` is still required), then rejects a mismatched persisted directory with `` session cwd does not match: ${params.cwd} `` (`index.js:1217`) and again post-composition at `index.js:1234-1236`. Physical identity is compared by `sameDirectory` via `realpath`, falling back to `resolve` (`index.js:1414-1423`).

**`session/list` `cwd` filter**: `index.js:1258` — if `params.cwd` is present and not absolute, throws `` cwd must be an absolute path: ${params.cwd} ``; `index.js:1268` then filters by `sameDirectory`.

DSH README corroboration, `dsh-acp/README.md:66`:

```
| `session/new` | A fresh persistent agent whose absolute workspace and stdio or HTTP MCP servers are validated before publication, plus its complete configuration-option state. |
```

and `dsh-acp/README.md:76` lists *"additional directories"* among the **unsupported** surfaces. Also `dsh-acp/README.md:74`:

```
| `session/request_permission` | A permission prompt with one-shot allow/reject choices; your client can answer automatically. |
```

---

## Uncertain / not found

- **⚠️ `dist/acp.d.ts` and all other `.d.ts` files**: declared by `sdk/package.json:24,27,32,37,42,47,52` but **not present** in the extracted tree. Searched: `Get-ChildItem -Recurse -File` over `...\.research\sdk\` (listed above — 60 files, zero `.d.ts`). All type-level claims above are inferred from runtime JS + generated zod/JSON Schema, which are exact for field names and discriminant literals.
- **未找到**: any consumer in DSH importing `@agentclientprotocol/sdk/experimental/ws-client`, `/experimental/server`, `/experimental/http-client`, `/experimental/node`, or `/experimental/v2`. Keywords searched across `...\asar\dsh\node_modules\@deepseek-ai\`: `experimental/ws-client`, `experimental/server`, `createWebSocketStream`, `AcpServer` (grep tool, `include: *.js`, all 240+ packages). Also grepped `dsh-sdk-app/lib/index.js` and `dsh-sdk-protocol/lib/index.js` for `agentclientprotocol|acp|ClientSideConnection` — no output. Consequence: **D16 and D17 describe SDK capabilities DSH does not currently exercise**, so they cannot be corroborated from DSH usage.
- **未找到**: any `acp` namespace/object export. Keywords: `acp\s*=`, `const acp`, `var acp`, `namespace acp` in `sdk/dist/acp.js`.
- **未找到**: `terminalOutput` / `readTextFile` / `writeTextFile` as methods on `ClientSideConnection` (they exist only as legacy *client handler* member names, `acp.js:1110-1116`).
- **⚠️ `zPermissionOptionKind` vs SDK type name**: zod uses the `z`-prefixed generated names (`zPermissionOption`, `zRequestPermissionResponse`, `zSessionNotification`). The un-prefixed TS type names (`PermissionOption`, `RequestPermissionResponse`, `SessionNotification`, `SessionUpdate`, `RequestPermissionRequest`) are the `.d.ts` names and could not be quoted from a declaration file — only from `schema.json` titles (`schema.json:7843` `"title": "RequestPermissionResponse"`, `schema.json:2019` etc.).

## Byte-offset note

`dsh-acp/lib/index.js:1323` is a **single extremely long bundled line** (the whole `agent(...)...connect(stream)` chain). Line numbers for that file are exact; the quoted text there is a verbatim fragment of one long line, not a standalone line.
