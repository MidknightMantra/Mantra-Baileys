# Baileys - WhatsApp Web Library

## Overview

Baileys is a TypeScript/Node.js library (v7.0.0-rc.9) for interacting with WhatsApp Web via WebSockets. It is **not a web application** — it is an SDK/library that developers use to build WhatsApp bots and automation tools.

## Project Structure

- `src/` - TypeScript source code (library core)
- `lib/` - Compiled JavaScript output (build artifact)
- `Example/example.ts` - Example script demonstrating library usage
- `WAProto/` - WhatsApp protobuf definitions
- `Media/` - Sample media files for testing

## Tech Stack

- **Language**: TypeScript
- **Runtime**: Node.js >= 20
- **Package Manager**: npm (yarn 4.x defined in package.json but npm used for install)
- **Build**: `tsc` with `tsc-esm-fix` for ESM output
- **Key Dependencies**: ws (WebSockets), pino (logging), protobufjs, libsignal

## Workflow

- **Start application**: `npm run example` — runs the example WhatsApp connection script (console output)
  - Connects to WhatsApp Web, shows a QR code in the logs for device pairing

## Build

```bash
npm run build
```

Compiles TypeScript from `src/` to `lib/`.

## Development Notes

- The example script requires scanning a QR code with WhatsApp to authenticate
- Auth state is persisted in `baileys_auth_info/` directory after first login
- Library supports both QR code and pairing code authentication
