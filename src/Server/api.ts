import * as http from 'http'
import { SessionManager } from '../Utils/session-manager.js'
import type { ILogger } from '../Utils/logger'
import type { AnyMessageContent } from '../Types'

export type ApiServerConfig = {
	port?: number
	host?: string
	apiKey?: string
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RouteHandler = (req: http.IncomingMessage, res: http.ServerResponse, params: any, body: unknown) => Promise<void>

type Route = {
	method: string
	pattern: RegExp
	paramNames: string[]
	handler: RouteHandler
}

export class ApiServer {
	private server: http.Server
	private manager: SessionManager
	private routes: Route[] = []
	private config: Required<ApiServerConfig>
	private logger?: ILogger

	constructor(manager: SessionManager, config: ApiServerConfig = {}, logger?: ILogger) {
		this.manager = manager
		this.config = {
			port: config.port ?? 3000,
			host: config.host ?? 'localhost',
			apiKey: config.apiKey ?? ''
		}
		this.logger = logger
		this.server = http.createServer(this._handleRequest.bind(this))
		this._registerRoutes()
	}

	start(): Promise<void> {
		return new Promise(resolve => {
			this.server.listen(this.config.port, this.config.host, () => {
				this.logger?.info({ port: this.config.port, host: this.config.host }, 'API server started')
				resolve()
			})
		})
	}

	stop(): Promise<void> {
		return new Promise((resolve, reject) => {
			this.server.close(err => (err ? reject(err) : resolve()))
		})
	}

	private _registerRoutes(): void {
		// Sessions
		this._route('GET', '/sessions', this._listSessions.bind(this))
		this._route('POST', '/sessions', this._createSession.bind(this))
		this._route('GET', '/sessions/:id', this._getSession.bind(this))
		this._route('DELETE', '/sessions/:id', this._destroySession.bind(this))

		// Messages
		this._route('POST', '/sessions/:id/messages/text', this._sendText.bind(this))
		this._route('POST', '/sessions/:id/messages/media', this._sendMedia.bind(this))
		this._route('POST', '/sessions/:id/messages/react', this._sendReaction.bind(this))
		this._route('POST', '/sessions/:id/messages/forward', this._forwardMessage.bind(this))
		this._route('POST', '/sessions/:id/messages/delete', this._deleteMessage.bind(this))
		this._route('POST', '/sessions/:id/messages/read', this._markRead.bind(this))
		this._route('POST', '/sessions/:id/messages/pin', this._pinMessage.bind(this))

		// Status / presence
		this._route('POST', '/sessions/:id/presence', this._sendPresence.bind(this))
		this._route('POST', '/sessions/:id/status', this._sendStatusStory.bind(this))

		// Groups
		this._route('POST', '/sessions/:id/groups', this._createGroup.bind(this))
		this._route('GET', '/sessions/:id/groups/:gid', this._getGroupMetadata.bind(this))
		this._route('POST', '/sessions/:id/groups/:gid/participants', this._updateGroupParticipants.bind(this))
		this._route('GET', '/sessions/:id/groups/:gid/invite', this._getGroupInviteLink.bind(this))
		this._route('PUT', '/sessions/:id/groups/:gid/subject', this._updateGroupSubject.bind(this))
		this._route('PUT', '/sessions/:id/groups/:gid/description', this._updateGroupDescription.bind(this))
		this._route('PUT', '/sessions/:id/groups/:gid/settings', this._updateGroupSettings.bind(this))
		this._route('DELETE', '/sessions/:id/groups/:gid/leave', this._leaveGroup.bind(this))

		// Profile & privacy
		this._route('PUT', '/sessions/:id/profile/name', this._updateProfileName.bind(this))
		this._route('PUT', '/sessions/:id/profile/status', this._updateProfileStatus.bind(this))
		this._route('GET', '/sessions/:id/profile/:jid', this._getBusinessProfile.bind(this))

		// Contacts
		this._route('POST', '/sessions/:id/contacts/check', this._checkOnWhatsApp.bind(this))
		this._route('POST', '/sessions/:id/contacts/block', this._blockContact.bind(this))

		// Chats
		this._route('POST', '/sessions/:id/chats/:jid/archive', this._archiveChat.bind(this))
		this._route('POST', '/sessions/:id/chats/:jid/mute', this._muteChat.bind(this))

		// Health
		this._route('GET', '/health', this._health.bind(this))
	}

	private _route(method: string, path: string, handler: RouteHandler): void {
		const paramNames: string[] = []
		const regexStr = path.replace(/:([a-zA-Z]+)/g, (_, name) => {
			paramNames.push(name as string)
			return '([^/]+)'
		})
		this.routes.push({ method, pattern: new RegExp(`^${regexStr}$`), paramNames, handler })
	}

	private async _handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		res.setHeader('Content-Type', 'application/json')
		res.setHeader('X-Powered-By', 'Baileys-API')

		if (this.config.apiKey) {
			const key = (req.headers['x-api-key'] ?? req.headers['authorization']?.replace('Bearer ', '')) as string | undefined
			if (key !== this.config.apiKey) {
				return this._respond(res, 401, { error: 'Unauthorized' })
			}
		}

		const url = (req.url?.split('?')[0]) ?? '/'
		const method = req.method ?? 'GET'

		let body: unknown = {}
		if (['POST', 'PUT', 'PATCH'].includes(method)) {
			body = await this._readBody(req)
		}

		for (const route of this.routes) {
			if (route.method !== method) continue
			const match = url.match(route.pattern)
			if (!match) continue

			const params: Record<string, string> = {}
			route.paramNames.forEach((name, i) => {
				params[name] = decodeURIComponent(match[i + 1]!)
			})

			try {
				await route.handler(req, res, params, body)
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : 'Internal error'
				this.logger?.error({ method, url, err }, 'Request failed')
				this._respond(res, 500, { error: msg })
			}

			return
		}

		this._respond(res, 404, { error: 'Not found' })
	}

	// ─── Route handlers ──────────────────────────────────────────────────────────

	private async _listSessions(_req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		this._respond(res, 200, { sessions: this.manager.listSessions() })
	}

	private async _createSession(
		_req: http.IncomingMessage,
		res: http.ServerResponse,
		_p: Record<string, never>,
		body: unknown
	): Promise<void> {
		const { id } = body as { id?: string }
		if (!id) return this._respond(res, 400, { error: 'id is required' })
		const info = await this.manager.createSession(id)
		this._respond(res, 201, { session: info })
	}

	private async _getSession(
		_req: http.IncomingMessage,
		res: http.ServerResponse,
		{ id }: { id: string }
	): Promise<void> {
		const info = this.manager.getInfo(id)
		if (!info) return this._respond(res, 404, { error: 'Session not found' })
		this._respond(res, 200, { session: info })
	}

	private async _destroySession(
		_req: http.IncomingMessage,
		res: http.ServerResponse,
		{ id }: { id: string }
	): Promise<void> {
		await this.manager.destroySession(id)
		this._respond(res, 200, { ok: true })
	}

	private async _sendText(
		_req: http.IncomingMessage,
		res: http.ServerResponse,
		{ id }: { id: string },
		body: unknown
	): Promise<void> {
		const sock = this._requireSocket(id, res)
		if (!sock) return
		const { jid, text } = body as { jid: string; text: string }
		if (!jid || !text) return this._respond(res, 400, { error: 'jid and text are required' })
		const msg = await sock.sendMessage(jid, { text } as AnyMessageContent)
		this._respond(res, 200, { message: msg })
	}

	private async _sendMedia(
		_req: http.IncomingMessage,
		res: http.ServerResponse,
		{ id }: { id: string },
		body: unknown
	): Promise<void> {
		const sock = this._requireSocket(id, res)
		if (!sock) return
		const { jid, url, type, caption, mimetype, fileName } = body as {
			jid: string
			url: string
			type: 'image' | 'video' | 'audio' | 'document' | 'sticker'
			caption?: string
			mimetype?: string
			fileName?: string
		}
		if (!jid || !url || !type) return this._respond(res, 400, { error: 'jid, url, and type are required' })
		const content = { [type]: { url }, caption, mimetype, fileName } as unknown as AnyMessageContent
		const msg = await sock.sendMessage(jid, content)
		this._respond(res, 200, { message: msg })
	}

	private async _sendReaction(
		_req: http.IncomingMessage,
		res: http.ServerResponse,
		{ id }: { id: string },
		body: unknown
	): Promise<void> {
		const sock = this._requireSocket(id, res)
		if (!sock) return
		const { jid, messageId, emoji, fromMe, participant } = body as {
			jid: string; messageId: string; emoji: string; fromMe?: boolean; participant?: string
		}
		if (!jid || !messageId || !emoji) return this._respond(res, 400, { error: 'jid, messageId, and emoji are required' })
		const key = { remoteJid: jid, id: messageId, fromMe: fromMe ?? false, participant }
		const msg = await sock.sendReaction(jid, key, emoji)
		this._respond(res, 200, { message: msg })
	}

	private async _forwardMessage(
		_req: http.IncomingMessage,
		res: http.ServerResponse,
		{ id }: { id: string },
		body: unknown
	): Promise<void> {
		const sock = this._requireSocket(id, res)
		if (!sock) return
		const { toJid, message } = body as { toJid: string; message: import('../Types').WAMessage }
		if (!toJid || !message) return this._respond(res, 400, { error: 'toJid and message are required' })
		const msgs = await sock.forwardMessages(toJid, [message])
		this._respond(res, 200, { messages: msgs })
	}

	private async _deleteMessage(
		_req: http.IncomingMessage,
		res: http.ServerResponse,
		{ id }: { id: string },
		body: unknown
	): Promise<void> {
		const sock = this._requireSocket(id, res)
		if (!sock) return
		const { jid, messageId, fromMe, participant } = body as {
			jid: string; messageId: string; fromMe?: boolean; participant?: string
		}
		if (!jid || !messageId) return this._respond(res, 400, { error: 'jid and messageId are required' })
		await sock.sendMessage(jid, { delete: { remoteJid: jid, id: messageId, fromMe: fromMe ?? true, participant } })
		this._respond(res, 200, { ok: true })
	}

	private async _markRead(
		_req: http.IncomingMessage,
		res: http.ServerResponse,
		{ id }: { id: string },
		body: unknown
	): Promise<void> {
		const sock = this._requireSocket(id, res)
		if (!sock) return
		const { jid, messageIds, fromMe, participant } = body as {
			jid: string; messageIds: string[]; fromMe?: boolean; participant?: string
		}
		if (!jid || !messageIds?.length) return this._respond(res, 400, { error: 'jid and messageIds are required' })
		const keys = messageIds.map(msgId => ({ remoteJid: jid, id: msgId, fromMe: fromMe ?? false, participant }))
		await sock.readMessages(keys)
		this._respond(res, 200, { ok: true })
	}

	private async _pinMessage(
		_req: http.IncomingMessage,
		res: http.ServerResponse,
		{ id }: { id: string },
		body: unknown
	): Promise<void> {
		const sock = this._requireSocket(id, res)
		if (!sock) return
		const { jid, messageId, fromMe, participant, time, unpin } = body as {
			jid: string; messageId: string; fromMe?: boolean; participant?: string
			time?: 86400 | 604800 | 2592000; unpin?: boolean
		}
		if (!jid || !messageId) return this._respond(res, 400, { error: 'jid and messageId are required' })
		const key = { remoteJid: jid, id: messageId, fromMe: fromMe ?? true, participant }
		const msg = unpin ? await sock.unpinMessage(jid, key) : await sock.pinMessage(jid, key, time)
		this._respond(res, 200, { message: msg })
	}

	private async _sendPresence(
		_req: http.IncomingMessage,
		res: http.ServerResponse,
		{ id }: { id: string },
		body: unknown
	): Promise<void> {
		const sock = this._requireSocket(id, res)
		if (!sock) return
		const { jid, presence } = body as { jid?: string; presence: import('../Types').WAPresence }
		await sock.sendPresenceUpdate(presence, jid)
		this._respond(res, 200, { ok: true })
	}

	private async _sendStatusStory(
		_req: http.IncomingMessage,
		res: http.ServerResponse,
		{ id }: { id: string },
		body: unknown
	): Promise<void> {
		const sock = this._requireSocket(id, res)
		if (!sock) return
		const { text, statusJidList } = body as { text: string; statusJidList?: string[] }
		if (!text) return this._respond(res, 400, { error: 'text is required' })
		const msg = await sock.sendStatusStory({ text }, statusJidList)
		this._respond(res, 200, { message: msg })
	}

	private async _createGroup(
		_req: http.IncomingMessage,
		res: http.ServerResponse,
		{ id }: { id: string },
		body: unknown
	): Promise<void> {
		const sock = this._requireSocket(id, res)
		if (!sock) return
		const { subject, participants } = body as { subject: string; participants: string[] }
		if (!subject || !participants?.length) return this._respond(res, 400, { error: 'subject and participants are required' })
		const meta = await sock.groupCreate(subject, participants)
		this._respond(res, 201, { group: meta })
	}

	private async _getGroupMetadata(
		_req: http.IncomingMessage,
		res: http.ServerResponse,
		{ id, gid }: { id: string; gid: string }
	): Promise<void> {
		const sock = this._requireSocket(id, res)
		if (!sock) return
		const meta = await sock.groupMetadata(decodeURIComponent(gid))
		this._respond(res, 200, { group: meta })
	}

	private async _updateGroupParticipants(
		_req: http.IncomingMessage,
		res: http.ServerResponse,
		{ id, gid }: { id: string; gid: string },
		body: unknown
	): Promise<void> {
		const sock = this._requireSocket(id, res)
		if (!sock) return
		const { participants, action } = body as { participants: string[]; action: import('../Types').ParticipantAction }
		if (!participants?.length || !action) return this._respond(res, 400, { error: 'participants and action are required' })
		const results = await sock.groupParticipantsUpdate(decodeURIComponent(gid), participants, action)
		this._respond(res, 200, { results })
	}

	private async _getGroupInviteLink(
		_req: http.IncomingMessage,
		res: http.ServerResponse,
		{ id, gid }: { id: string; gid: string }
	): Promise<void> {
		const sock = this._requireSocket(id, res)
		if (!sock) return
		const link = await sock.groupGetInviteLink(decodeURIComponent(gid))
		this._respond(res, 200, { link })
	}

	private async _updateGroupSubject(
		_req: http.IncomingMessage,
		res: http.ServerResponse,
		{ id, gid }: { id: string; gid: string },
		body: unknown
	): Promise<void> {
		const sock = this._requireSocket(id, res)
		if (!sock) return
		const { subject } = body as { subject: string }
		if (!subject) return this._respond(res, 400, { error: 'subject is required' })
		await sock.groupUpdateSubject(decodeURIComponent(gid), subject)
		this._respond(res, 200, { ok: true })
	}

	private async _updateGroupDescription(
		_req: http.IncomingMessage,
		res: http.ServerResponse,
		{ id, gid }: { id: string; gid: string },
		body: unknown
	): Promise<void> {
		const sock = this._requireSocket(id, res)
		if (!sock) return
		const { description } = body as { description?: string }
		await sock.groupUpdateDescription(decodeURIComponent(gid), description)
		this._respond(res, 200, { ok: true })
	}

	private async _updateGroupSettings(
		_req: http.IncomingMessage,
		res: http.ServerResponse,
		{ id, gid }: { id: string; gid: string },
		body: unknown
	): Promise<void> {
		const sock = this._requireSocket(id, res)
		if (!sock) return
		const { setting } = body as { setting: 'announcement' | 'not_announcement' | 'locked' | 'unlocked' }
		if (!setting) return this._respond(res, 400, { error: 'setting is required' })
		await sock.groupSettingUpdate(decodeURIComponent(gid), setting)
		this._respond(res, 200, { ok: true })
	}

	private async _leaveGroup(
		_req: http.IncomingMessage,
		res: http.ServerResponse,
		{ id, gid }: { id: string; gid: string }
	): Promise<void> {
		const sock = this._requireSocket(id, res)
		if (!sock) return
		await sock.groupLeave(decodeURIComponent(gid))
		this._respond(res, 200, { ok: true })
	}

	private async _updateProfileName(
		_req: http.IncomingMessage,
		res: http.ServerResponse,
		{ id }: { id: string },
		body: unknown
	): Promise<void> {
		const sock = this._requireSocket(id, res)
		if (!sock) return
		const { name } = body as { name: string }
		if (!name) return this._respond(res, 400, { error: 'name is required' })
		await sock.updateProfileName(name)
		this._respond(res, 200, { ok: true })
	}

	private async _updateProfileStatus(
		_req: http.IncomingMessage,
		res: http.ServerResponse,
		{ id }: { id: string },
		body: unknown
	): Promise<void> {
		const sock = this._requireSocket(id, res)
		if (!sock) return
		const { status } = body as { status: string }
		if (!status) return this._respond(res, 400, { error: 'status is required' })
		await sock.updateProfileStatus(status)
		this._respond(res, 200, { ok: true })
	}

	private async _getBusinessProfile(
		_req: http.IncomingMessage,
		res: http.ServerResponse,
		{ id, jid }: { id: string; jid: string }
	): Promise<void> {
		const sock = this._requireSocket(id, res)
		if (!sock) return
		const profile = await sock.getBusinessProfile(decodeURIComponent(jid))
		this._respond(res, 200, { profile })
	}

	private async _checkOnWhatsApp(
		_req: http.IncomingMessage,
		res: http.ServerResponse,
		{ id }: { id: string },
		body: unknown
	): Promise<void> {
		const sock = this._requireSocket(id, res)
		if (!sock) return
		const { phones } = body as { phones: string[] }
		if (!phones?.length) return this._respond(res, 400, { error: 'phones array is required' })
		const results = await sock.onWhatsApp(...phones)
		this._respond(res, 200, { results })
	}

	private async _blockContact(
		_req: http.IncomingMessage,
		res: http.ServerResponse,
		{ id }: { id: string },
		body: unknown
	): Promise<void> {
		const sock = this._requireSocket(id, res)
		if (!sock) return
		const { jid, action } = body as { jid: string; action: 'block' | 'unblock' }
		if (!jid || !action) return this._respond(res, 400, { error: 'jid and action are required' })
		await sock.updateBlockStatus(jid, action)
		this._respond(res, 200, { ok: true })
	}

	private async _archiveChat(
		_req: http.IncomingMessage,
		res: http.ServerResponse,
		{ id, jid }: { id: string; jid: string },
		body: unknown
	): Promise<void> {
		const sock = this._requireSocket(id, res)
		if (!sock) return
		const { archive } = body as { archive?: boolean }
		await sock.chatModify({ archive: archive ?? true, lastMessages: [] }, decodeURIComponent(jid))
		this._respond(res, 200, { ok: true })
	}

	private async _muteChat(
		_req: http.IncomingMessage,
		res: http.ServerResponse,
		{ id, jid }: { id: string; jid: string },
		body: unknown
	): Promise<void> {
		const sock = this._requireSocket(id, res)
		if (!sock) return
		const { mute, muteEndTime } = body as { mute: boolean; muteEndTime?: number }
		await sock.chatModify({ mute: mute ? (muteEndTime ?? null) : null, lastMessages: [] }, decodeURIComponent(jid))
		this._respond(res, 200, { ok: true })
	}

	private async _health(_req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		this._respond(res, 200, {
			status: 'ok',
			sessions: this.manager.listSessions().length,
			uptime: process.uptime()
		})
	}

	// ─── Helpers ─────────────────────────────────────────────────────────────────

	private _requireSocket(id: string, res: http.ServerResponse) {
		const sock = this.manager.getSocket(id)
		if (!sock) {
			this._respond(res, 404, { error: `Session not found: ${id}` })
			return null
		}

		const info = this.manager.getInfo(id)
		if (info?.status !== 'connected') {
			this._respond(res, 409, { error: `Session ${id} is not connected (status: ${info?.status})` })
			return null
		}

		return sock
	}

	private _respond(res: http.ServerResponse, status: number, data: unknown): void {
		if (!res.headersSent) {
			res.statusCode = status
			res.end(JSON.stringify(data))
		}
	}

	private _readBody(req: http.IncomingMessage): Promise<unknown> {
		return new Promise((resolve, reject) => {
			let raw = ''
			req.on('data', chunk => (raw += chunk))
			req.on('end', () => {
				try {
					resolve(raw ? JSON.parse(raw) : {})
				} catch {
					resolve({})
				}
			})
			req.on('error', reject)
		})
	}
}
