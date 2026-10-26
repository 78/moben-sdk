# USB device debugging

[SDK overview](../README.md)

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

## Opening apps

Use the page URL shown by your running app or `moben app page`; remote apps have their own cloud-assigned ID. USB `open` accepts canonical `/apps/` URLs only (up to 107 ASCII bytes), with no external URLs, `action:` links or fragments. It does not upload or start your app process.

## Discovery and diagnostics

`list` marks Espressif `303a:1001` ports as **candidates**, not confirmed Moben devices. Commands may omit `--port` only when exactly one candidate exists. Metadata can be missing; use `--port` explicitly in that case. An explicit port outside that candidate list is still attempted, but a warning first names the candidate when one exists (`COM1 has no Moben USB ID (VID_303A/PID_1001). The Moben candidate is COM3. Trying it anyway.`), because such a port otherwise only exhausts `--timeout` and reports a generic USB timeout. `HELLO product=moben model=pocket-sage` confirms the product, and `doctor` reports ready only after `STATUS` also confirms `low_power=0 light_sleep=0`. This is product identification, not cryptographic authentication. Legacy PSG1 firmware without product fields remains usable for advertised capabilities, with an unconfirmed-brand warning; `doctor` exits 1 until identity and power settings are verified.

All commands support `--json`. Errors return `{ "ok": false, "error": "...", "code": "..." }`; device rejections also include `deviceCode`. Exit codes: 0 success, 1 connection/protocol/operation failure or unconfirmed doctor result, 2 invalid arguments, 130/143 interrupted. Missing ports, open failures, handshake timeouts and identity mismatches have different codes. Discovery does not independently enumerate USB/PnP devices, so missing drivers are a possible cause, never a confirmed diagnosis. Use `--timeout <seconds>` to change the 8-second per-command deadline (maximum 120 seconds).

`serialport` is an optional dependency loaded only by USB operations. If your install omits optional dependencies or its native addon cannot load, install `serialport@^13` in your app. Cloud apps and account/local app commands do not load it.

## JavaScript / TypeScript

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

## Test text input

`await device.text(message)` submits one device voice flow with replacement ASR text, using the same TEXT/down/long/up sequence as the firmware Python tool. Text must be a nonempty single line of at most **72 UTF-8 bytes**. The cloud must allow this device in `debug.asrTextDevices`; otherwise it rejects the request with 403 on the device. The command briefly records audio and retains normal page context, app authorization, usage and tool execution. It tests the downstream voice/app flow, not microphone or ASR accuracy. Completion acknowledges submission, not the assistant/app reply. The whole gesture sequence holds the SDK request queue; on firmware advertising `text_cancel=1`, cancellation first aborts the recording with `CANCELTEXT`, then releases voice-up; if cancellation fails it does not release and accidentally submit. Firmware advertising `text_clear=1` also clears unused replacement text after a failed/cancelled flow. Older firmware only supports best-effort voice-up cleanup, which may submit a recording; update before relying on cancellation. Cancellation cannot retract audio/text already delivered to a server. Transport loss can prevent cleanup; commands are never replayed.

## Browser snapshots

`await device.snapshot()` requires firmware advertising `snapshot=1`. It returns device state, modal/assistant visibility, current frame metadata and `browser`. Outside an active rendered Browser document, `browser` is `null` (retained, inactive history is not exported). An active Browser snapshot includes:

- `markdown`: the complete **currently loaded** source document, including hidden metadata; `text`: rendered text across every loaded screen, separated by form feeds (`\f`); `visibleText`: the current displayed screen's text.
- App ID, URL, title, revision, navigation/content revision IDs, loading/receiving/completion/truncation flags and `launching`/`pendingUrl` to identify a placeholder or pending navigation.
- Reading/selection `mode`, one-based screen index, loaded screen count and final count (`null` until complete/truncated).
- **All** loaded links, with text, normalized target (or raw URL if invalid), validity, zero-based occurrence index, one-based screen (or `null`) and focus. `focusedLinkIndex` distinguishes repeated links with the same URL. An open Action Sheet includes its items and focused index.

Snapshots only read existing state under the GUI lock: they do not navigate, refresh, render, report progress, select links or rebuild inactive history. Modal/assistant flags describe overlays above the exported Browser page; their own body text is not included. Semantic focus can precede a pending GUI render, so use screenshots/frame metadata to inspect actual submitted pixels. A growing or truncated document is exported as-is, without pretending the server's entire response has arrived.

Firmware measures escaped JSON, then allocates exactly one temporary output buffer: below 4 KiB it uses ordinary heap memory; larger output uses PSRAM and preserves 128 KiB headroom. Rendered text is read from existing layout fragments directly into JSON, without a second full-text buffer. The buffer is released after transmission/failure; no extra task or resident document/log cache is added. Exports over 2 MiB return `snapshot_too_large`, and allocation failure returns `no_memory`, with no partial result silently presented as complete. The SDK validates length, CRC, end marker, UTF-8, JSON and structure before exposing/saving it. For large pages, use `--timeout 30` or a larger `timeoutMs`. `snapshot --output page.json` writes atomically; with `--json`, stdout also includes the full snapshot and output path.

## Live logs

`device.onLog(log => { ... })` subscribes to live ordinary logs on the same connection and returns an unsubscribe function. Pass `onLog` to `connectDevice` to also receive logs during the initial handshake. Entries are `{ line, truncated }`; original text is preserved, partial UTF-8 lines are joined, stale protocol replies are filtered and binary screenshot/snapshot payloads are never treated as logs. An oversized idle line is bounded to 4096 bytes and marked truncated. Callbacks should return quickly; their exceptions are isolated from USB requests. `await device.whenClosed()` resolves with the `DeviceError` explaining closure.

`moben device logs` follows until Ctrl-C and optionally appends to a host file with `--output`. `--json` produces newline-delimited JSON log events. It uses the existing serial stream; firmware logging and kernel output are unchanged, and logs from before connection cannot be recovered. A standalone logs command holds the port exclusively: to capture logs while issuing other commands, use one JS client with an `onLog` callback. CLI output/file errors and excessive stdout backpressure stop log following instead of allocating an unbounded host queue.

## Frames and completion

An `open` acknowledgement means the page request was accepted, and a key acknowledgement means the application processed the event. Neither guarantees a new rendered frame or completed e-ink refresh. Captures are immediate and return `frameId`, `completedFrameId` and `refreshing`; check the image and capture again after loading as needed. Matching completed frame IDs do not prove that a streaming page has finished loading. `panel` (default) captures the most recently submitted monochrome/four-gray frame; `l8` captures the rendered grayscale buffer with antialiasing. Both are framebuffers, not optical readbacks, so they cannot show ghosting or physical contrast. PNG encoding happens on the computer after dimensions, payload, end marker and decoded-pixel CRC have passed. The CLI replaces the destination only after validation and PNG encoding succeed.

## Verification

Hardware verification (2026-10-26): flashed the normal ESP32-S3 firmware (allocation profiling/boot validation OFF) and verified on macOS: Moben identity/power diagnostics; status/tasks; PANEL/L8 captures; launcher/reader navigation; default reading, current-screen selection and retained return focus; complete 1653-link/93-screen export (607477 JSON bytes); JS/CLI text with actual assistant replies; cancellation; log/capture coexistence; interrupted large-snapshot reconnection; and ten repeated port opens without device reset. Fifty small snapshots and five large snapshots showed zero retained SRAM/PSRAM change in the measured runs. Live low-power switching also passed: enabling low power disabled PSG1 and caused a handshake timeout (doctor exit 1), while the Espressif serial candidate remained enumerable; manually disabling low power restored identity/status/tasks/capture and key commands. The device was returned to idle with low power/light sleep OFF. Windows/Linux hardware checks remain pending. Automated SDK tests cover protocol validation, CLI diagnostics, optional-module isolation, safe cancellation and handshake resynchronization.
