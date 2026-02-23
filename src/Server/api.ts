import * as http from 'http'
import * as fs from 'fs'
import * as path from 'path'
import QRCode from 'qrcode'
import { marked } from 'marked'
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
                        port: config.port ?? 5000,
                        host: config.host ?? '0.0.0.0',
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

                // QR image
                this._route('GET', '/sessions/:id/qr.png', this._getQRImage.bind(this))

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
                res.setHeader('X-Powered-By', 'Baileys-API')

                const url = (req.url?.split('?')[0]) ?? '/'
                const method = req.method ?? 'GET'

                // Dashboard — public, no auth
                if (method === 'GET' && url === '/') {
                        res.setHeader('Content-Type', 'text/html; charset=utf-8')
                        res.statusCode = 200
                        res.end(this._buildDashboard())
                        return
                }

                // Docs — serve markdown files as styled HTML
                if (method === 'GET' && url.startsWith('/docs/')) {
                        const filename = path.basename(url)
                        const filepath = path.join(process.cwd(), 'docs', filename)
                        if (!filename.endsWith('.md') || !fs.existsSync(filepath)) {
                                res.statusCode = 404
                                res.setHeader('Content-Type', 'text/plain')
                                res.end('Not found')
                                return
                        }
                        const content = fs.readFileSync(filepath, 'utf8')
                        const html = marked(content) as string
                        const title = filename.replace('.md', '').replace(/-/g, ' ')
                        res.setHeader('Content-Type', 'text/html; charset=utf-8')
                        res.statusCode = 200
                        res.end(`<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,sans-serif;background:#0f172a;color:#cbd5e1;line-height:1.75;padding:0 16px 80px}
  .wrap{max-width:820px;margin:0 auto}
  nav{display:flex;gap:20px;align-items:center;padding:20px 0 32px;border-bottom:1px solid #1e293b;margin-bottom:40px;font-size:.875rem;flex-wrap:wrap}
  nav a{color:#38bdf8;text-decoration:none;white-space:nowrap}
  nav a:hover{text-decoration:underline}
  nav .sep{color:#334155}
  h1{font-size:2rem;color:#f1f5f9;margin:0 0 24px;padding-bottom:16px;border-bottom:2px solid #1e293b}
  h2{font-size:1.35rem;color:#e2e8f0;margin:40px 0 12px;padding-bottom:8px;border-bottom:1px solid #1e293b}
  h3{font-size:1.1rem;color:#e2e8f0;margin:28px 0 8px}
  h4{color:#94a3b8;margin:20px 0 6px}
  p{margin:0 0 16px}
  a{color:#38bdf8}
  a:hover{text-decoration:underline}
  code{background:#1e293b;color:#7dd3fc;padding:2px 6px;border-radius:4px;font-size:.85em;font-family:'SF Mono',Consolas,monospace}
  pre{background:#1e293b;border:1px solid #334155;border-radius:10px;padding:20px;overflow-x:auto;margin:0 0 20px;font-size:.82em;line-height:1.6}
  pre code{background:none;color:#e2e8f0;padding:0;font-size:inherit}
  ul,ol{padding-left:24px;margin:0 0 16px}
  li{margin-bottom:6px}
  blockquote{border-left:3px solid #38bdf8;padding-left:16px;color:#94a3b8;margin:0 0 16px;font-style:italic}
  table{width:100%;border-collapse:collapse;margin:0 0 20px;font-size:.9em}
  th{background:#1e293b;color:#e2e8f0;padding:10px 14px;text-align:left;border:1px solid #334155}
  td{padding:9px 14px;border:1px solid #1e293b}
  tr:nth-child(even) td{background:#0d1829}
  hr{border:none;border-top:1px solid #1e293b;margin:32px 0}
  strong{color:#e2e8f0}
</style>
</head><body>
<div class="wrap">
<nav>
  <a href="/">← Dashboard</a><span class="sep">·</span>
  <a href="/docs/getting-started.md">Getting Started</a><span class="sep">·</span>
  <a href="/docs/api-reference.md">API Reference</a><span class="sep">·</span>
  <a href="/docs/utilities.md">Utilities</a>
</nav>
${html}
</div>
</body></html>`)
                        return
                }

                res.setHeader('Content-Type', 'application/json')

                if (this.config.apiKey) {
                        const key = (req.headers['x-api-key'] ?? req.headers['authorization']?.replace('Bearer ', '')) as string | undefined
                        if (key !== this.config.apiKey) {
                                return this._respond(res, 401, { error: 'Unauthorized' })
                        }
                }

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

        private async _getQRImage(
                _req: http.IncomingMessage,
                res: http.ServerResponse,
                { id }: { id: string }
        ): Promise<void> {
                const info = this.manager.getInfo(id)
                if (!info) return this._respond(res, 404, { error: 'Session not found' })
                if (!info.qr) {
                        res.statusCode = 204
                        res.end()
                        return
                }
                const png = await QRCode.toBuffer(info.qr, { width: 300, margin: 2, errorCorrectionLevel: 'L' })
                res.setHeader('Content-Type', 'image/png')
                res.setHeader('Cache-Control', 'no-store')
                res.statusCode = 200
                res.end(png)
        }

        private async _health(_req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
                this._respond(res, 200, {
                        status: 'ok',
                        sessions: this.manager.listSessions().length,
                        uptime: process.uptime()
                })
        }

        // ─── Helpers ─────────────────────────────────────────────────────────────────

        private _buildDashboard(): string {
                const sessions = this.manager.listSessions()
                const uptime = Math.floor(process.uptime())
                const h = Math.floor(uptime / 3600)
                const m = Math.floor((uptime % 3600) / 60)
                const s = uptime % 60
                const uptimeStr = `${h}h ${m}m ${s}s`

                const statusColor: Record<string, string> = {
                        connected: '#22c55e',
                        qr_ready: '#f59e0b',
                        initializing: '#6366f1',
                        disconnected: '#ef4444',
                        logged_out: '#6b7280'
                }

                const sessionCards = sessions.length === 0
                        ? `<div class="empty">No sessions yet. Create one with <code>POST /sessions</code>.</div>`
                        : sessions.map(s => {
                                const color = statusColor[s.status] ?? '#6b7280'
                                const qrSection = s.qr
                                        ? `<div class="qr-wrap">
                                                <img src="/sessions/${s.id}/qr.png" class="qr-img" alt="QR code"/>
                                                <p class="qr-hint">Scan with WhatsApp</p>
                                           </div>`
                                        : ''
                                const meta = s.status === 'connected'
                                        ? `<div class="meta">
                                                <span>${s.phoneNumber ?? ''}</span>
                                                ${s.name ? `<span class="name">${s.name}</span>` : ''}
                                           </div>`
                                        : ''
                                return `
                                <div class="card" data-id="${s.id}" data-qr="${s.qr ?? ''}">
                                        <div class="card-header">
                                                <span class="session-id">${s.id}</span>
                                                <span class="badge" style="background:${color}">${s.status}</span>
                                        </div>
                                        ${meta}
                                        ${qrSection}
                                        ${s.error ? `<div class="error-msg">${s.error}</div>` : ''}
                                        <button class="btn-delete" onclick="deleteSession('${s.id}')">Delete</button>
                                </div>`
                        }).join('')

                return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Baileys API</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;min-height:100vh;padding:24px}
  h1{font-size:1.5rem;font-weight:700;color:#f8fafc;margin-bottom:4px}
  .subtitle{color:#94a3b8;font-size:.85rem;margin-bottom:24px}
  .stats{display:flex;gap:16px;margin-bottom:24px;flex-wrap:wrap}
  .stat{background:#1e293b;border:1px solid #334155;border-radius:10px;padding:14px 20px;min-width:120px}
  .stat-val{font-size:1.6rem;font-weight:700;color:#38bdf8}
  .stat-lbl{font-size:.75rem;color:#64748b;text-transform:uppercase;letter-spacing:.05em}
  h2{font-size:1rem;font-weight:600;color:#cbd5e1;margin-bottom:14px}
  .sessions{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px;margin-bottom:32px}
  .card{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:18px;position:relative}
  .card-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}
  .session-id{font-weight:600;font-size:.95rem;color:#f1f5f9;word-break:break-all}
  .badge{font-size:.7rem;font-weight:700;padding:3px 9px;border-radius:99px;color:#fff;text-transform:uppercase;letter-spacing:.04em;white-space:nowrap;margin-left:8px}
  .meta{font-size:.8rem;color:#94a3b8;margin-bottom:10px}
  .meta .name{font-weight:600;color:#cbd5e1;margin-left:8px}
  .qr-wrap{text-align:center;margin:12px 0}
  .qr-img{border-radius:8px;background:#fff;padding:8px;width:220px;height:220px;display:block;margin:0 auto}
  .qr-hint{font-size:.75rem;color:#64748b;margin-top:6px}
  .error-msg{font-size:.75rem;color:#f87171;margin-top:6px;padding:6px 10px;background:#450a0a33;border-radius:6px}
  .empty{color:#475569;font-size:.9rem;grid-column:1/-1;padding:24px;text-align:center;border:1px dashed #334155;border-radius:10px}
  .empty code{color:#f59e0b;font-size:.85rem}
  .btn-delete{margin-top:12px;background:transparent;border:1px solid #ef444466;color:#f87171;font-size:.75rem;padding:4px 12px;border-radius:6px;cursor:pointer;transition:background .15s}
  .btn-delete:hover{background:#ef444422}
  .create-box{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:18px;margin-bottom:32px;max-width:400px}
  .create-box h2{margin-bottom:12px}
  .input-row{display:flex;gap:8px}
  input{flex:1;background:#0f172a;border:1px solid #334155;color:#f1f5f9;padding:8px 12px;border-radius:8px;font-size:.9rem;outline:none}
  input:focus{border-color:#38bdf8}
  .btn{background:#38bdf8;color:#0f172a;font-weight:700;border:none;padding:8px 18px;border-radius:8px;cursor:pointer;font-size:.9rem;transition:opacity .15s}
  .btn:hover{opacity:.85}
  .footer{color:#334155;font-size:.75rem;margin-top:16px}
  .footer a{color:#38bdf8;text-decoration:none}
  .refresh-note{color:#475569;font-size:.75rem;margin-top:8px}
</style>
</head>
<body>
<h1>Baileys API</h1>
<p class="subtitle">WhatsApp REST gateway · <a href="/health" style="color:#38bdf8">/health</a> · <a href="/sessions" style="color:#38bdf8">/sessions</a></p>

<div class="stats">
  <div class="stat"><div class="stat-val">${sessions.length}</div><div class="stat-lbl">Sessions</div></div>
  <div class="stat"><div class="stat-val">${sessions.filter(s => s.status === 'connected').length}</div><div class="stat-lbl">Connected</div></div>
  <div class="stat"><div class="stat-val">${uptimeStr}</div><div class="stat-lbl">Uptime</div></div>
</div>

<div class="create-box">
  <h2>Create session</h2>
  <div class="input-row">
    <input id="sid" placeholder="session-id" />
    <button class="btn" onclick="createSession()">Connect</button>
  </div>
</div>

<h2>Sessions</h2>
<div class="sessions" id="sessions-grid">${sessionCards}</div>

<p class="refresh-note">Auto-refreshes every 10 s</p>
<div class="footer">Baileys fork · <a href="/docs/getting-started.md">docs</a></div>

<script>
async function createSession() {
  const id = document.getElementById('sid').value.trim()
  if (!id) return
  await fetch('/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id })
  })
  document.getElementById('sid').value = ''
  refresh()
}

async function deleteSession(id) {
  if (!confirm('Delete session ' + id + '?')) return
  await fetch('/sessions/' + id, { method: 'DELETE' })
  refresh()
}

const STATUS_COLOR = {
  connected: '#22c55e',
  qr_ready: '#f59e0b',
  initializing: '#6366f1',
  disconnected: '#ef4444',
  logged_out: '#6b7280'
}

async function refresh() {
  try {
    const r = await fetch('/sessions')
    const { sessions } = await r.json()
    const grid = document.getElementById('sessions-grid')
    if (sessions.length === 0) {
      grid.innerHTML = '<div class="empty">No sessions yet. Create one above.</div>'
      return
    }
    grid.innerHTML = sessions.map(s => {
      const color = STATUS_COLOR[s.status] || '#6b7280'
      const qr = s.qr ? \`<div class="qr-wrap"><img src="/sessions/\${s.id}/qr.png?t=\${Date.now()}" class="qr-img" alt="QR"/><p class="qr-hint">Scan with WhatsApp</p></div>\` : ''
      const meta = s.status === 'connected' ? \`<div class="meta"><span>\${s.phoneNumber || ''}</span>\${s.name ? '<span class="name">'+s.name+'</span>' : ''}</div>\` : ''
      const err = s.error ? \`<div class="error-msg">\${s.error}</div>\` : ''
      return \`<div class="card">
        <div class="card-header">
          <span class="session-id">\${s.id}</span>
          <span class="badge" style="background:\${color}">\${s.status}</span>
        </div>
        \${meta}\${qr}\${err}
        <button class="btn-delete" onclick="deleteSession('\${s.id}')">Delete</button>
      </div>\`
    }).join('')
  } catch {}
}

// Call immediately once scripts are loaded, then every 10s
window.addEventListener('load', () => { refresh(); setInterval(refresh, 10000) })
</script>
</body>
</html>`
        }

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
