const { feedView, createPrivateVideoFeed, VideoFeedReader } = require('./feed')
const { Emitter } = require('./events')

const FORMATS = [ 'rgba', 'yuv420p', 'gray' ]


const validateOptions = (options) => {
	const { format = 'rgba', threads = 0 } = options
	if (!FORMATS.includes(format)) { throw new Error(`invalid format: ${format}`) }
	if (!(Number.isInteger(threads) && threads >= 0)) { throw new TypeError("threads must be a non-negative integer") }
}


class VideoReader extends Emitter {
	constructor (file, track, options = {}) {
		super([ 'close' ])
		validateOptions(options)
		const format = options.format ?? 'rgba'
		const swap = track.rotation % 180 !== 0
		const width = options.width ?? (swap ? track.height : track.width)
		const height = options.height ?? (swap ? track.width : track.height)
		const frames = Math.max(2, options.frames ?? 4)
		const threads = options.threads ?? 0
		if (file.closed) { throw new Error("the file is closed") }

		this._file = file
		this._track = track
		this.format = format
		this.width = width
		this.height = height
		this._closed = false
		this._feed = createPrivateVideoFeed()
		this._reader = new VideoFeedReader(this._feed, { format, width, height, frames })
		try {
			file._native.attach(track.index, feedView(this._feed), threads)
		}
		catch (error) {
			this._reader.close()
			throw error
		}
	}

	get closed () { return this._closed || this._file.closed }

	get ended () { return this.closed || this._reader.ended }

	tryRead () {
		if (this.closed || this._reader._native.seeking) { return null }
		return this._reader.next()
	}

	release (frame) {
		this._reader.release(frame)
	}

	wait () {
		return this._reader._waitUntil(() => this._reader._native.ready() && !this._reader._native.seeking)
	}

	_throwIfFailed () {
		this._file._poll()
		const error = this._reader.error
		if (!error) { return }
		const errors = this._file._fatalErrors
		throw errors.get(this._track.index) ?? errors.get(-1) ?? error
	}

	async read () {
		for (;;) {
			const frame = this.tryRead()
			if (frame) { return frame }
			if (this.closed) { return null }
			if (this.ended) {
				this._throwIfFailed()
				return null
			}
			await this.wait()
		}
	}

	close () {
		if (this._closed) { return }
		this._closed = true
		this._track._reader = null
		if (!this._file.closed) { this._file._native.disableTrack(this._track.index) }
		this._check(true)
		this._emitClose()
	}

	_emitClose () {
		if (this._closeEmitted) { return }
		this._closeEmitted = true
		this._retire(() => new Error("the reader is closed"))
		this._tryEmit('close', { type: 'close' })
	}

	_check (force = false) {
		if (force) { this._reader.close() }
	}
}

module.exports = { VideoReader, validateOptions }
