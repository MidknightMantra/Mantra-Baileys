import type { WAMessage } from '../Types'

export type FlowContext<S extends Record<string, unknown> = Record<string, unknown>> = {
	jid: string
	msg: WAMessage
	text: string | null
	state: S
	step: string
	sessionId: string
}

export type FlowAction<S extends Record<string, unknown> = Record<string, unknown>> = {
	send?: unknown | ((ctx: FlowContext<S>) => unknown | Promise<unknown>)
	next?: string | ((ctx: FlowContext<S>) => string | Promise<string>)
	setState?: Partial<S> | ((ctx: FlowContext<S>) => Partial<S> | Promise<Partial<S>>)
	end?: boolean
}

export type FlowStep<S extends Record<string, unknown> = Record<string, unknown>> = {
	onEnter?: (ctx: FlowContext<S>) => FlowAction<S> | Promise<FlowAction<S>>
	onMessage?: (ctx: FlowContext<S>) => FlowAction<S> | Promise<FlowAction<S>>
}

export type FlowDefinition<S extends Record<string, unknown> = Record<string, unknown>> = {
	id: string
	initialStep: string
	initialState?: S
	steps: Record<string, FlowStep<S>>
	onEnd?: (ctx: FlowContext<S>) => void | Promise<void>
	timeoutMs?: number
	onTimeout?: (ctx: FlowContext<S>) => void | Promise<void>
}

type Session<S extends Record<string, unknown>> = {
	flowId: string
	jid: string
	step: string
	state: S
	lastActivityAt: number
	sessionId: string
}

type SendFn = (jid: string, content: unknown, quoted?: WAMessage) => Promise<unknown>

export class FlowManager<S extends Record<string, unknown> = Record<string, unknown>> {
	private flows = new Map<string, FlowDefinition<S>>()
	private sessions = new Map<string, Session<S>>()
	private sendFn: SendFn
	private timeoutCheckers = new Map<string, NodeJS.Timeout>()

	constructor(sendFn: SendFn) {
		this.sendFn = sendFn
	}

	registerFlow(flow: FlowDefinition<S>): this {
		this.flows.set(flow.id, flow)
		return this
	}

	async startFlow(flowId: string, jid: string, msg: WAMessage): Promise<boolean> {
		const flow = this.flows.get(flowId)
		if (!flow) throw new Error(`Flow not found: ${flowId}`)

		const sessionId = `${jid}_${flowId}`
		const session: Session<S> = {
			flowId,
			jid,
			step: flow.initialStep,
			state: { ...(flow.initialState ?? ({} as S)) },
			lastActivityAt: Date.now(),
			sessionId
		}

		this.sessions.set(jid, session)
		this._scheduleTimeout(session, flow)

		const ctx = this._makeCtx(session, msg)
		const step = flow.steps[session.step]
		if (step?.onEnter) {
			await this._executeAction(ctx, await step.onEnter(ctx), flow)
		}

		return true
	}

	async process(msg: WAMessage): Promise<boolean> {
		const jid = msg.key.remoteJid
		if (!jid) return false

		const session = this.sessions.get(jid)
		if (!session) return false

		const flow = this.flows.get(session.flowId)
		if (!flow) return false

		session.lastActivityAt = Date.now()
		this._scheduleTimeout(session, flow)

		const ctx = this._makeCtx(session, msg)
		const step = flow.steps[session.step]

		if (step?.onMessage) {
			await this._executeAction(ctx, await step.onMessage(ctx), flow)
			return true
		}

		return false
	}

	hasActiveSession(jid: string): boolean {
		return this.sessions.has(jid)
	}

	getSession(jid: string): Session<S> | undefined {
		return this.sessions.get(jid)
	}

	endSession(jid: string): void {
		this.sessions.delete(jid)
		const timer = this.timeoutCheckers.get(jid)
		if (timer) {
			clearTimeout(timer)
			this.timeoutCheckers.delete(jid)
		}
	}

	private async _executeAction(ctx: FlowContext<S>, action: FlowAction<S>, flow: FlowDefinition<S>): Promise<void> {
		const session = this.sessions.get(ctx.jid)
		if (!session) return

		if (action.setState) {
			const newState = typeof action.setState === 'function' ? await action.setState(ctx) : action.setState
			session.state = { ...session.state, ...newState }
		}

		if (action.send) {
			const content = typeof action.send === 'function' ? await action.send(ctx) : action.send
			await this.sendFn(ctx.jid, content, ctx.msg)
		}

		if (action.end) {
			await flow.onEnd?.(ctx)
			this.endSession(ctx.jid)
			return
		}

		if (action.next) {
			const nextStep = typeof action.next === 'function' ? await action.next(ctx) : action.next
			session.step = nextStep

			const step = flow.steps[nextStep]
			if (step?.onEnter) {
				const updatedCtx = this._makeCtx(session, ctx.msg)
				await this._executeAction(updatedCtx, await step.onEnter(updatedCtx), flow)
			}
		}
	}

	private _makeCtx(session: Session<S>, msg: WAMessage): FlowContext<S> {
		const text =
			msg.message?.conversation ??
			msg.message?.extendedTextMessage?.text ??
			msg.message?.imageMessage?.caption ??
			msg.message?.videoMessage?.caption ??
			null

		return {
			jid: session.jid,
			msg,
			text,
			state: session.state,
			step: session.step,
			sessionId: session.sessionId
		}
	}

	private _scheduleTimeout(session: Session<S>, flow: FlowDefinition<S>): void {
		const existing = this.timeoutCheckers.get(session.jid)
		if (existing) clearTimeout(existing)

		const timeoutMs = flow.timeoutMs
		if (!timeoutMs) return

		const timer = setTimeout(async () => {
			const s = this.sessions.get(session.jid)
			if (!s) return
			if (Date.now() - s.lastActivityAt >= timeoutMs) {
				await flow.onTimeout?.(this._makeCtx(s, { key: { remoteJid: s.jid } } as WAMessage))
				this.endSession(session.jid)
			}
		}, timeoutMs)

		this.timeoutCheckers.set(session.jid, timer)
	}
}
