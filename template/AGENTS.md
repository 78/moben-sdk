# AGENTS.md: building a Moben remote app

This directory is a Moben remote app created by `moben app init`. The app runs on the user's own computer; Moben devices open its pages through the cloud and the voice assistant can call its tools. The starter is a small notes app: replace it with what the user asks for, keeping the structure. The protocol is described in `node_modules/@moben-ai/app-sdk/REMOTE_APPS.md`.

## Develop and test locally

Requires Node.js 20.12 or newer. Check the operating system and current shell before running commands; adapt paths and environment variables to PowerShell/cmd on Windows or the shell on macOS/Linux. Do not assume Bash, Unix utilities or WSL. Prefer built-in Node APIs for portable app code.

These commands run your code locally without connecting, using the same checks as the cloud. Run them after every change and fix all errors and warnings before asking the user to try the app on a device.

- `npx moben app validate` checks the manifest and renders every page without parameters in English and Chinese. Pages with parameters are listed as skipped: render each of them yourself.
- `npx moben app page /path` prints each validated part as it arrives; Ctrl+C stops a long page. Warnings on stderr (or `issues` with `--json`) say which links or images were removed and why.
- `npx moben app action /notes/abc/delete --page /` runs an action as if its link was selected on that page and prints the page it returns. Pass the page that shows the link; the CLI warns when the link or the returned `initialFocus` is missing.
- `npx moben app voice /notes/voice --text "Buy milk" --page /` records into a voice route as if the user spoke on that page and prints the result; use `--file memo.ogg` for an audio route.
- `npx moben app tool add_note --args '{"text":"Buy milk"}'` calls a tool and prints its result and UI effects. On Windows, cmd and PowerShell 5.1 change the quotes: write UTF-8 JSON to a file and pass `--args "@args.json"`, or pipe it with `--args -`.
- Add `--locale zh-CN` to see the Chinese version, `--timezone America/New_York` to test dates in another time zone, and `--json` for machine-readable output. Exit code 0 means success.

## Run on a device

1. Run `npx moben whoami`. If it says "Not logged in", run `npx moben login` and show the user the link it prints: they open it on any computer or phone, sign in to Moben and approve. The command waits up to 10 minutes and saves a developer key for this computer, which every app on it uses. Never ask the user to paste a key into the chat or into code.
2. Run `npm run dev`. It connects and restarts when files change. When `[app] online` appears, open the app from the app list on the device. The app appears in Console the first time it connects.

On a server, run `npx moben login` once as the user that runs the app; over SSH it only prints the link. In containers or CI, securely set `MOBEN_DEVELOPER_KEY` from the `key` field of the credentials saved on the authorized computer. The default file is `%APPDATA%\moben\credentials.json` on Windows or `~/.config/moben/credentials.json` on macOS/Linux. `MOBEN_CONFIG_DIR` overrides the directory; macOS/Linux also respect `XDG_CONFIG_HOME`. Use the path reported by `moben login`/`moben whoami`. Set environment variables using the current shell: `$env:NAME = "value"` in PowerShell, `set "NAME=value"` in cmd, or `export NAME="value"` in Bash. Never print credentials or include them in chat or source code.

## Inspect a USB-connected device

Run USB commands on the computer connected to the device, not on a remote app server. Ask the user to turn Advanced settings → Low power mode OFF and connect a data cable if the endpoint is unavailable. Close other serial monitors. No Moben login, Python or ESP-IDF is needed for USB operations; Windows 7 is unsupported.

- `npx moben device list --json` enumerates ports without opening them. A candidate USB ID is not confirmation that the device is Moben.
- `npx moben device doctor --port <port> --json` checks the brand handshake and actual power settings. Old PSG1 firmware remains usable but reports unconfirmed brand; do not claim it is fully verified.
- `npx moben device open /apps/<actual-app-id>/ --port <port> --json` asks the device to load a page. Use the actual URL from your app, not its local manifest ID. The app process must be online and the device still uses cloud authorization.
- `npx moben device key next --port <port> --json` injects one application gesture. `voice` confirms/selects, `prev`/`next` navigate, and `menu` returns. Do not replay failed/timed-out UI commands automatically: they may already have executed.
- `npx moben device screenshot --output screen.png --port <port> --json` saves the latest panel framebuffer; use `--format l8` for antialiased GUI grayscale. Inspect the image and frame metadata. An open/key acknowledgement does not mean the page is loaded or the physical refresh is complete; capture again after loading when necessary. Framebuffers cannot show screen ghosting.
- `npx moben device snapshot --port <port> --output page.json --json` exports the full currently loaded Browser Markdown, all-screen text, visible text, every link, mode, focus and loading/frame metadata. Inspect `focusedLinkIndex` for repeated URLs; never assume a read-mode page is in selection mode. `browser: null` means no active rendered Browser document; inactive retained history is not opened. This query does not navigate, render or refresh. Large snapshots can use `--timeout 30`; allocation/size failures are explicit, never silently truncated exports.
- `npx moben device text "Test phrase" --port <port> --json` replaces ASR for one normal voice flow. It requires the server's test-device allowlist, accepts at most 72 UTF-8 bytes, briefly records and can invoke real app tools. Use intentional test input; it is not a microphone/ASR accuracy test, and success only acknowledges submission.
- `npx moben device logs --port <port> --output serial.log` follows live logs until Ctrl-C; `--json` emits NDJSON. It occupies the serial port. To inspect screenshots/pages or send commands while collecting logs, use a single `connectDevice({ onLog })` client. The device has no added historical log buffer.
- Distinguish no candidate port, inability to open, handshake timeout and brand mismatch. A missing driver or low power mode is only a possible cause until verified. If the optional native dependency is unavailable, run `npm install serialport@^13` in the app.

See the SDK README for `connectDevice()` / `listDevices()` JS/TS usage. Always close persistent connections in `finally`.

## App structure

`defineApp({ manifest, pages, actions, tools })`:

- `manifest.id` is your own ID for the app, unique within your account: 2–31 lowercase letters, digits or hyphens, such as `computer-status`. Give each new app a new ID; changing it registers a different app. `entry` points to the home route.
- `pages`: route → function returning Markdown. Start with `page(ctx, { title })` for the metadata line, then build the body with `heading`, `paragraph`, `list` and `raw`. Pages that should update themselves add `refresh: { intervalSeconds: 60 }` (at least 30 seconds). Content that keeps growing, such as a log, can be an `async function*` page that yields text as it arrives, with `interaction: { autoPage: false }`; see "Streaming pages" in `REMOTE_APPS.md`.
- `actions`: route → run the operation, then return `ctx.renderCurrentPage()` or `ctx.renderPage('/path')`. Create buttons with `md.action(label, ctx.url('/path'), { confirm: 'Are you sure?' })`.
- `tools`: name → `(ctx, args) => ({ result, uiEffects? })`. Tools that change data declare `mutates: true` and return `uiEffects: [{ type: 'reload' }]` to refresh the device's current page.
- `voice` (optional): route → `{ input: 'text' | 'audio', handler }`. A page that declares `voice: { mode: 'capture', url: ctx.url('/notes/voice') }` sends what the user says to that route instead of the assistant: recognized text, or the recording itself. See "Voice input" in `REMOTE_APPS.md`. Without it, holding the voice key opens the assistant, which calls your tools.
- Routes start with `/`; `:name` matches one path segment and is read from `ctx.params.name`. Query parameters are in `ctx.query`.

## Design for the e-ink screen

Read sections 9 and 10 of `REMOTE_APPS.md` before designing pages. In short:

- A line holds about 16 Chinese characters or 30 Latin characters, and a screen about 15 lines. Refreshes are slow, so keep pages short and put what matters on the first screen.
- Supported Markdown: headings, paragraphs, bold, italic, inline code, code blocks, quotes, unordered lists, rules, links, and inline `data:image/png;base64` images. Tables become lists, ordered lists show as plain text, and HTML is not supported. Symbols such as ✓ and emoji render in black and white.
- Links are the only selectable elements and each costs a key press, so keep them few and put the main ones first. Use Action Sheets for per-item menus.
- The feedback for an action is the page it returns, with the changed item updated in place. Do not add banners. Return `ctx.renderCurrentPage({ initialFocus })` to keep the focus on the item after the one just handled.

## Languages

- English is the default. Devices set to Chinese should see Chinese, so every user-visible string goes through `createAppTranslator({ en, 'zh-CN' })` and is looked up with `text(ctx, key, values)`. Missing Chinese keys fall back to English.
- The launcher name, description, welcome text and tool titles are localized in `manifest.locales['zh-CN']`; the top-level manifest fields stay in English.
- Compute "today" and format dates and times with the device's `ctx.timezone` and language, not the computer's.
- Write `agent.instructions`, tool descriptions and tool results in English. Tool results should be plain data; the assistant answers in the user's language. Messages of `AppRequestError` thrown from pages and actions are shown to the user, so translate them.
- The translator has no plural rules: use separate keys such as `days_one` and `days_other`.

## Rules

- Always build in-app links with `ctx.url('/path')`, for example `md.link('Details', ctx.url('/detail'))`. Links to external websites are not allowed, and external images are removed.
- Escape user-visible text with `md.text()`. `heading` and `paragraph` escape for you; `list` and `raw` insert text verbatim. Do not write HTML.
- Name tools verb first after what they do, with lowercase letters, digits and underscores, such as `add_note` or `get_computer_status`, give each a short `title`, and say in the description what the tool returns and when to use it. The assistant picks tools by name and description, so vague names such as `info` are called less reliably. `inputSchema` is a JSON Schema with `type: "object"`.
- Tools that should also work in regular conversations set `external: true` and come with a clear `agent.externalInstructions`.
- `permissions` may only be `[]` or `['location']`.
- Keep data on the user's machine in `data/` next to `app.ts`, resolved from `__dirname` as the starter does: a JSON file written atomically for a few records, or SQLite (`node:sqlite`, Node 22.13 and newer) for structured or growing data.
- For errors the user should see, `throw new AppRequestError(404, 'Not found')`. Allowed statuses are 400, 403, 404, 409, 410, 422 and 429. Any other exception shows a generic error, with details in the local log.
- In tools, return "nothing matched" as data together with the valid choices, for example `{ found: false, notes: [...] }`, so the assistant can ask a follow-up question. Throw `AppRequestError(400, …)` only for invalid input; the assistant receives its message.
- Pages and actions must respond within 10 seconds (streaming pages: send the first part within 10 seconds) and tools within 15 seconds. Pages are limited to 512 KiB and tool results to 8 KB.
- Prefer built-in Node APIs. If you must run system commands, handle macOS, Linux and Windows separately.
- `ctx.openId` is a stable identifier for this device within your app. Keep each device's records under its `openId`, as the starter does. Device IDs, accounts and phone numbers are never exposed.

## Device checklist

The local commands cannot show the e-ink layout or the assistant's choice of tools, so finish on a device:

- Open the home page and every subpage, with the device language set to both English and Chinese.
- Hold the voice key and ask something that triggers each tool, and check that the answer uses fresh data.
- On pages that capture voice, record once normally, once locked with the right key, and cancel once with the left key.
- Stop the process: the app shows as offline on the device. After restarting, the page recovers within 30 seconds.

All pages stream by default with SDK 0.6 and current device protocol 2. A string is one chunk; async generators can keep yielding. Do not set `stream` or `interaction.follow`. Only the first chunk has the page deadline; always honor `ctx.signal`. Auto-page is a separate `interaction.autoPage` policy.
