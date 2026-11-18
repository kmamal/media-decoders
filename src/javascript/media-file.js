const { bindings, pinned } = require('./common')
const { Emitter } = require('./events')
const { parseSource } = require('./byte-source')
const { feedView } = require('./feed')
const { VideoReader } = require('./video-reader')
const { AudioReader } = require('./audio-reader')


class Track {
	constructor (file, { seekPreroll, ...info }) {
		Object.assign(this, info)
		Object.defineProperty(this, '_file', { value: file })
		Object.defineProperty(this, '_seekPreroll', { value: seekPreroll ?? null })
		Object.defineProperty(this, '_reader', { value: null, writable: true })
		Object.defineProperty(this, '_feed', { value: null, writable: true })
	}

	_claim () {
		if (this._reader || this._feed) { throw new Error("track already has a reader") }
		if (!this.decodable) { throw new Error(`no decoder for ${this.codec}`) }
	}

	createReader (options) {
		return this._createReader(options)
	}

	_createReader (options, buffer) {
		this._claim()
		this._file._fatalErrors.delete(this.index)
		if (this.type === 'video') {
			this._reader = new VideoReader(this._file, this, options)
		}
		else if (this.type === 'audio') {
			if (this._file.closed) { throw new Error("the file is closed") }
			this._reader = new AudioReader(this._file, this, options, buffer)
		}
		else {
			throw new Error(`unsupported track type: ${this.type}`)
		}
		return this._reader
	}
}


class MediaFile extends Emitter {
	constructor (native, source) {
		super([ 'decodeError', 'close' ])
		this._native = native
		this.id = native.id
		this._source = source
		this._feeds = new Set()
		this._loop = false
		this.closed = false
		this._fatalErrors = new Map()
		this._openErrors = null
		this.duration = 0
		this.startTime = 0
		this.format = null
		this.tracks = []
		this._lastSegment = 0
	}

	get lastSegment () {
		if (this.closed) { return this._lastSegment }
		return this._native.lastSegment()
	}

	_init () {
		const info = this._native.info()
		this.duration = info.duration
		this.startTime = info.startTime
		this.format = info.format
		this.tracks = info.tracks.map((track) => new Track(this, track))
	}

	_pin () {
		if (!this.closed && (this._feeds.size > 0)) { pinned.add(this) }
		else { pinned.delete(this) }
	}

	_reportErrors (errors) {
		for (const { message, fatal, track } of errors) {
			const error = new Error(message)
			error.fatal = fatal
			error.track = this.tracks[track] ?? null
			if (fatal && !this._fatalErrors.has(track)) { this._fatalErrors.set(track, error) }
			this._tryEmit('decodeError', { type: 'decodeError', error })
		}
	}

	_deferOpenErrors (errors) {
		if (errors.length === 0) { return }
		this._openErrors = errors
		setImmediate(() => { this._flushOpenErrors() })
	}

	_flushOpenErrors () {
		const errors = this._openErrors
		if (!errors) { return }
		this._openErrors = null
		this._reportErrors(errors)
	}

	_onEvents (events) {
		this._flushOpenErrors()
		this._reportErrors(events.errors)
		for (const track of this.tracks) { track._reader?._check() }
	}

	_poll () {
		if (this.closed) { return }
		this._onEvents(this._native.takeEvents())
	}

	get loop () { return this._loop }
	setLoop (loop) {
		if (typeof loop !== 'boolean') { throw new TypeError("loop must be a boolean") }
		this._loop = loop
		if (this.closed) { return }
		this._native.setLoop(this._loop)
		for (const track of this.tracks) { track._reader?._check() }
	}

	seek (time) {
		if (this.closed) { return -1 }
		return this._native.seek(time)
	}

	attach (feed, track) {
		if (track === undefined || track === null) {
			if (this.closed) { throw new Error("the file is closed") }
			const generation = this._native.attach(-1, feedView(feed))
			this._feeds.add(feed)
			this._pin()
			return generation
		}
		if (!(track instanceof Track) || track._file !== this) { throw new TypeError("track must be one of the file's tracks") }
		track._claim()
		if (track.type !== 'audio' && track.type !== 'video') { throw new Error("only audio and video tracks can be attached to a feed") }
		if (this.closed) { throw new Error("the file is closed") }
		const generation = this._native.attach(track.index, feedView(feed))
		track._feed = feed
		this._feeds.add(feed)
		this._pin()
		return generation
	}

	detach (feed) {
		const view = feedView(feed)
		for (const track of this.tracks) {
			if (track._feed === feed) { track._feed = null }
		}
		this._feeds.delete(feed)
		this._pin()
		if (this.closed) { return }
		this._native.detach(view)
	}

	close () {
		if (this.closed) { return }
		for (const track of this.tracks) { track._reader?._check(true) }
		this._lastSegment = this._native.lastSegment()
		this.closed = true
		this._feeds.clear()
		this._pin()
		this._native.close()
		for (const track of this.tracks) { track._reader?._emitClose() }
		this._source?.close()
		this._retire(() => new Error("the file is closed"))
		this._tryEmit('close', { type: 'close' })
	}
}


const open = (source, options = {}) => {
	const { maxQueuedBytes = 64 * 1024 * 1024 } = options
	if (typeof maxQueuedBytes !== 'number' || !(maxQueuedBytes > 0)) { throw new TypeError("maxQueuedBytes must be a positive number or Infinity") }
	const parsed = parseSource(source)
	return openParsed(parsed, maxQueuedBytes)
}

const openParsed = (parsed, maxQueuedBytes) => new Promise((resolve, reject) => {
	let { byteSource } = parsed

	let opening = null
	let file = null
	const native = new bindings.File(parsed.input, () => {
		if (!opening) {
			file?.deref()?._poll()
			return
		}
		const events = opening.native.takeEvents()
		if (!events.opened) { return }
		const { native: opened } = opening
		opening = null
		opened.unref()
		if (events.open !== null) {
			opened.close()
			byteSource?.close()
			byteSource = null
			reject(new Error(events.open))
			return
		}
		const result = new MediaFile(opened, byteSource)
		byteSource = null
		file = new WeakRef(result)
		result._init()
		resolve(result)
		result._deferOpenErrors(events.errors)
	}, maxQueuedBytes)
	opening = { native }
	native.ref()
})

module.exports = { open }
