import { EventEmitter } from 'events'
import makeWASocket from '../Socket/index.js'
import type { UserFacingSocketConfig } from '../Types'
import { DisconnectReason } from '../Types'
import type { Boom } from '@hapi/boom'
import { useMultiFileAuthState } from './use-multi-file-auth-state.js'
import type { ILogger } from './logger'

export type SessionStatus =
	| 'initializing'
	| 'qr_ready'
	| 'connected'
	| 'disconnected'
	| 'logged_out'

export type SessionInfo = {
	id: string
	status: SessionStatus
	qr?: string
	phoneNumber?: string
	name?: string
	connectedAt?: Date
	error?: string
}

export type SessionEvents = {
	'session.created': [id: string]
	'session.status': [info: SessionInfo]
	'session.qr': [id: string, qr: string]
	'session.connected': [id: string, phoneNumber: string]
	'session.disconnected': [id: string, reason: string]
	'session.destroyed': [id: string]
	'message.received': [sessionId: string, msg: import('../Types').WAMessage]
}

type WASocket = ReturnType<typeof makeWASocket>

type ActiveSession = {
	info: SessionInfo
	sock: WASocket
	saveCreds: () => Promise<void>
}

export type SessionManagerConfig = {
	authDir?: string
	socketConfig?: Partial<UserFacingSocketConfig>
	autoReconnect?: boolean
	maxReconnectAttempts?: number
	reconnectDelayMs?: number
	onMessage?: (sessionId: string, msg: import('../Types').WAMessage) => void | Promise<void>
}

export class SessionManager extends EventEmitter {
	private sessions = new Map<string, ActiveSession>()
	private reconnectAttempts = new Map<string, number>()
	private config: Required<Omit<SessionManagerConfig, 'socketConfig' | 'onMessage'>> &
		Pick<SessionManagerConfig, 'socketConfig' | 'onMessage'>
	private logger?: ILogger

	constructor(config: SessionManagerConfig = {}, logger?: ILogger) {
		super()
		this.config = {
			authDir: config.authDir ?? './sessions',
			autoReconnect: config.autoReconnect ?? true,
			maxReconnectAttempts: config.maxReconnectAttempts ?? 5,
			reconnectDelayMs: config.reconnectDelayMs ?? 3000,
			socketConfig: config.socketConfig,
			onMessage: config.onMessage
		}
		this.logger = logger
	}

	async createSession(id: string): Promise<SessionInfo> {
		if (this.sessions.has(id)) {
			throw new Error(`Session already exists: ${id}`)
		}

		this.logger?.info({ id }, 'Creating session')
		const info: SessionInfo = { id, status: 'initializing' }
		this._updateStatus(id, info)

		await this._boot(id)
		return this.getInfo(id)!
	}

	async destroySession(id: string): Promise<void> {
		const session = this.sessions.get(id)
		if (!session) throw new Error(`Session not found: ${id}`)

		session.sock.ws.close()
		this.sessions.delete(id)
		this.reconnectAttempts.delete(id)
		this.emit('session.destroyed', id)
		this.logger?.info({ id }, 'Session destroyed')
	}

	getInfo(id: string): SessionInfo | undefined {
		return this.sessions.get(id)?.info
	}

	getSocket(id: string): WASocket | undefined {
		return this.sessions.get(id)?.sock
	}

	listSessions(): SessionInfo[] {
		return Array.from(this.sessions.values()).map(s => s.info)
	}

	hasSession(id: string): boolean {
		return this.sessions.has(id)
	}

	async waitForConnected(id: string, timeoutMs = 60_000): Promise<SessionInfo> {
		const info = this.getInfo(id)
		if (info?.status === 'connected') return info

		return new Promise((resolve, reject) => {
			const cleanup = () => {
				this.off('session.connected', onConnected as any)
				this.off('session.status', onStatus as any)
			}

			const timer = setTimeout(() => {
				cleanup()
				reject(new Error(`Session ${id} did not connect within ${timeoutMs}ms`))
			}, timeoutMs)

			const onConnected = (connectedId: string) => {
				if (connectedId !== id) return
				clearTimeout(timer)
				cleanup()
				resolve(this.getInfo(id)!)
			}

			const onStatus = (info: SessionInfo) => {
				if (info.id !== id) return
				if (info.status === 'logged_out') {
					clearTimeout(timer)
					cleanup()
					reject(new Error(`Session ${id} was logged out`))
				}
			}

			this.on('session.connected', onConnected as any)
			this.on('session.status', onStatus as any)
		})
	}

	private async _boot(id: string): Promise<void> {
		const authFolder = `${this.config.authDir}/${id}`
		const { state, saveCreds } = await useMultiFileAuthState(authFolder)

		const sock = makeWASocket({
			auth: state,
			...(this.config.socketConfig ?? {}),
			logger: this.logger as any
		})

		const info: SessionInfo = this.sessions.get(id)?.info ?? { id, status: 'initializing' }
		this.sessions.set(id, { info, sock, saveCreds })

		sock.ev.on('creds.update', saveCreds)

		sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
			if (qr) {
				info.qr = qr
				info.status = 'qr_ready'
				this._updateStatus(id, info)
				this.emit('session.qr', id, qr)
				this.logger?.info({ id }, 'QR ready')
			}

			if (connection === 'open') {
				info.qr = undefined
				info.status = 'connected'
				info.connectedAt = new Date()
				info.phoneNumber = sock.user?.id?.split(':')[0]
				info.name = sock.user?.name
				info.error = undefined
				this.reconnectAttempts.set(id, 0)
				this._updateStatus(id, info)
				this.emit('session.connected', id, info.phoneNumber ?? '')
				this.logger?.info({ id, phone: info.phoneNumber }, 'Session connected')
			}

			if (connection === 'close') {
				const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode
				const loggedOut = statusCode === DisconnectReason.loggedOut

				if (loggedOut) {
					info.status = 'logged_out'
					info.error = 'Logged out'
					this._updateStatus(id, info)
					this.emit('session.disconnected', id, 'logged_out')
					this.logger?.warn({ id }, 'Session logged out')
					return
				}

				info.status = 'disconnected'
				info.error = (lastDisconnect?.error as Error)?.message
				this._updateStatus(id, info)
				this.emit('session.disconnected', id, info.error ?? 'unknown')

				if (this.config.autoReconnect && this.sessions.has(id)) {
					const attempts = (this.reconnectAttempts.get(id) ?? 0) + 1
					this.reconnectAttempts.set(id, attempts)

					if (attempts <= this.config.maxReconnectAttempts) {
						const delay = this.config.reconnectDelayMs * Math.pow(1.5, attempts - 1)
						this.logger?.info({ id, attempts, delay }, 'Reconnecting session')
						setTimeout(() => this._boot(id), delay)
					} else {
						this.logger?.error({ id }, 'Max reconnect attempts reached')
					}
				}
			}
		})

		sock.ev.on('messages.upsert', ({ messages, type }) => {
			if (type !== 'notify') return
			for (const msg of messages) {
				if (msg.key.fromMe) continue
				this.emit('message.received', id, msg)
				this.config.onMessage?.(id, msg)
			}
		})
	}

	private _updateStatus(id: string, info: SessionInfo): void {
		const session = this.sessions.get(id)
		if (session) session.info = info
		this.emit('session.status', { ...info })
	}
}
