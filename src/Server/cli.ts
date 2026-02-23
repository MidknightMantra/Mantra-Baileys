#!/usr/bin/env node
import { ApiServer } from './api.js'
import { SessionManager } from '../Utils/session-manager.js'
import pino from 'pino'

const port = parseInt(process.env.PORT ?? '5000', 10)
const host = process.env.HOST ?? '0.0.0.0'
const apiKey = process.env.API_KEY

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' })

const manager = new SessionManager({}, logger)
const server = new ApiServer(manager, { port, host, apiKey }, logger)

server.start()

async function shutdown() {
	const sessions = manager.listSessions()
	await Promise.all(sessions.map(s => manager.destroySession(s.id)))
	process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
