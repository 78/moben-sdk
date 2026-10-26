# AGENTS.md: building a Moben remote app

This directory is a minimal Moben remote app, "Computer Status". The app runs on the user's own computer; Moben devices open its pages through the cloud and can ask about the computer's configuration and status in voice chat. It only uses built-in Node modules and works on macOS, Linux and Windows. Use this structure for other apps; the protocol is described in `REMOTE_APPS.md` inside the SDK package.

## Running

1. Install Node.js 20.12 or newer, then run `npm install` in this directory. The SDK `@moben-ai/app-sdk` comes from npm.
2. Run `npx moben login` and open the link it prints: sign in to Moben and approve. The developer key is saved for this computer and every app on it uses it. `npx moben whoami` shows the account and its apps.
3. Run `npm start`. When `[machine] online` appears, open "Computer Status" from the app list on the device. The app appears in Console the first time it connects.

On a server, run `npx moben login` once as the user that runs the app; over SSH it only prints the link. In containers or CI, copy the key from `~/.config/moben/credentials.json` into the `MOBEN_DEVELOPER_KEY` environment variable. Never put a key in code or commit it.

## App structure

`defineApp({ manifest, pages, actions, tools })`:

- `manifest.id` is your own ID for the app, unique within your account: 2–31 lowercase letters, digits or hyphens, such as `computer-status`. Give each new app a new ID; changing it registers a different app. The cloud adds your account's namespace to form the public ID. `entry` points to the home route.
- `pages`: route → function returning Markdown. Start with `page(ctx, { title })` for the metadata line, then build the body with `heading`, `paragraph`, `list` and `raw`. Pages that should update themselves add `refresh: { intervalSeconds: 60 }` (at least 30 seconds).
- `actions` (not used here): route → run the operation, then return `ctx.renderCurrentPage()` or `ctx.renderPage('/path')`. Create buttons with `md.action(label, ctx.url('/path'), { confirm: 'Are you sure?' })`.
- `tools`: name → `(ctx, args) => ({ result, uiEffects? })`. Tools that change data declare `mutates: true` and return `uiEffects: [{ type: 'reload' }]` to refresh the device's current page.
- Routes start with `/`; `:name` matches one path segment and is read from `ctx.params.name`. Query parameters are in `ctx.query`.

## Languages

- English is the default. Devices set to Chinese should see Chinese, so every user-visible string goes through `createAppTranslator({ en, 'zh-CN' })` and is looked up with `text(ctx, key, values)`. Missing Chinese keys fall back to English.
- The launcher name, description, welcome text and tool titles are localized in `manifest.locales['zh-CN']`; the top-level manifest fields stay in English.
- Format dates and times with the device's `ctx.timezone` and language, not the computer's.
- Write `agent.instructions`, tool descriptions and tool results in English. Tool results should be plain data; the assistant answers in the user's language.

## Rules

- Always build in-app links with `ctx.url('/path')`, for example `md.link('Details', ctx.url('/detail'))`. Links to external websites are not allowed, and external images are removed.
- Escape user-visible text with `md.text()`. `heading` and `paragraph` escape for you; `list` and `raw` insert text verbatim. Do not write HTML.
- Before designing pages, read sections 9 and 10 of `REMOTE_APPS.md`: the Markdown the e-ink screen renders, line length, links and focus, action feedback, where to store data, time zones, and how tools report errors.
- Name tools verb first after what they do, with lowercase letters, digits and underscores, such as `get_computer_status` or `add_note`, and say in the description what the tool returns and when to use it. The assistant picks tools by name and description, so vague names such as `info` are called less reliably. It sees them as `app_get_computer_status` and `app_add_note`; the SDK and cloud handle the prefix. `inputSchema` is a JSON Schema with `type: "object"`.
- Tools that should also work in regular conversations set `external: true` and come with a clear `agent.externalInstructions`.
- `permissions` may only be `[]` or `['location']`.
- For errors the user should see, `throw new AppRequestError(404, 'Not found')`. Allowed statuses are 400, 403, 404, 409, 410, 422 and 429. Any other exception shows a generic error, with details in the local log.
- Pages must respond within 6 seconds and tools within 15 seconds. Pages are limited to 512 KiB and tool results to 8 KB.
- Prefer built-in Node APIs. If you must run system commands, handle macOS, Linux and Windows separately.
- `ctx.openId` is a stable identifier for this device within your app. Keep each device's records under its `openId`. Device IDs, accounts and phone numbers are never exposed.

## Self-test checklist

- Before connecting, run `npx moben app validate` and `npx moben app tool get_computer_status`. They run the app locally with the cloud's checks and print the page and tool result; fix every error and warning.
- After starting, the log shows `online`. If the handshake is rejected, fix the manifest according to the issues in the log and restart.
- Open the home page and every subpage on the device and check the content, with the device language set to both English and Chinese.
- Hold the voice key and ask something that triggers each tool (for example "What are my computer's specs?") and check that the answer uses fresh data.
- Stop the process: the app shows as offline on the device and opens an offline notice. After restarting, the page recovers within 30 seconds.

All pages stream by default with SDK 0.6 and current device protocol 2. A string is one chunk; async generators can keep yielding. Do not set `stream` or `interaction.follow`. Only the first chunk has the page deadline; always honor `ctx.signal`. Auto-page is a separate `interaction.autoPage` policy.
