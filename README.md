# Moben SDK

Moben SDK includes **App development** and **USB device debugging** in one package. The public repository is `78/moben-sdk`; the npm package remains `@moben-ai/app-sdk`, so existing import paths and APIs continue to work.

| Capability | JavaScript / TypeScript entry points | CLI |
| --- | --- | --- |
| App development | `defineApp()`, page helpers, `connect()` | `moben app ...` |
| USB device debugging | `listDevices()`, `connectDevice()` | `moben device ...` |

Both capabilities are exported from `@moben-ai/app-sdk`. App code uses the cloud connection; USB debugging uses a local serial connection with an optional, dynamically loaded `serialport` dependency. Ordinary app development works without loading that dependency. The current flat exports and command groups remain the public API.

Version **0.7.0** is initially distributed through GitHub Releases. To install it before the npm release:

```sh
gh release download v0.7.0 --repo 78/moben-sdk --pattern 'moben-ai-app-sdk-0.7.0.tgz'
npm install ./moben-ai-app-sdk-0.7.0.tgz
npx moben --version
```

The npm registry may still serve an earlier version until it is published there:

Build Moben Markdown apps that run on your own computer or server. Devices reach them through the Moben cloud: the app connects out over WebSocket, so it needs no public address or open port.

```sh
npm install @moben-ai/app-sdk
```

Requires Node.js 20.12 or newer. To start from a working app instead, run `npx -p @moben-ai/app-sdk moben app init my-app`.

```ts
import { connect, defineApp, md, page } from '@moben-ai/app-sdk';

const app = defineApp({
  manifest: {
    manifestVersion: 1, id: 'hello', name: 'Hello', version: '0.1.0', entry: '/', permissions: [],
    agent: {
      instructions: 'Greets the user.',
      tools: [{ name: 'say_hello', description: 'Greet the user by name. Use when the user asks to be greeted.', inputSchema: { type: 'object', properties: {} } }]
    }
  },
  pages: {
    '/': ctx => page(ctx, { title: 'Hello' }).heading('Hello').paragraph(`Device ${ctx.openId}`).toString()
  },
  tools: { say_hello: () => ({ result: 'Hello!' }) }
});

connect(app); // uses the key from `moben login` or MOBEN_DEVELOPER_KEY
```

1. Run `npx moben login` and approve in the browser. It saves a developer key for this computer, used by every app on it. On a server, run `npx moben login` once as the user that runs the app; over SSH it only prints the link. In containers or CI, copy the key from `~/.config/moben/credentials.json` into the `MOBEN_DEVELOPER_KEY` environment variable.
2. Give each app its own `manifest.id`, such as `hello` or `computer-status`. Run it with `node app.js` (or `tsx app.ts`). The app appears in Console the first time it connects, and the log shows `[moben] hello is online`.
3. Open the app from the device app list. While the process is stopped the app shows as offline.

`connect(app, options)` accepts `key` (defaults to `MOBEN_DEVELOPER_KEY`, then the key saved by `moben login`), `url` (defaults to `MOBEN_APP_CONNECT_URL`, the server you logged in to, or `wss://moben.cn/api/app-connect/ws`), `logger` and `onStatus`. It reconnects with backoff and stops when the key is revoked, the manifest is rejected, or another process connects as the same app. To run several apps in one process, call `connect()` once per app.

Name tools verb first after what they do, with lowercase letters, digits and underscores, and describe when to use them: the assistant picks tools by name and description. It sees them as `app_<name>` (here `app_say_hello`); the SDK and cloud translate the names.

Tools may set `showCall: false` in `manifest.agent.tools` to hide their call icon, name and elapsed time in assistant replies. It defaults to `true`. The tool still runs and its result reaches the assistant; saving and page effects work as usual. This also applies when another conversation calls the tool through `apps_call`.

Pages, actions, tools and Action Sheets follow the same contract as official Moben apps. Throw `AppRequestError(status, message)` to show a message to the user. All pages stream by default; strings are one chunk and generators may keep yielding. Apps can also take voice input: a page can send what the user says to the app, as recognized text or as the recording itself (`REMOTE_APPS.md`, section 9).

## App development commands

The package installs a `moben` command. Account commands sit at the top level; app commands are under `moben app`. `app page`, `app action`, `app tool`, `app voice` and `app validate` load your app without connecting and run the same checks as the cloud, so you and coding agents can test changes before trying them on a device. Before 0.5 the app commands had no `app` prefix; the short forms still work for now and print a note.

```sh
npx moben login                              # authorize this computer in the browser
npx moben whoami                             # show the account, key and apps
npx moben app init my-app                    # create an app with an AGENTS.md for coding agents
npx moben app validate                       # check the manifest; render every page in English and Chinese
npx moben app page /items/42 --locale zh-CN  # print a page exactly as the device receives it
npx moben app page /log             # print a streaming page part by part; Ctrl-C leaves it
npx moben app action /items/42/delete --page /items/42
npx moben app tool add_note --args '{"text":"Buy milk"}'
npx moben app voice /notes/voice --text "Buy milk" --page /   # or --file memo.ogg for an audio route
npx moben app dev                            # connect and restart when files change
```

`--args` also accepts `@file.json` or `-` for stdin, which avoids quoting problems in cmd and Windows PowerShell. Warnings say which links or images the cloud would remove and why, and when a page or tool is too slow or too large. Add `--json` for machine-readable output; failures exit with a non-zero code. The entry defaults to `app.ts`; use `--entry` for another file and `--app` when one process connects several apps. TypeScript entries need `tsx` installed in the app.

`moben login` prints a link and a confirmation code. On a desktop you can press Enter to open the link; over SSH, on a server without a display, or when a coding agent runs the command, it only prints the link, which you can open on any computer or phone signed in to Moben. It creates a key on the machine where it runs and sends the cloud only its SHA-256 digest; the key becomes valid once you approve the request in Console, where it is listed as "CLI · <hostname>". It is saved in `~/.config/moben/credentials.json` (`%APPDATA%\moben` on Windows) with owner-only permissions. Logging in again replaces and revokes the previous key of this computer, and `moben logout` revokes and deletes it. `MOBEN_DEVELOPER_KEY` takes precedence over the saved key. Use `--api` or `MOBEN_API_URL` for another Moben server.

## USB device debugging

The SDK also includes local USB debugging. Run these commands **on the computer physically connected to the device**. No developer login, Python, ESP-IDF or flashing tool is required for USB access. App pages still use the device's normal cloud connection and permissions.

On the device, turn **Advanced settings → Low power mode OFF**, connect a USB data cable, and close other serial monitors. Windows 10/11, Linux and macOS are the target platforms; Windows 7 is unsupported. Typical ports are `COM3`, `/dev/ttyACM0` and `/dev/cu.usbmodem101` respectively.

```sh
npx moben device list                         # enumerate only; never opens a port
npx moben device doctor --port COM3            # verify brand, protocol and power settings
npx moben device hello --port COM3             # identity and capabilities
npx moben device status --port COM3            # application, power and memory fields
npx moben device tasks --port COM3             # minimum unused task stack since creation, in bytes
npx moben device open /apps/moben.reader/ --port COM3
npx moben device key next --port COM3
npx moben device key voice --event long --port COM3
npx moben device text "Add a note: buy milk" --port COM3
npx moben device snapshot --port COM3 --output page.json --json
npx moben device logs --port COM3 --output serial.log
npx moben device screenshot --output screen.png --port COM3
npx moben device screenshot --format l8 --output screen-l8.png --port COM3
```

Use the page URL shown by your running app or `moben app page`; remote apps have their own cloud-assigned ID. USB `open` accepts canonical `/apps/` URLs only (up to 107 ASCII bytes), with no external URLs, `action:` links or fragments. It does not upload or start your app process.

`list` marks Espressif `303a:1001` ports as **candidates**, not confirmed Moben devices. Commands may omit `--port` only when exactly one candidate exists. Metadata can be missing; use `--port` explicitly in that case. `HELLO product=moben model=pocket-sage` confirms the product, and `doctor` reports ready only after `STATUS` also confirms `low_power=0 light_sleep=0`. This is product identification, not cryptographic authentication. Legacy PSG1 firmware without product fields remains usable for advertised capabilities, with an unconfirmed-brand warning; `doctor` exits 1 until identity and power settings are verified.

All commands support `--json`. Errors return `{ "ok": false, "error": "...", "code": "..." }`; device rejections also include `deviceCode`. Exit codes: 0 success, 1 connection/protocol/operation failure or unconfirmed doctor result, 2 invalid arguments, 130/143 interrupted. Missing ports, open failures, handshake timeouts and identity mismatches have different codes. Discovery does not independently enumerate USB/PnP devices, so missing drivers are a possible cause, never a confirmed diagnosis. Use `--timeout <seconds>` to change the 8-second per-command deadline (maximum 120 seconds).

`serialport` is an optional dependency loaded only by USB operations. If your install omits optional dependencies or its native addon cannot load, install `serialport@^13` in your app. Cloud apps and account/local app commands do not load it.

JavaScript/TypeScript uses the same client:

```ts
import { connectDevice, listDevices } from '@moben-ai/app-sdk';
import { writeFile } from 'node:fs/promises';

console.log(await listDevices());
const device = await connectDevice({ port: 'COM3', timeoutMs: 8000 });
try {
  console.log(await device.hello());
  console.log(await device.status());
  const frame = await device.capture({ format: 'panel' });
  await writeFile('screen.png', frame.png());
  console.log(frame.frameId, frame.completedFrameId, frame.refreshing);
} finally {
  await device.close();
}
```

The client also provides `tasks()`, `open(url)` and `key(button, event = 'click')`. `connectDevice` accepts an `AbortSignal`; close the connection in `finally`. Requests on a connection are serialized. Frame corruption, transport errors and timeouts invalidate the session; reconnect explicitly. Commands are never automatically replayed, since a timed-out UI command may already have executed. `voice`/`prev`/`next`/`menu` refer to application keys; events must be advertised by firmware, and menu has no down/up events. Menu long press is limited by firmware to an active browser session. These events do not emulate electrical GPIO timing or replace physical button/recording tests.

`await device.text(message)` submits one device voice flow with replacement ASR text, using the same TEXT/down/long/up sequence as the firmware Python tool. Text must be a nonempty single line of at most **72 UTF-8 bytes**. The cloud must allow this device in `debug.asrTextDevices`; otherwise it rejects the request with 403 on the device. The command briefly records audio and retains normal page context, app authorization, usage and tool execution. It tests the downstream voice/app flow, not microphone or ASR accuracy. Completion acknowledges submission, not the assistant/app reply. The whole gesture sequence holds the SDK request queue; on firmware advertising `text_cancel=1`, cancellation first aborts the recording with `CANCELTEXT`, then releases voice-up; if cancellation fails it does not release and accidentally submit. Firmware advertising `text_clear=1` also clears unused replacement text after a failed/cancelled flow. Older firmware only supports best-effort voice-up cleanup, which may submit a recording; update before relying on cancellation. Cancellation cannot retract audio/text already delivered to a server. Transport loss can prevent cleanup; commands are never replayed.

`await device.snapshot()` requires firmware advertising `snapshot=1`. It returns device state, modal/assistant visibility, current frame metadata and `browser`. Outside an active rendered Browser document, `browser` is `null` (retained, inactive history is not exported). An active Browser snapshot includes:

- `markdown`: the complete **currently loaded** source document, including hidden metadata; `text`: rendered text across every loaded screen, separated by form feeds (`\f`); `visibleText`: the current displayed screen's text.
- App ID, URL, title, revision, navigation/content revision IDs, loading/receiving/completion/truncation flags and `launching`/`pendingUrl` to identify a placeholder or pending navigation.
- Reading/selection `mode`, one-based screen index, loaded screen count and final count (`null` until complete/truncated).
- **All** loaded links, with text, normalized target (or raw URL if invalid), validity, zero-based occurrence index, one-based screen (or `null`) and focus. `focusedLinkIndex` distinguishes repeated links with the same URL. An open Action Sheet includes its items and focused index.

Snapshots only read existing state under the GUI lock: they do not navigate, refresh, render, report progress, select links or rebuild inactive history. Modal/assistant flags describe overlays above the exported Browser page; their own body text is not included. Semantic focus can precede a pending GUI render, so use screenshots/frame metadata to inspect actual submitted pixels. A growing or truncated document is exported as-is, without pretending the server's entire response has arrived.

Firmware measures escaped JSON, then allocates exactly one temporary output buffer: below 4 KiB it uses ordinary heap memory; larger output uses PSRAM and preserves 128 KiB headroom. Rendered text is read from existing layout fragments directly into JSON, without a second full-text buffer. The buffer is released after transmission/failure; no extra task or resident document/log cache is added. Exports over 2 MiB return `snapshot_too_large`, and allocation failure returns `no_memory`, with no partial result silently presented as complete. The SDK validates length, CRC, end marker, UTF-8, JSON and structure before exposing/saving it. For large pages, use `--timeout 30` or a larger `timeoutMs`. `snapshot --output page.json` writes atomically; with `--json`, stdout also includes the full snapshot and output path.

`device.onLog(log => { ... })` subscribes to live ordinary logs on the same connection and returns an unsubscribe function. Pass `onLog` to `connectDevice` to also receive logs during the initial handshake. Entries are `{ line, truncated }`; original text is preserved, partial UTF-8 lines are joined, stale protocol replies are filtered and binary screenshot/snapshot payloads are never treated as logs. An oversized idle line is bounded to 4096 bytes and marked truncated. Callbacks should return quickly; their exceptions are isolated from USB requests. `await device.whenClosed()` resolves with the `DeviceError` explaining closure.

`moben device logs` follows until Ctrl-C and optionally appends to a host file with `--output`. `--json` produces newline-delimited JSON log events. It uses the existing serial stream; firmware logging and kernel output are unchanged, and logs from before connection cannot be recovered. A standalone logs command holds the port exclusively: to capture logs while issuing other commands, use one JS client with an `onLog` callback. CLI output/file errors and excessive stdout backpressure stop log following instead of allocating an unbounded host queue.

An `open` acknowledgement means the page request was accepted, and a key acknowledgement means the application processed the event. Neither guarantees a new rendered frame or completed e-ink refresh. Captures are immediate and return `frameId`, `completedFrameId` and `refreshing`; check the image and capture again after loading as needed. Matching completed frame IDs do not prove that a streaming page has finished loading. `panel` (default) captures the most recently submitted monochrome/four-gray frame; `l8` captures the rendered grayscale buffer with antialiasing. Both are framebuffers, not optical readbacks, so they cannot show ghosting or physical contrast. PNG encoding happens on the computer after dimensions, payload, end marker and decoded-pixel CRC have passed. The CLI replaces the destination only after validation and PNG encoding succeed.

Hardware verification (2026-10-26): flashed the normal ESP32-S3 firmware (allocation profiling/boot validation OFF) and verified on macOS: Moben identity/power diagnostics; status/tasks; PANEL/L8 captures; launcher/reader navigation; default reading, current-screen selection and retained return focus; complete 1653-link/93-screen export (607477 JSON bytes); JS/CLI text with actual assistant replies; cancellation; log/capture coexistence; interrupted large-snapshot reconnection; and ten repeated port opens without device reset. Fifty small snapshots and five large snapshots showed zero retained SRAM/PSRAM change in the measured runs. Live low-power switching also passed: enabling low power disabled PSG1 and caused a handshake timeout (doctor exit 1), while the Espressif serial candidate remained enumerable; manually disabling low power restored identity/status/tasks/capture and key commands. The device was returned to idle with low power/light sleep OFF. Windows/Linux hardware checks remain pending. Automated SDK tests cover protocol validation, CLI diagnostics, optional-module isolation, safe cancellation and handshake resynchronization.

## Languages

English is the default. Devices set to Chinese should see Chinese, so keep user-visible strings in a translation table and localize the launcher name in the manifest:

```ts
import { createAppTranslator } from '@moben-ai/app-sdk';

const text = createAppTranslator({
  en: { title: 'Hello', greeting: 'Hello from {name}' },
  'zh-CN': { title: '你好', greeting: '来自 {name} 的问候' }
});

// In a page handler: text(ctx, 'greeting', { name: 'my computer' })
// In the manifest:   locales: { 'zh-CN': { name: '你好' } }
```

`ctx.locale` carries the device language and `ctx.timezone` its time zone. Missing Chinese keys fall back to English.

## More

See `REMOTE_APPS.md` for the protocol and limits, and its sections 9 and 10 for designing pages for the e-ink screen, storing data and writing tool results. `examples/machine` (also shipped in this package) is a minimal cross-platform app that shows the computer's configuration in English or Chinese, with an `AGENTS.md` for coding agents.

## Development

```sh
npm ci
npm test
npm run typecheck
npm run build
```

### Implementation boundaries

App definition, cloud connectivity, request dispatch and local app commands live in `src/define.ts`, `src/connect.ts`, `src/dispatch.ts`, `src/local.ts` and the App portion of `src/cli.ts`. Shared page, manifest and validation helpers live in `src/core`.

USB transport and the device client live in `src/device.ts`, protocol parsing and frame/snapshot validation in `src/device-protocol.ts`, and device commands in `src/device-cli.ts`. Keep serial transport details within those modules. Adding a device command should preserve the independent App connection and the optional loading of serial dependencies.

Text voice routes deliver final text only through the existing `voice.start/end`: `await speech.done` and the one-value `speech.transcripts` iterator remain compatible. Device live transcription is independent. If the API connection closes during audio input, the SDK ends `chunks` and resolves `done` with `complete: false` so your handler can save received audio; explicit cancellation still aborts, and there is no automatic recording reconnect, acknowledgement or replay.

### Source ownership and synchronization

The product monorepo remains the source for this release workflow:

- `packages/app-sdk` owns the SDK-specific implementation, tests, templates and documentation.
- `api/src/app-sdk` owns the shared page/manifest helpers and gateway validation. In the product monorepo, `scripts/sync-core.mjs` regenerates the SDK's `src/core` from that source before tests and builds.
- The public `78/moben-sdk` repository contains a standalone SDK snapshot, including `src/core` and its lockfile. With no upstream helper directory present, the script uses the checked-in snapshot, so contributors can install, test and build without the product server repository.

Changes accepted in the public repository should first be incorporated into the appropriate source directory above, then exported back to the standalone snapshot. Shared-helper changes belong in `api/src/app-sdk`; SDK-only changes belong in `packages/app-sdk`. This keeps the public and product copies on the same implementation.

The sync script refreshes shared helpers only; it does not synchronize Git repositories. For a release, refresh the shared helpers, run SDK tests and type checks, and export the SDK sources plus the generated helper snapshot and lockfile to the public repository. Build and package that standalone snapshot for the versioned GitHub Release.
