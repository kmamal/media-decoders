const { EventEmitter } = require('node:events')

const commonEvents = [ 'newListener', 'removeListener', 'error', '*' ]
const metaEvents = [ 'newListener', 'removeListener' ]


class Emitter extends EventEmitter {
	constructor (validEvents) {
		super()
		this._validEvents = validEvents
		this._internalListeners = new Set()
		this._makeRetiredError = null

		const onNewListener = (type) => {
			if (this._makeRetiredError) { throw this._makeRetiredError() }
			if (!commonEvents.includes(type) && !validEvents.includes(type)) {
				throw Object.assign(new Error("invalid event"), { type })
			}
		}
		this._internalListeners.add(onNewListener)
		this.on('newListener', onNewListener)
	}

	_retire (makeError) {
		this._makeRetiredError = makeError
		process.nextTick(() => { this.removeAllListeners() })
	}

	_tryEmit (type, event) {
		try { this.emit(type, event) }
		catch (error) {
			if (type === 'error') {
				rethrow(error)
				return
			}
			try { this.emit('error', error) }
			catch (error2) { rethrow(error2) }
		}
	}

	removeAllListeners (type) {
		if (type === undefined) {
			const types = this.eventNames().filter((name) => name !== 'removeListener')
			for (const eventType of [ ...types, 'removeListener' ]) {
				this.removeAllListeners(eventType)
			}
			return this
		}

		if (!metaEvents.includes(type)) {
			super.removeAllListeners(type)
			return this
		}

		for (const listener of this.listeners(type)) {
			if (this._internalListeners.has(listener)) { continue }
			this.removeListener(type, listener)
		}
		return this
	}

	emit (type, ...args) {
		const isCommon = commonEvents.includes(type)
		if (!isCommon && !this._validEvents.includes(type)) {
			throw Object.assign(new Error("invalid event"), { type })
		}

		let hadListeners = super.emit(type, ...args)
		if (!isCommon) {
			hadListeners = super.emit('*', type, ...args) || hadListeners
		}
		return hadListeners
	}
}

const rethrow = (error) => {
	process.nextTick(() => { throw error })
}

module.exports = { Emitter }
