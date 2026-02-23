import type { ILogger } from './logger'

export type RateLimiterConfig = {
	messagesPerMinute?: number
	messagesPerDay?: number
	minDelayMs?: number
	maxDelayMs?: number
	jitterMs?: number
	perRecipientDelayMs?: number
	onRateLimited?: (jid: string, queueDepth: number) => void
	onDailyLimitReached?: (jid: string) => void
}

type QueuedTask = {
	jid: string
	fn: () => Promise<unknown>
	resolve: (value: unknown) => void
	reject: (reason?: unknown) => void
	enqueuedAt: number
}

const DEFAULT_CONFIG: Required<Omit<RateLimiterConfig, 'onRateLimited' | 'onDailyLimitReached'>> = {
	messagesPerMinute: 20,
	messagesPerDay: 500,
	minDelayMs: 800,
	maxDelayMs: 3000,
	jitterMs: 400,
	perRecipientDelayMs: 2000
}

export class RateLimitedQueue {
	private config: typeof DEFAULT_CONFIG & Pick<RateLimiterConfig, 'onRateLimited' | 'onDailyLimitReached'>
	private queue: QueuedTask[] = []
	private processing = false
	private sentThisMinute = 0
	private sentToday = 0
	private lastSentAt: Map<string, number> = new Map()
	private minuteResetTimer?: NodeJS.Timeout
	private dayResetTimer?: NodeJS.Timeout
	private logger?: ILogger

	constructor(config: RateLimiterConfig = {}, logger?: ILogger) {
		this.config = { ...DEFAULT_CONFIG, ...config }
		this.logger = logger
		this._startMinuteReset()
		this._startDayReset()
	}

	enqueue<T>(jid: string, fn: () => Promise<T>): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			this.queue.push({
				jid,
				fn: fn as () => Promise<unknown>,
				resolve: resolve as (value: unknown) => void,
				reject,
				enqueuedAt: Date.now()
			})

			this.config.onRateLimited?.(jid, this.queue.length)
			this.logger?.debug({ jid, queueDepth: this.queue.length }, 'Message enqueued')

			if (!this.processing) this._process()
		})
	}

	get queueDepth(): number {
		return this.queue.length
	}

	get stats() {
		return {
			sentThisMinute: this.sentThisMinute,
			sentToday: this.sentToday,
			queueDepth: this.queue.length,
			rateLimitPerMinute: this.config.messagesPerMinute,
			rateLimitPerDay: this.config.messagesPerDay
		}
	}

	clear(): void {
		for (const task of this.queue) {
			task.reject(new Error('Queue cleared'))
		}

		this.queue = []
	}

	destroy(): void {
		this.clear()
		if (this.minuteResetTimer) clearInterval(this.minuteResetTimer)
		if (this.dayResetTimer) clearInterval(this.dayResetTimer)
	}

	private async _process(): Promise<void> {
		if (this.processing) return
		this.processing = true

		while (this.queue.length > 0) {
			if (this.sentToday >= this.config.messagesPerDay) {
				const jid = this.queue[0]?.jid ?? 'unknown'
				this.config.onDailyLimitReached?.(jid)
				this.logger?.warn({ sentToday: this.sentToday }, 'Daily message limit reached, pausing queue')
				await this._waitUntilMidnight()
				continue
			}

			if (this.sentThisMinute >= this.config.messagesPerMinute) {
				this.logger?.debug({ sentThisMinute: this.sentThisMinute }, 'Minute rate limit reached, waiting')
				await this._sleep(this._nextMinuteMs())
				continue
			}

			const task = this.queue.shift()!

			const lastSent = this.lastSentAt.get(task.jid)
			if (lastSent) {
				const elapsed = Date.now() - lastSent
				const required = this.config.perRecipientDelayMs
				if (elapsed < required) {
					await this._sleep(required - elapsed)
				}
			}

			const delay = this._randomDelay()
			this.logger?.debug({ jid: task.jid, delay }, 'Sending message after delay')
			await this._sleep(delay)

			try {
				const result = await task.fn()
				this.lastSentAt.set(task.jid, Date.now())
				this.sentThisMinute++
				this.sentToday++
				task.resolve(result)
			} catch (err) {
				this.logger?.error({ jid: task.jid, err }, 'Message send failed in queue')
				task.reject(err)
			}
		}

		this.processing = false
	}

	private _randomDelay(): number {
		const base = this.config.minDelayMs + Math.random() * (this.config.maxDelayMs - this.config.minDelayMs)
		const jitter = (Math.random() - 0.5) * this.config.jitterMs
		return Math.max(100, Math.round(base + jitter))
	}

	private _sleep(ms: number): Promise<void> {
		return new Promise(r => setTimeout(r, ms))
	}

	private _nextMinuteMs(): number {
		return 60_000 - (Date.now() % 60_000)
	}

	private _waitUntilMidnight(): Promise<void> {
		const now = new Date()
		const midnight = new Date(now)
		midnight.setHours(24, 0, 0, 0)
		return this._sleep(midnight.getTime() - now.getTime())
	}

	private _startMinuteReset(): void {
		const msToNextMinute = 60_000 - (Date.now() % 60_000)
		setTimeout(() => {
			this.sentThisMinute = 0
			this.minuteResetTimer = setInterval(() => {
				this.sentThisMinute = 0
			}, 60_000)
		}, msToNextMinute)
	}

	private _startDayReset(): void {
		const now = new Date()
		const midnight = new Date(now)
		midnight.setHours(24, 0, 0, 0)
		setTimeout(() => {
			this.sentToday = 0
			this.dayResetTimer = setInterval(() => {
				this.sentToday = 0
			}, 24 * 60 * 60 * 1000)
		}, midnight.getTime() - now.getTime())
	}
}
