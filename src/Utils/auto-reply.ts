import type { WAMessage } from '../Types'

export type AutoReplyTrigger = {
	type: 'exact' | 'contains' | 'startsWith' | 'endsWith' | 'regex'
	value: string | RegExp
	caseSensitive?: boolean
}

export type AutoReplyCondition = {
	onlyFrom?: string[]
	onlyInGroups?: boolean
	onlyInDMs?: boolean
	cooldownMs?: number
}

export type AutoReplyAction<T> = {
	reply: T | ((msg: WAMessage) => T | Promise<T>)
	typing?: boolean
	typingDelayMs?: number
}

export type AutoReplyRule<T> = {
	id: string
	trigger: AutoReplyTrigger
	condition?: AutoReplyCondition
	action: AutoReplyAction<T>
	enabled?: boolean
}

type SendReplyFn<T> = (jid: string, content: T, quoted: WAMessage) => Promise<unknown>
type SetTypingFn = (jid: string, typing: boolean) => Promise<unknown>

export class AutoReplyManager<T = unknown> {
	private rules: Map<string, AutoReplyRule<T>> = new Map()
	private cooldowns: Map<string, number> = new Map()
	private sendReply: SendReplyFn<T>
	private setTyping?: SetTypingFn

	constructor(sendReply: SendReplyFn<T>, setTyping?: SetTypingFn) {
		this.sendReply = sendReply
		this.setTyping = setTyping
	}

	addRule(rule: AutoReplyRule<T>): this {
		this.rules.set(rule.id, { enabled: true, ...rule })
		return this
	}

	removeRule(id: string): boolean {
		return this.rules.delete(id)
	}

	enableRule(id: string): void {
		const rule = this.rules.get(id)
		if (rule) rule.enabled = true
	}

	disableRule(id: string): void {
		const rule = this.rules.get(id)
		if (rule) rule.enabled = false
	}

	getRules(): AutoReplyRule<T>[] {
		return Array.from(this.rules.values())
	}

	async process(msg: WAMessage): Promise<boolean> {
		if (!msg.message || !msg.key.remoteJid) return false

		const text = this._extractText(msg)
		if (!text) return false

		const jid = msg.key.remoteJid
		const isGroup = jid.endsWith('@g.us')

		for (const rule of this.rules.values()) {
			if (!rule.enabled) continue
			if (!this._matchesTrigger(text, rule.trigger)) continue
			if (!this._meetsCondition(msg, jid, isGroup, rule.condition)) continue

			const cooldownKey = `${rule.id}:${jid}`
			const now = Date.now()
			const lastUsed = this.cooldowns.get(cooldownKey) ?? 0
			const cooldown = rule.condition?.cooldownMs ?? 0
			if (cooldown > 0 && now - lastUsed < cooldown) continue

			this.cooldowns.set(cooldownKey, now)

			if (rule.action.typing && this.setTyping) {
				await this.setTyping(jid, true)
				if (rule.action.typingDelayMs) {
					await new Promise(r => setTimeout(r, rule.action.typingDelayMs))
				}
				await this.setTyping(jid, false)
			}

			const content =
				typeof rule.action.reply === 'function'
					? await (rule.action.reply as (msg: WAMessage) => T | Promise<T>)(msg)
					: rule.action.reply

			await this.sendReply(jid, content, msg)
			return true
		}

		return false
	}

	private _extractText(msg: WAMessage): string | null {
		const m = msg.message
		if (!m) return null
		return (
			m.conversation ??
			m.extendedTextMessage?.text ??
			m.imageMessage?.caption ??
			m.videoMessage?.caption ??
			m.documentMessage?.caption ??
			null
		)
	}

	private _matchesTrigger(text: string, trigger: AutoReplyTrigger): boolean {
		const compare = trigger.caseSensitive ? text : text.toLowerCase()
		const value = trigger.value instanceof RegExp ? trigger.value : trigger.caseSensitive ? trigger.value : (trigger.value as string).toLowerCase()

		switch (trigger.type) {
			case 'exact':
				return compare === value
			case 'contains':
				return typeof value === 'string' ? compare.includes(value) : value.test(text)
			case 'startsWith':
				return typeof value === 'string' ? compare.startsWith(value) : value.test(text)
			case 'endsWith':
				return typeof value === 'string' ? compare.endsWith(value) : value.test(text)
			case 'regex':
				return value instanceof RegExp ? value.test(text) : new RegExp(value).test(text)
			default:
				return false
		}
	}

	private _meetsCondition(msg: WAMessage, jid: string, isGroup: boolean, condition?: AutoReplyCondition): boolean {
		if (!condition) return true

		if (condition.onlyInGroups && !isGroup) return false
		if (condition.onlyInDMs && isGroup) return false

		if (condition.onlyFrom && condition.onlyFrom.length > 0) {
			const sender = msg.key.participant ?? msg.key.remoteJid ?? ''
			if (!condition.onlyFrom.some(j => j === sender || j === jid)) return false
		}

		return true
	}
}
