# App development

[SDK overview](../README.md)

Build Moben Markdown apps that run on your own computer or server. Devices reach them through the Moben cloud; the app connects out over WebSocket and needs no public address or open port.

## Create and run an app

After installing the SDK using the [README instructions](../README.md#install), run the following from the directory containing the downloaded archive:

```sh
npx moben app init my-app
cd my-app
npm install ../moben-ai-app-sdk-0.7.0.tgz
npx moben login
npm run check
npm run dev
```

Installing the archive in the generated project supplies version 0.7.0 while the npm release is pending. Once that version is available on npm, the generated dependency can be installed with `npm install`.

## JavaScript / TypeScript

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

Pages, actions, tools and Action Sheets follow the same contract as official Moben apps. Throw `AppRequestError(status, message)` to show a message to the user. All pages stream by default; strings are one chunk and generators may keep yielding. Apps can also take voice input: a page can send what the user says to the app, as recognized text or as the recording itself ([remote app protocol](../REMOTE_APPS.md), section 9).

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

## Voice streams

Text voice routes deliver final text only through the existing `voice.start/end`: `await speech.done` and the one-value `speech.transcripts` iterator remain compatible. Device live transcription is independent. If the API connection closes during audio input, the SDK ends `chunks` and resolves `done` with `complete: false` so your handler can save received audio; explicit cancellation still aborts, and there is no automatic recording reconnect, acknowledgement or replay.

## Protocol and examples

See the [remote app protocol](../REMOTE_APPS.md) for the wire contract and limits, including page design, storage and tool results. The [machine example](../examples/machine) is a minimal app with English/Chinese output and an AGENTS.md for coding agents.
