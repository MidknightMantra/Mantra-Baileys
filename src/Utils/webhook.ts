import { EventEmitter } from 'events'
import * as http from 'http'
import * as https from 'https'
import type { BaileysEventMap } from '../Types'
import type { ILogger } from './logger'

export type WebhookConfig = {
	url: string
	events?: (keyof BaileysEventMap)[]
	secret?: string
	headers?: Record<string, string>
	timeoutMs?: number
	retries?: number
	retryDelayMs?: number
	onError?: (event: string, error: Error) => void
	onSuccess?: (event: string, statusCode: number) => void
}

export type WebhookPayload<K extends keyof BaileysEventMap = keyof BaileysEventMap> = {
	event: K
	data: BaileysEventMap[K]
	timestamp: number
	webhookId: string
}

const DEFAULT_EVENTS: (keyof BaileysEventMap)[] = [
	'messages.upsert',
	'messages.update',
	'messages.delete',
	'message-receipt.update',
	'contacts.upsert',
	'contacts.update',
	'chats.upsert',
	'chats.update',
	'groups.upsert',
	'groups.update',
	'group-participants.update',
	'presence.update',
	'call'
]

export class WebhookBridge {
	private configs: Map<string, WebhookConfig> = new Map()
	private webhookId: string
	private logger?: ILogger

	constructor(logger?: ILogger) {
		this.webhookId = `wh_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
		this.logger = logger
	}

	addEndpoint(id: string, config: WebhookConfig): this {
		this.configs.set(id, {
			timeoutMs: 10_000,
			retries: 3,
			retryDelayMs: 1_000,
			events: DEFAULT_EVENTS,
			...config
		})
		this.logger?.info({ id, url: config.url }, 'Webhook endpoint registered')
		return this
	}

	removeEndpoint(id: string): boolean {
		return this.configs.delete(id)
	}

	attach(ev: EventEmitter, events?: (keyof BaileysEventMap)[]): this {
		const targetEvents = events ?? DEFAULT_EVENTS
		for (const eventName of targetEvents) {
			ev.on(eventName as string, (data: unknown) => {
				this._dispatch(eventName, data)
			})
		}

		return this
	}

	async send<K extends keyof BaileysEventMap>(event: K, data: BaileysEventMap[K]): Promise<void> {
		await this._dispatch(event, data)
	}

	private async _dispatch(event: string, data: unknown): Promise<void> {
		const payload: WebhookPayload = {
			event: event as keyof BaileysEventMap,
			data: data as BaileysEventMap[keyof BaileysEventMap],
			timestamp: Date.now(),
			webhookId: this.webhookId
		}

		for (const [id, config] of this.configs) {
			const configuredEvents = config.events ?? DEFAULT_EVENTS
			if (!configuredEvents.includes(event as keyof BaileysEventMap)) continue

			this._sendWithRetry(id, config, event, payload).catch(err => {
				this.logger?.error({ id, event, err }, 'Webhook delivery failed after retries')
				config.onError?.(event, err as Error)
			})
		}
	}

	private async _sendWithRetry(id: string, config: WebhookConfig, event: string, payload: WebhookPayload, attempt = 0): Promise<void> {
		try {
			const statusCode = await this._httpPost(config, payload)
			this.logger?.debug({ id, event, statusCode }, 'Webhook delivered')
			config.onSuccess?.(event, statusCode)
		} catch (err) {
			const retries = config.retries ?? 3
			if (attempt < retries) {
				const delay = (config.retryDelayMs ?? 1000) * Math.pow(2, attempt)
				this.logger?.warn({ id, event, attempt, delay }, 'Webhook failed, retrying')
				await new Promise(r => setTimeout(r, delay))
				return this._sendWithRetry(id, config, event, payload, attempt + 1)
			}

			throw err
		}
	}

	private _httpPost(config: WebhookConfig, payload: WebhookPayload): Promise<number> {
		return new Promise((resolve, reject) => {
			const body = JSON.stringify(payload)
			const url = new URL(config.url)
			const isHttps = url.protocol === 'https:'

			const headers: Record<string, string> = {
				'Content-Type': 'application/json',
				'Content-Length': Buffer.byteLength(body).toString(),
				'X-Webhook-Id': payload.webhookId,
				'X-Event': payload.event as string,
				...config.headers
			}

			if (config.secret) {
				headers['X-Webhook-Secret'] = config.secret
			}

			const options: http.RequestOptions = {
				hostname: url.hostname,
				port: url.port || (isHttps ? 443 : 80),
				path: url.pathname + url.search,
				method: 'POST',
				headers,
				timeout: config.timeoutMs ?? 10_000
			}

			const req = (isHttps ? https : http).request(options, res => {
				res.resume()
				if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
					resolve(res.statusCode)
				} else {
					reject(new Error(`Webhook HTTP ${res.statusCode ?? 'unknown'}`))
				}
			})

			req.on('timeout', () => {
				req.destroy()
				reject(new Error('Webhook request timed out'))
			})

			req.on('error', reject)
			req.write(body)
			req.end()
		})
	}
}
