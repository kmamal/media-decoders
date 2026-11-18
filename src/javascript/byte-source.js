const { bindings } = require('./common')
const { Emitter } = require('./events')


class ByteSource extends Emitter {
	constructor (options = {}) {
		super([ 'request', 'drain', 'close' ])
		const {
			size,
			randomAccess = false,
			aheadLimit = 16 * 1024 * 1024,
			behindLimit = 4 * 1024 * 1024,
		} = options

		this._drainWaiters = []
		const ref = new WeakRef(this)
		this._native = new bindings.ByteSource({
			size: Number.isFinite(size) ? size : undefined,
			randomAccess: Boolean(randomAccess),
			aheadLimit,
			behindLimit,
		}, () => { ref.deref()?._onNotify() })
		this.randomAccess = Boolean(randomAccess)
		this.closed = false
	}

	_onNotify () {
		if (this.closed) { return }
		const { request, space } = this._native.takeEvents()
		if (space || request !== null) { this._resolveDrain() }
		if (space) { this._tryEmit('drain', { type: 'drain' }) }
		if (request !== null) { this._tryEmit('request', { type: 'request', offset: request }) }
	}

	_resolveDrain () {
		const waiters = this._drainWaiters
		this._drainWaiters = []
		for (const resolve of waiters) { resolve() }
	}

	push (offset, bytes) {
		if (this.closed) { return false }
		const view = ArrayBuffer.isView(bytes)
			? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
			: new Uint8Array(bytes)
		return this._native.push(offset, view)
	}

	drain () {
		if (this.closed) { return Promise.resolve() }
		return new Promise((resolve) => { this._drainWaiters.push(resolve) })
	}

	restart (offset) {
		if (this.closed) { return }
		this._native.restart(offset)
		this._resolveDrain()
	}

	end () {
		if (this.closed) { return }
		this._native.end()
	}

	fail (message) {
		if (this.closed) { return }
		this._native.fail(String(message || 'error'))
	}

	setSize (size) {
		if (this.closed) { return }
		this._native.setSize(size)
	}

	get size () {
		if (this.closed) { return null }
		const size = this._native.size()
		return size < 0 ? null : size
	}

	get bufferedRanges () {
		if (this.closed) { return [] }
		return this._native.bufferedRanges()
	}

	close () {
		if (this.closed) { return }
		this.closed = true
		this._native.close()
		this._resolveDrain()
		this._retire(() => new Error("the byte source is closed"))
		this._tryEmit('close', { type: 'close' })
	}
}

const createByteSource = (options) => new ByteSource(options)


const parseSource = (source) => {
	if (typeof source === 'string') { return { input: source, byteSource: null } }
	if (source instanceof URL) {
		if (source.protocol !== 'file:') { throw new TypeError("only file: URLs can be opened by path") }
		return { input: require('node:url').fileURLToPath(source), byteSource: null }
	}
	if (source instanceof ByteSource) {
		if (source.closed) { throw new Error("the byte source is closed") }
		return { input: source._native, byteSource: source }
	}
	if (source instanceof ArrayBuffer || source instanceof SharedArrayBuffer) {
		return { input: new Uint8Array(source), byteSource: null }
	}
	if (ArrayBuffer.isView(source)) {
		return { input: new Uint8Array(source.buffer, source.byteOffset, source.byteLength), byteSource: null }
	}
	throw new TypeError("source must be a path, a buffer or a byte source")
}

module.exports = { ByteSource, createByteSource, parseSource }
