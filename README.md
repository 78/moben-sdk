# Moben SDK

Build Moben Markdown apps and debug devices over USB with `@moben-ai/app-sdk`.
Requires Node.js 20.12 or newer.

## Install

Version **0.7.0** is available through [GitHub Releases](https://github.com/78/moben-sdk/releases/tag/v0.7.0); npm publication is pending.

```sh
gh release download v0.7.0 --repo 78/moben-sdk --pattern 'moben-ai-app-sdk-0.7.0.tgz'
npm install ./moben-ai-app-sdk-0.7.0.tgz
```

## Build an app

Create a project with page, action, tool and voice support:

```sh
npx moben app init my-app
```

Follow the [App development guide](docs/APP_DEVELOPMENT.md) to install dependencies, sign in and run it.

## Debug a device

Connect a USB data cable to this computer and turn the device's **Low power mode OFF**.

```sh
npx moben device doctor
npx moben device screenshot --output screen.png
```

See the [USB debugging guide](docs/USB_DEBUG.md) for port selection, commands and the JS/TS API.

## Documentation

- [App development](docs/APP_DEVELOPMENT.md): APIs, commands, login, localization and voice.
- [USB debugging](docs/USB_DEBUG.md): setup, diagnostics, snapshots, logs and verification.
- [Remote app protocol](REMOTE_APPS.md): device contracts and limits.
- [Development and maintenance](docs/DEVELOPMENT.md): module boundaries, shared sources and releases.
- [Machine example](examples/machine): a working app in English and Chinese.
