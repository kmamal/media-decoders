const { feedView, createPrivateFeed, FeedReader } = require('./feed')
const { Emitter } = require('./events')

const CHUNK_FRAMES = 16384
const BUFFER_FRAMES = 4 * CHUNK_FRAMES


class AudioReader extends Emitter {
	constructor (file, track, options = {}, buffer = BUFFER_FRAMES) {
		super([ 'close' ])
		const sampleRate = options.sampleRate ?? track.sampleRate
		if (!(Number.isInteger(sampleRate) && sampleRate >= 3000 && sampleRate <= 768000)) {
			throw new TypeError("sampleRate must be an integer between 3000 and 768000")
		}
		this._file = file
		this._track = track
		this.sampleRate = sampleRate
		this.channels = Math.max(1, track.channels)
		this._closed = false
		this._feed = createPrivateFeed()
		file._native.attach(track.index, feedView(this._feed))
		this._reader = new FeedReader(this._feed, { sampleRate, maxChannels: this.channels, buffer: buffer / sampleRate })
	}

	get closed () { return this._closed || this._file.closed }

	get ended () { return this.closed || this._reader.ended }

	readChannels (duration = 1) {
		return this._readDuration(duration, false)
	}

	readInterleaved (duration = 1) {
		return this._readDuration(duration, true)
	}

	readChannelsInto (channels) {
		if (!Array.isArray(channels) || channels.length === 0 || !channels.every((x) => x instanceof Float32Array)) {
			throw new TypeError("channels must be an array of Float32Arrays")
		}
		return this._readInto(Math.min(...channels.map((x) => x.length)), channels, false)
	}

	readInterleavedInto (data) {
		if (!(data instanceof Float32Array)) { throw new TypeError("data must be a Float32Array") }
		return this._readInto(Math.floor(data.length / this.channels), data, true)
	}

	_readDuration (duration, interleaved) {
		if (!(typeof duration === 'number' && Number.isFinite(duration) && duration > 0)) {
			throw new TypeError("duration must be a positive number")
		}
		return this._read(Math.max(1, Math.round(duration * this.sampleRate)), null, interleaved)
	}

	_readInto (frames, out, interleaved) {
		if (frames <= 0) { throw new RangeError("the block must hold at least one frame") }
		return this._read(frames, out, interleaved)
	}

	_view (block, offset, interleaved) {
		if (offset === 0) { return block }
		return interleaved
			? block.subarray(offset * this.channels)
			: block.map((channel) => channel.subarray(offset))
	}

	_throwIfFailed () {
		this._file._poll()
		const error = this._reader.error
		if (!error) { return }
		const errors = this._file._fatalErrors
		throw errors.get(this._track.index) ?? errors.get(-1) ?? error
	}

	async _read (frames, out, interleaved) {
		for (;;) {
			if (this.closed) { return null }
			if (this._reader._native.seeking) {
				await this._reader._waitUntil(() => !this._reader._native.seeking)
				continue
			}
			if (this.ended) {
				this._throwIfFailed()
				return null
			}
			const block = out ?? (interleaved
				? new Float32Array(frames * this.channels)
				: Array.from({ length: this.channels }, () => new Float32Array(frames)))
			let filled = 0
			let entry = -1
			let timestamp = 0
			let segment = -1
			while (filled < frames) {
				const wanted = Math.min(frames - filled, CHUNK_FRAMES)
				await this._reader.wait(wanted)
				if (this.closed) { return null }
				const raw = this._reader._native.readBlock(this._view(block, filled, interleaved), this.channels, entry)
				if (filled === 0) {
					entry = raw.entry
					timestamp = raw.timestamp
					segment = raw.segment
				}
				filled += raw.frames
				if (raw.frames < wanted) { break }
			}
			if (filled > 0) {
				let samples = block
				if (!out && filled < frames) {
					samples = interleaved
						? block.subarray(0, filled * this.channels)
						: block.map((channel) => channel.subarray(0, filled))
				}
				const result = interleaved
					? { data: samples, channels: this.channels }
					: { channels: samples }
				result.frames = filled
				result.timestamp = timestamp
				result.segment = segment
				return result
			}
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

module.exports = { AudioReader }
