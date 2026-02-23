import { SessionManager } from '../src/Utils/session-manager.js'
import { ApiServer } from '../src/Server/api.js'
import pino from 'pino'

const logger = pino({ level: process.env['LOG_LEVEL'] ?? 'info' })

const port = Number(process.env['PORT'] ?? 3000)
const host = process.env['HOST'] ?? 'localhost'
const apiKey = process.env['API_KEY'] ?? ''

const manager = new SessionManager(
	{
		authDir: './sessions',
		autoReconnect: true,
		maxReconnectAttempts: 5,
		reconnectDelayMs: 3000,
		onMessage: (sessionId, msg) => {
			const text =
				msg.message?.conversation ??
				msg.message?.extendedTextMessage?.text ??
				'(non-text)'
			logger.info({ sessionId, from: msg.key.remoteJid, text }, 'Message received')
		}
	},
	logger as any
)

manager.on('session.status', info => {
	logger.info({ id: info.id, status: info.status }, 'Session status changed')
})

manager.on('session.qr', (id, qr) => {
	logger.info({ id }, 'QR code ready — call GET /sessions/:id to view status + QR string')
	logger.info({ qr }, 'QR string (paste into a QR generator to scan)')
})

manager.on('session.connected', (id, phone) => {
	logger.info({ id, phone }, 'WhatsApp session connected')
})

manager.on('session.disconnected', (id, reason) => {
	logger.warn({ id, reason }, 'Session disconnected')
})

const api = new ApiServer(manager, { port, host, apiKey }, logger as any)

api.start().then(() => {
	logger.info({ port, host }, `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Baileys REST API running
  http://${host}:${port}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Quick start:
    1. POST /sessions         { "id": "my-bot" }
    2. GET  /sessions/my-bot  (get QR + status)
    3. Scan QR with WhatsApp
    4. POST /sessions/my-bot/messages/text
       { "jid": "15551234567@s.whatsapp.net", "text": "Hello!" }
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
})

process.on('SIGINT', async () => {
	logger.info('Shutting down…')
	await api.stop()
	process.exit(0)
})
