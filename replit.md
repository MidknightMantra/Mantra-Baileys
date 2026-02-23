# Baileys - WhatsApp Web Library (Forked & Enhanced)

## Overview

Baileys is a TypeScript/Node.js library (v7.0.0-rc.9) for interacting with WhatsApp Web via WebSockets. This is a custom fork of WhiskeySockets/Baileys with new features added on top.

## Project Structure

- `src/` - TypeScript source code (library core)
- `lib/` - Compiled JavaScript output (build artifact)
- `Example/example.ts` - Example script demonstrating library usage
- `WAProto/` - WhatsApp protobuf definitions
- `Media/` - Sample media files for testing

## Tech Stack

- **Language**: TypeScript
- **Runtime**: Node.js >= 20
- **Package Manager**: npm
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

---

## Custom Features Added

### 1. Message Scheduling (`src/Utils/scheduler.ts`)
Schedule messages to be sent in the future or on a recurring basis.

```ts
import { MessageScheduler } from 'baileys'

const scheduler = new MessageScheduler(sock.sendMessage)

// Send once after 1 hour
scheduler.scheduleIn('1234567890@s.whatsapp.net', { text: 'Good morning!' }, 60 * 60 * 1000)

// Send daily at 9am
scheduler.scheduleRecurring('jid@s.whatsapp.net', { text: 'Daily reminder!' }, {
  type: 'daily', hour: 9, minute: 0
})

// Cancel a scheduled message
scheduler.cancel(id)
```

### 2. Auto-Reply Bot Framework (`src/Utils/auto-reply.ts`)
Configurable keyword-triggered auto-reply system.

```ts
import { AutoReplyManager } from 'baileys'

const bot = new AutoReplyManager(
  (jid, content, quoted) => sock.sendMessage(jid, content, { quoted }),
  (jid, typing) => sock.sendPresenceUpdate(typing ? 'composing' : 'paused', jid)
)

bot.addRule({
  id: 'hello',
  trigger: { type: 'contains', value: 'hello' },
  condition: { cooldownMs: 5000 },
  action: { reply: { text: 'Hi there! 👋' }, typing: true, typingDelayMs: 1000 }
})

// In your message handler:
sock.ev.on('messages.upsert', async ({ messages }) => {
  for (const msg of messages) await bot.process(msg)
})
```

### 3. Broadcast List Manager (`src/Utils/broadcast-list.ts`)
Send messages to multiple contacts with progress tracking.

```ts
import { BroadcastListManager } from 'baileys'

const bcast = new BroadcastListManager(sock.sendMessage)

const list = bcast.createList('VIP Customers', [
  { jid: '1234@s.whatsapp.net', alias: 'Alice' },
  { jid: '5678@s.whatsapp.net', alias: 'Bob' }
])

const results = await bcast.broadcast(list.id, { text: 'Big announcement!' }, {
  delayBetweenMs: 1000,
  onProgress: (result, done, total) => console.log(`${done}/${total}`)
})
```

### 4. New Socket Methods (on `sock`)

#### Message Helpers
- `sock.sendReaction(jid, key, emoji)` — Send a reaction emoji to a message
- `sock.removeReaction(jid, key)` — Remove your reaction from a message
- `sock.forwardMessages(jid, messages)` — Forward multiple messages to a JID
- `sock.sendAlbumMessage(jid, mediaList)` — Send multiple images/videos sequentially
- `sock.sendTyping(jid, durationMs?)` — Show typing indicator (optional auto-stop)
- `sock.sendStatusStory(content, statusJidList?)` — Post a WhatsApp story/status
- `sock.pinMessage(jid, key, time?)` — Pin a message (default: 7 days)
- `sock.unpinMessage(jid, key)` — Unpin a message

#### Group Helpers (new)
- `sock.groupGetInviteLink(jid)` — Returns full `https://chat.whatsapp.com/...` link
- `sock.groupBulkParticipantsUpdate(jid, participants, action, onProgress?)` — Bulk add/remove/promote/demote with per-user results
- `sock.groupGetAllAdmins(jid)` — Returns list of all admin participants

#### Existing (unchanged from upstream)
- All original Baileys methods remain: `sendMessage`, `groupCreate`, `groupLeave`, `groupParticipantsUpdate`, `chatModify`, `newsletterCreate`, etc.
