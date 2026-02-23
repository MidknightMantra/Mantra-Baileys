/**
 * Full-featured bot example demonstrating all custom utilities:
 *   - RateLimitedQueue  (anti-ban message queuing)
 *   - FlowManager       (multi-step conversation flows)
 *   - AutoReplyManager  (keyword-based auto-replies)
 *   - MessageScheduler  (timed/recurring messages)
 *   - BroadcastListManager (bulk messaging)
 *   - WebhookBridge     (HTTP event forwarding)
 */

import makeWASocket, {
        AutoReplyManager,
        DisconnectReason,
        FlowManager,
        RateLimitedQueue,
        fetchLatestBaileysVersion,
        useMultiFileAuthState
} from '../src'
import { Boom } from '@hapi/boom'
import P from 'pino'
import type { AnyMessageContent } from '../src/Types'

const logger = P({ level: 'warn' })

const startBot = async () => {
        const { state, saveCreds } = await useMultiFileAuthState('bot_auth_info')
        const { version } = await fetchLatestBaileysVersion()

        const sock = makeWASocket({
                version,
                auth: state,
                logger: logger.child({ class: 'baileys' }) as any,
                printQRInTerminal: true,
                generateHighQualityLinkPreview: false
        })

        sock.ev.on('creds.update', saveCreds)

        // ─── 1. Rate-limited queue ──────────────────────────────────────────────────
        // All outgoing messages go through this to avoid WhatsApp bans.
        const queue = new RateLimitedQueue(
                {
                        messagesPerMinute: 15,
                        messagesPerDay: 300,
                        minDelayMs: 1000,
                        maxDelayMs: 3500,
                        jitterMs: 500,
                        onDailyLimitReached: jid => {
                                console.warn(`[Rate Limiter] Daily limit hit, blocked message to ${jid}`)
                        }
                },
                logger as any
        )

        // Wrap sendMessage through the queue so every send is rate-limited
        const safeSend = (jid: string, content: AnyMessageContent, options?: any) =>
                queue.enqueue(jid, () => sock.sendMessage(jid, content, options))

        // ─── 2. Conversation flow ───────────────────────────────────────────────────
        type OrderState = { name?: string; item?: string; qty?: number }

        const flows = new FlowManager<OrderState>(
                (jid, content, quoted) => safeSend(jid, content as AnyMessageContent, quoted ? { quoted } : {})
        )

        flows.registerFlow({
                id: 'order',
                initialStep: 'ask_name',
                initialState: {},
                timeoutMs: 5 * 60 * 1000, // 5-minute session timeout
                onTimeout: ctx => console.log(`[Flow] Session timed out for ${ctx.jid}`),
                onEnd: ctx => console.log(`[Flow] Order complete:`, ctx.state),
                steps: {
                        ask_name: {
                                onEnter: () => ({
                                        send: { text: 'Welcome! What is your name?' }
                                }),
                                onMessage: ctx => ({
                                        setState: { name: ctx.text ?? 'Guest' },
                                        send: { text: `Nice to meet you, ${ctx.text}! What would you like to order?` },
                                        next: 'ask_item'
                                })
                        },
                        ask_item: {
                                onMessage: ctx => ({
                                        setState: { item: ctx.text ?? 'Unknown' },
                                        send: { text: `Great choice! How many would you like?` },
                                        next: 'ask_qty'
                                })
                        },
                        ask_qty: {
                                onMessage: ctx => ({
                                        setState: { qty: parseInt(ctx.text ?? '1') || 1 },
                                        send: ctx2 => ({
                                                text: `✅ Order confirmed!\n\nName: ${ctx2.state.name}\nItem: ${ctx2.state.item}\nQty: ${ctx2.state.qty}`
                                        }),
                                        end: true
                                })
                        }
                }
        })

        // ─── 3. Auto-reply rules ────────────────────────────────────────────────────
        const bot = new AutoReplyManager<AnyMessageContent>(
                (jid, content, quoted) => safeSend(jid, content as AnyMessageContent, { quoted }) as any,
                async (jid, typing) => sock.sendPresenceUpdate(typing ? 'composing' : 'paused', jid)
        )

        bot
                .addRule({
                        id: 'hi',
                        trigger: { type: 'regex', value: /^(hi|hey|hello|hola|salut)$/i },
                        condition: { cooldownMs: 10_000, onlyInDMs: true },
                        action: {
                                reply: { text: '👋 Hey! Type *order* to start an order, or *help* for commands.' },
                                typing: true,
                                typingDelayMs: 800
                        }
                })
                .addRule({
                        id: 'help',
                        trigger: { type: 'exact', value: 'help', caseSensitive: false },
                        action: {
                                reply: {
                                        text: '*Available commands:*\n\n• order – Start an order\n• status – Check queue stats\n• ping – Test response'
                                }
                        }
                })
                .addRule({
                        id: 'ping',
                        trigger: { type: 'exact', value: 'ping', caseSensitive: false },
                        action: { reply: { text: '🏓 Pong! Bot is alive.' } }
                })
                .addRule({
                        id: 'status',
                        trigger: { type: 'exact', value: 'status', caseSensitive: false },
                        action: {
                                reply: msg => {
                                        const stats = queue.stats
                                        return {
                                                text: `📊 *Queue Stats*\n\nSent today: ${stats.sentToday}/${stats.rateLimitPerDay}\nSent this minute: ${stats.sentThisMinute}/${stats.rateLimitPerMinute}\nQueue depth: ${stats.queueDepth}`
                                        }
                                }
                        }
                })

        // ─── 4. Webhook bridge ──────────────────────────────────────────────────────
        // Uncomment and set your URL to forward events to an HTTP endpoint
        // const webhook = new WebhookBridge(logger as any)
        // webhook.addEndpoint('main', {
        //      url: 'https://your-server.com/webhook',
        //      secret: 'your-secret-key',
        //      events: ['messages.upsert', 'messages.update', 'group-participants.update']
        // })
        // webhook.attach(sock.ev)

        // ─── 5. Scheduler example ──────────────────────────────────────────────────
        // Uncomment to send a test message 30 seconds after startup
        // const scheduler = new MessageScheduler(
        //      (jid, content) => safeSend(jid, content as AnyMessageContent),
        //      logger as any
        // )
        // scheduler.scheduleIn('1234567890@s.whatsapp.net', { text: '⏰ Scheduled message!' }, 30_000)

        // ─── 6. Broadcast example ──────────────────────────────────────────────────
        // const bcast = new BroadcastListManager(
        //      (jid, content) => safeSend(jid, content as AnyMessageContent) as any
        // )
        // const list = bcast.createList('Team', [{ jid: 'jid1@s.whatsapp.net' }, { jid: 'jid2@s.whatsapp.net' }])
        // await bcast.broadcast(list.id, { text: '📢 Team announcement!' })

        // ─── Message handler ────────────────────────────────────────────────────────
        sock.ev.on('messages.upsert', async ({ messages, type }) => {
                if (type !== 'notify') return

                for (const msg of messages) {
                        if (!msg.message || msg.key.fromMe) continue

                        const jid = msg.key.remoteJid!
                        const text =
                                msg.message.conversation ??
                                msg.message.extendedTextMessage?.text ??
                                ''

                        // 1. If user is in a flow, route to flow
                        if (flows.hasActiveSession(jid)) {
                                const handled = await flows.process(msg)
                                if (handled) continue
                        }

                        // 2. Start order flow on keyword
                        if (text.toLowerCase() === 'order') {
                                await flows.startFlow('order', jid, msg)
                                continue
                        }

                        // 3. Auto-reply rules
                        await bot.process(msg)
                }
        })

        // ─── Connection handling ────────────────────────────────────────────────────
        sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
                if (connection === 'close') {
                        const shouldReconnect = (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut
                        console.log('Connection closed. Reconnecting:', shouldReconnect)
                        if (shouldReconnect) startBot()
                } else if (connection === 'open') {
                        console.log('✅ Bot connected to WhatsApp!')
                        console.log(`Queue stats:`, queue.stats)
                }
        })

        return sock
}

startBot().catch(console.error)
