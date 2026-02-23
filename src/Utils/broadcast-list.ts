import type { WAMessage } from '../Types'

export type BroadcastRecipient = {
        jid: string
        alias?: string
}

export type BroadcastList = {
        id: string
        name: string
        recipients: BroadcastRecipient[]
        createdAt: Date
}

export type BroadcastResult = {
        jid: string
        success: boolean
        messageId?: string
        error?: Error
}

type SendFn<T> = (jid: string, content: T, options?: Record<string, unknown>) => Promise<WAMessage | undefined>

export class BroadcastListManager<T = unknown> {
        private lists: Map<string, BroadcastList> = new Map()
        private sendFn: SendFn<T>

        constructor(sendFn: SendFn<T>) {
                this.sendFn = sendFn
        }

        createList(name: string, recipients: BroadcastRecipient[] = []): BroadcastList {
                const id = `bcast_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
                const list: BroadcastList = { id, name, recipients, createdAt: new Date() }
                this.lists.set(id, list)
                return list
        }

        deleteList(id: string): boolean {
                return this.lists.delete(id)
        }

        getList(id: string): BroadcastList | undefined {
                return this.lists.get(id)
        }

        getLists(): BroadcastList[] {
                return Array.from(this.lists.values())
        }

        addRecipient(listId: string, recipient: BroadcastRecipient): void {
                const list = this._getOrThrow(listId)
                const exists = list.recipients.some(r => r.jid === recipient.jid)
                if (!exists) list.recipients.push(recipient)
        }

        removeRecipient(listId: string, jid: string): void {
                const list = this._getOrThrow(listId)
                list.recipients = list.recipients.filter(r => r.jid !== jid)
        }

        renameList(id: string, name: string): void {
                const list = this._getOrThrow(id)
                list.name = name
        }

        async broadcast(
                listId: string,
                content: T,
                options?: {
                        delayBetweenMs?: number
                        sendOptions?: Record<string, unknown>
                        onProgress?: (result: BroadcastResult, index: number, total: number) => void
                }
        ): Promise<BroadcastResult[]> {
                const list = this._getOrThrow(listId)
                const results: BroadcastResult[] = []
                const delay = options?.delayBetweenMs ?? 500

                for (let i = 0; i < list.recipients.length; i++) {
                        const recipient = list.recipients[i]!
                        try {
                                const msg = await this.sendFn(recipient.jid, content, options?.sendOptions)
                                const result: BroadcastResult = { jid: recipient.jid, success: true, messageId: msg?.key?.id ?? undefined }
                                results.push(result)
                                options?.onProgress?.(result, i, list.recipients.length)
                        } catch (error) {
                                const result: BroadcastResult = { jid: recipient.jid, success: false, error: error as Error }
                                results.push(result)
                                options?.onProgress?.(result, i, list.recipients.length)
                        }

                        if (i < list.recipients.length - 1 && delay > 0) {
                                await new Promise(r => setTimeout(r, delay))
                        }
                }

                return results
        }

        async broadcastToJids(
                jids: string[],
                content: T,
                options?: {
                        delayBetweenMs?: number
                        sendOptions?: Record<string, unknown>
                        onProgress?: (result: BroadcastResult, index: number, total: number) => void
                }
        ): Promise<BroadcastResult[]> {
                const list = this.createList('_temp', jids.map(jid => ({ jid })))
                const results = await this.broadcast(list.id, content, options)
                this.deleteList(list.id)
                return results
        }

        private _getOrThrow(id: string): BroadcastList {
                const list = this.lists.get(id)
                if (!list) throw new Error(`Broadcast list not found: ${id}`)
                return list
        }
}
