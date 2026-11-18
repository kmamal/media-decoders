const { bindings, pinned } = require('./common')
const { Emitter } = require('./events')


const { feedHeaderSize, videoFeedHeaderSize, feedUserSize } = bindings
const feedSize = feedHeaderSize + feedUserSize
const videoFeedSize = videoFeedHeaderSize + feedUserSize
const privateFeeds = new WeakSet()

const feedView = (feed) => {
	if (!(feed instanceof SharedArrayBuffer) || (feed.byteLength !== feedSize && feed.byteLength !== videoFeedSize && !privateFeeds.has(feed))) {
		throw new TypeError("not a feed")
	}
	return new Uint8Array(feed)
}

const createFeed = () => {
	const feed = new SharedArrayBuffer(feedSize)
	bindings.initFeed(new Uint8Array(feed))
	return feed
}

const createVideoFeed = () => {
	const feed = new SharedArrayBuffer(videoFeedSize)
	bindings.initVideoFeed(new Uint8Array(feed))
	return feed
}

const createPrivateFeed = () => {
	const feed = new SharedArrayBuffer(feedHeaderSize)
	bindings.initFeed(new Uint8Array(feed))
	privateFeeds.add(feed)
	return feed
}

const createPrivateVideoFeed = () => {
	const feed = new SharedArrayBuffer(videoFeedHeaderSize)
	bindings.initVideoFeed(new Uint8Array(feed))
	privateFeeds.add(feed)
	return feed
}

const getFeedUserData = (feed) => {
	feedView(feed)
	const offset = feed.byteLength === videoFeedSize ? videoFeedHeaderSize : feedHeaderSize
	return new Uint8Array(feed, offset, feedUserSize)
}

const getPosition = (feed, lagFrames = 0) => bindings.position(feedView(feed), lagFrames)

const readRate = (options) => {
	if (options === undefined) { return 1 }
	if (options === null || typeof options !== 'object') { throw new TypeError("options must be an object") }
	return options.rate ?? 1
}


const readChannelCount = (value, name) => {
	if (!Number.isInteger(value)) { throw new TypeError(`${name} must be an integer`) }
	return value
}

class NativeReader extends Emitter {
	constructor () {
		super([ 'close' ])
		this._waiters = []
		this._error = null
		this.closed = false
	}

	get ended () { return this._native.ended }

	get error () {
		const failure = this._native.error
		if (!failure) { return null }
		if (this._error?.errno !== failure.code || this._error.message !== failure.message) {
			const error = new Error(failure.message)
			error.fatal = true
			error.errno = failure.code
			this._error = error
		}
		return this._error
	}

	_waitUntil (test) {
		if (this.closed || test()) { return Promise.resolve() }
		return new Promise((resolve) => {
			this._waiters.push({ test, resolve })
			pinned.add(this)
			this._native.wait(true)
			this._check()
		})
	}

	_check () {
		if (this._waiters.length === 0) { return }
		const waiters = this._waiters
		this._waiters = []
		for (const waiter of waiters) {
			if (this.closed || waiter.test()) { waiter.resolve() }
			else { this._waiters.push(waiter) }
		}
		if (this.closed) { return }
		if (this._waiters.length === 0) {
			pinned.delete(this)
			this._native.wait(false)
			return
		}
		this._native.wait(true)
		if (this._waiters.some(({ test }) => test())) { this._check() }
	}

	close () {
		if (this.closed) { return }
		this._native.wait(false)
		this.closed = true
		pinned.delete(this)
		this._native.close()
		this._closed()
		this._check()
		this._retire(() => new Error("the reader is closed"))
		this._tryEmit('close', { type: 'close' })
	}

	_closed () {}
}

class FeedReader extends NativeReader {
	constructor (feed, options = {}) {
		const { sampleRate, channels, maxChannels, buffer = 1 } = options
		if (!Number.isInteger(sampleRate)) { throw new TypeError("sampleRate must be an integer") }
		if (channels !== undefined && maxChannels !== undefined) { throw new TypeError("channels and maxChannels can't both be set") }
		const fixed = channels !== undefined
		const count = fixed ? readChannelCount(channels, 'channels') : readChannelCount(maxChannels ?? 8, 'maxChannels')
		if (typeof buffer !== 'number') { throw new TypeError("buffer must be a number") }
		super()
		const ref = new WeakRef(this)
		this._native = new bindings.FeedReader(feedView(feed), sampleRate, count, fixed, buffer, () => { ref.deref()?._check() })
		this.sampleRate = sampleRate
	}

	get channels () { return this._native.channels }

	readInto (channels, options) {
		const rate = readRate(options)
		if (this.closed) {
			for (const channel of channels) { channel.fill(0) }
			return 0
		}
		return this._native.read(channels, rate)
	}

	wait (count, options) {
		const frames = count ?? 128
		const rate = readRate(options)
		return this._waitUntil(() => this._native.ready(frames, rate))
	}
}

const createFeedReader = (feed, options) => new FeedReader(feed, options)


const FORMATS = [ 'rgba', 'yuv420p', 'gray' ]

const readPosition = (position) => {
	if (position === null || typeof position !== 'object') { throw new TypeError("position must be an object") }
	const { file, segment, time } = position
	if (typeof time !== 'number' || !Number.isFinite(time)) { throw new TypeError("time must be a finite number") }
	if (file !== undefined && typeof file !== 'number') { throw new TypeError("file must be a number") }
	if (segment !== undefined && !Number.isInteger(segment)) { throw new TypeError("segment must be an integer") }
	return { file, segment, time }
}

const readDimension = (value, name) => {
	if (!Number.isInteger(value) || value <= 0) { throw new TypeError(`${name} must be a positive integer`) }
	return value
}

class VideoFeedReader extends NativeReader {
	constructor (feed, options) {
		if (options === null || typeof options !== 'object') { throw new TypeError("options must be an object") }
		const { format, frames = 4 } = options
		if (!FORMATS.includes(format)) { throw new TypeError(`invalid format: ${format}`) }
		const width = readDimension(options.width, 'width')
		const height = readDimension(options.height, 'height')
		if (!Number.isInteger(frames) || frames < 2) { throw new TypeError("frames must be an integer of at least 2") }
		super()
		const layout = bindings.frameLayout(format, width, height)
		this._slots = []
		for (let i = 0; i < frames; i++) {
			const buffer = new SharedArrayBuffer(layout.size)
			const planes = layout.planes.map(({ offset, stride, height: planeHeight }) => new Uint8Array(buffer, offset, stride * planeHeight))
			this._slots.push({ buffer, planes })
		}
		this._leased = new Map()
		this._current = null
		const ref = new WeakRef(this)
		this._native = new bindings.VideoFeedReader(feedView(feed), format, width, height, this._slots.map(({ buffer }) => new Uint8Array(buffer)), () => { ref.deref()?._check() })
		this.format = format
		this.width = width
		this.height = height
	}

	_frame (raw) {
		const { planes } = this._slots[raw.slot]
		const frame = {
			width: this.width,
			height: this.height,
			displayWidth: raw.displayWidth,
			displayHeight: raw.displayHeight,
			format: this.format,
			planes,
			timestamp: raw.timestamp,
			duration: raw.duration,
			segment: raw.segment,
			file: raw.file,
			transfer: raw.transfer,
		}
		if (planes.length === 1) { frame.data = planes[0] }
		if (this.format !== 'rgba') {
			frame.matrix = raw.matrix
			frame.fullRange = raw.fullRange
		}
		Object.defineProperty(frame, '_slot', { value: raw.slot })
		this._leased.set(raw.slot, frame)
		return frame
	}

	next () {
		if (this.closed) { return null }
		const raw = this._native.next()
		return raw ? this._frame(raw) : null
	}

	_at (position) {
		const { file, segment, time } = position
		const raw = this._native.at(file, segment, time)
		if (raw.frame?.slot !== this._current?._slot) {
			if (this._current) { this._leased.delete(this._current._slot) }
			this._current = raw.frame ? this._frame(raw.frame) : null
		}
		return raw
	}

	at (position) {
		const parsed = readPosition(position)
		if (this.closed) { return { frame: null, ended: false } }
		const { ended } = this._at(parsed)
		return { frame: this._current, ended }
	}

	release (frame) {
		if (!frame || this._leased.get(frame._slot) !== frame) { return }
		this._leased.delete(frame._slot)
		if (this._current === frame) { this._current = null }
		if (this.closed) { return }
		this._native.release(frame._slot)
	}

	wait (position) {
		if (position === undefined) { return this._waitUntil(() => this._native.ready()) }
		const parsed = readPosition(position)
		return this._waitUntil(() => {
			const { ended, settled } = this._at(parsed)
			return ended || settled || !this._native.attached || this.error !== null
		})
	}

	_closed () {
		this._leased.clear()
		this._current = null
	}
}

const createVideoFeedReader = (feed, options) => new VideoFeedReader(feed, options)

module.exports = {
	feedView,
	createFeed,
	createVideoFeed,
	createPrivateFeed,
	createPrivateVideoFeed,
	getFeedUserData,
	getPosition,
	FeedReader,
	createFeedReader,
	VideoFeedReader,
	createVideoFeedReader,
}
