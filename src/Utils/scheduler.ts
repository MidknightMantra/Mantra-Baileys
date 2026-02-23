import type { ILogger } from './logger'

export type ScheduledMessage<T> = {
	id: string
	jid: string
	content: T
	options?: Record<string, unknown>
	scheduledAt: Date
	recurrence?: ScheduleRecurrence
}

export type ScheduleRecurrence = {
	type: 'once' | 'interval' | 'daily' | 'weekly'
	intervalMs?: number
	dayOfWeek?: number
	hour?: number
	minute?: number
}

type SendFn<T> = (jid: string, content: T, options?: Record<string, unknown>) => Promise<unknown>

export class MessageScheduler<T = unknown> {
	private jobs = new Map<string, NodeJS.Timeout>()
	private store = new Map<string, ScheduledMessage<T>>()
	private logger?: ILogger
	private sendFn: SendFn<T>

	constructor(sendFn: SendFn<T>, logger?: ILogger) {
		this.sendFn = sendFn
		this.logger = logger
	}

	schedule(msg: ScheduledMessage<T>): string {
		const delay = msg.scheduledAt.getTime() - Date.now()
		if (delay < 0) {
			throw new Error(`Scheduled time is in the past for message id=${msg.id}`)
		}

		this.store.set(msg.id, msg)
		this.logger?.info({ id: msg.id, jid: msg.jid, at: msg.scheduledAt }, 'Message scheduled')

		const timeout = setTimeout(() => this._fire(msg.id), delay)
		this.jobs.set(msg.id, timeout)
		return msg.id
	}

	scheduleIn(jid: string, content: T, delayMs: number, options?: Record<string, unknown>): string {
		const id = `sched_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
		return this.schedule({
			id,
			jid,
			content,
			options,
			scheduledAt: new Date(Date.now() + delayMs)
		})
	}

	scheduleRecurring(jid: string, content: T, recurrence: ScheduleRecurrence, options?: Record<string, unknown>): string {
		const id = `recur_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
		const firstFireAt = this._nextFireTime(recurrence)
		const msg: ScheduledMessage<T> = { id, jid, content, options, scheduledAt: firstFireAt, recurrence }
		this.store.set(id, msg)
		this.logger?.info({ id, jid, recurrence }, 'Recurring message scheduled')

		const delay = firstFireAt.getTime() - Date.now()
		const timeout = setTimeout(() => this._fire(id), delay)
		this.jobs.set(id, timeout)
		return id
	}

	cancel(id: string): boolean {
		const timeout = this.jobs.get(id)
		if (timeout) {
			clearTimeout(timeout)
			this.jobs.delete(id)
			this.store.delete(id)
			this.logger?.info({ id }, 'Scheduled message cancelled')
			return true
		}

		return false
	}

	cancelAll(): void {
		for (const id of this.jobs.keys()) {
			this.cancel(id)
		}
	}

	list(): ScheduledMessage<T>[] {
		return Array.from(this.store.values())
	}

	get(id: string): ScheduledMessage<T> | undefined {
		return this.store.get(id)
	}

	private async _fire(id: string): Promise<void> {
		const msg = this.store.get(id)
		if (!msg) return

		try {
			await this.sendFn(msg.jid, msg.content, msg.options)
			this.logger?.info({ id: msg.id, jid: msg.jid }, 'Scheduled message sent')
		} catch (err) {
			this.logger?.error({ id: msg.id, jid: msg.jid, err }, 'Failed to send scheduled message')
		}

		if (msg.recurrence && msg.recurrence.type !== 'once') {
			const next = this._nextFireTime(msg.recurrence)
			msg.scheduledAt = next
			this.store.set(id, msg)
			const delay = next.getTime() - Date.now()
			const timeout = setTimeout(() => this._fire(id), delay)
			this.jobs.set(id, timeout)
			this.logger?.info({ id, next }, 'Recurring message rescheduled')
		} else {
			this.jobs.delete(id)
			this.store.delete(id)
		}
	}

	private _nextFireTime(recurrence: ScheduleRecurrence): Date {
		const now = new Date()
		if (recurrence.type === 'interval') {
			return new Date(now.getTime() + (recurrence.intervalMs ?? 60_000))
		}

		if (recurrence.type === 'daily') {
			const next = new Date(now)
			next.setHours(recurrence.hour ?? 9, recurrence.minute ?? 0, 0, 0)
			if (next <= now) next.setDate(next.getDate() + 1)
			return next
		}

		if (recurrence.type === 'weekly') {
			const next = new Date(now)
			const targetDay = recurrence.dayOfWeek ?? 1
			const diff = (targetDay - next.getDay() + 7) % 7 || 7
			next.setDate(next.getDate() + diff)
			next.setHours(recurrence.hour ?? 9, recurrence.minute ?? 0, 0, 0)
			return next
		}

		return new Date(now.getTime() + 60_000)
	}
}
