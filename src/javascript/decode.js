const Os = require('node:os')
const { parseSource } = require('./byte-source')
const { open } = require('./media-file')
const { validateOptions } = require('./video-reader')


const checkTrack = (track) => {
	if (track !== undefined && !(Number.isInteger(track) && track >= 0)) {
		throw new TypeError("track must be a non-negative integer")
	}
}

const DECODE_LIMIT = Os.availableParallelism()
const DECODE_BUFFER_FRAMES = 1 << 20
const DECODE_CHUNK_FRAMES = 65536

let decodesRunning = 0
const decodesWaiting = []

const acquireDecode = (cancelled) => {
	if (decodesRunning < DECODE_LIMIT) {
		decodesRunning++
		return Promise.resolve()
	}
	return new Promise((resolve, reject) => {
		const entry = { resolve, reject }
		decodesWaiting.push(entry)
		cancelled.then((reason) => {
			const index = decodesWaiting.indexOf(entry)
			if (index === -1) { return }
			decodesWaiting.splice(index, 1)
			reject(reason)
		})
	})
}

const releaseDecode = () => {
	const next = decodesWaiting.shift()
	if (next) {
		next.resolve()
		return
	}
	decodesRunning--
}

const audioError = (message) => new Error(`unable to decode audio data: ${message}`)

const audioTrack = (file, index) => {
	if (index !== undefined) {
		const track = file.tracks[index]
		if (track?.type !== 'audio') { throw audioError(`track ${index} is not an audio track`) }
		if (!track.decodable) { throw audioError(`no decoder for ${track.codec}`) }
		return track
	}
	const tracks = file.tracks.filter((track) => track.type === 'audio')
	if (tracks.length === 0) { throw audioError("no audio track") }
	const track = tracks.find((x) => x.decodable)
	if (!track) { throw audioError(`no decoder for ${tracks[0].codec}`) }
	return track
}

class AudioOutput {
	constructor (channels, interleaved, capacity) {
		this._channels = channels
		this._interleaved = interleaved
		this._width = interleaved ? channels : 1
		this._buffers = Array.from({ length: interleaved ? 1 : channels }, () => new ArrayBuffer(capacity * this._width * 4))
		this._capacity = capacity
		this.frames = 0
	}

	views (count) {
		if (this.frames === this._capacity) {
			this._capacity = Math.max(this.frames + count, this._capacity * 2)
			this._buffers = this._buffers.map((buffer) => buffer.transfer(this._capacity * this._width * 4))
		}
		const length = Math.min(count, this._capacity - this.frames)
		return this._buffers.map((buffer) => new Float32Array(buffer, this.frames * this._width * 4, length * this._width))
	}

	result () {
		const buffers = this._buffers.map((buffer) => this.frames === this._capacity ? buffer : buffer.transfer(this.frames * this._width * 4))
		const arrays = buffers.map((buffer) => new Float32Array(buffer))
		return this._interleaved
			? { data: arrays[0], channels: this._channels }
			: { channels: arrays }
	}
}

const readTrack = async (file, options, interleaved) => {
	const { track: index, sampleRate, maxLength, start, end } = options
	const track = audioTrack(file, index)
	const rate = sampleRate ?? track.sampleRate
	const first = Math.round(start * rate)
	const last = end === undefined ? Infinity : Math.max(first, Math.round(end * rate))
	const tooLong = (frames) => maxLength !== undefined && Math.min(frames, end === undefined ? Infinity : end * rate) - start * rate > maxLength

	const duration = track.duration ?? (file.duration > 0 ? file.duration : 0)
	if (tooLong(duration * rate)) { throw audioError("the decoded audio is too long") }

	const expected = duration > 0 ? Math.max(0, Math.ceil(Math.min(duration * rate, last) - first)) : 0
	const reader = track._createReader({ sampleRate: rate }, Math.min(DECODE_BUFFER_FRAMES, Math.max(DECODE_CHUNK_FRAMES, expected)))
	const { channels } = reader
	const output = new AudioOutput(channels, interleaved, expected || DECODE_CHUNK_FRAMES)
	let segment = 0
	if (track._seekPreroll !== null) {
		const time = Math.floor(start - track._seekPreroll)
		if (time > 0 && time < duration) { segment = file.seek(time) }
	}

	const read = (into) => {
		if (!into) {
			return interleaved
				? reader.readInterleaved(DECODE_CHUNK_FRAMES / rate)
				: reader.readChannels(DECODE_CHUNK_FRAMES / rate)
		}
		return interleaved
			? reader.readInterleavedInto(into[0])
			: reader.readChannelsInto(into)
	}

	let position = null
	while (position === null || position < last) {
		const direct = position !== null && position >= first
		let block
		try {
			block = await read(direct ? output.views(Math.min(DECODE_CHUNK_FRAMES, last - position)) : null)
		}
		catch (error) {
			if (position === null) { throw audioError(error.message) }
			break
		}
		if (!block) {
			if (position !== null || segment === 0) { break }
			segment = file.seek(0)
			continue
		}
		if (direct) {
			output.frames += block.frames
		}
		else {
			if (block.segment < segment) { continue }
			position ??= Math.round(block.timestamp * rate)
			const from = Math.max(0, first - position)
			const to = Math.min(block.frames, last - position)
			if (to > from) {
				const views = output.views(to - from)
				if (interleaved) { views[0].set(block.data.subarray(from * channels, to * channels)) }
				else { views.forEach((view, i) => { view.set(block.channels[i].subarray(from, to)) }) }
				output.frames += to - from
			}
		}
		position += block.frames
		if (tooLong(position)) { throw audioError("the decoded audio is too long") }
	}
	if (position === null) { throw audioError("no audio data") }
	return { sampleRate: rate, ...output.result() }
}

const runDecodeAudio = (source, options, interleaved) => {
	const { track, sampleRate, maxLength, start = 0, end, signal } = options
	checkTrack(track)
	if (sampleRate !== undefined && sampleRate !== null && !(Number.isInteger(sampleRate) && sampleRate >= 3000 && sampleRate <= 768000)) {
		throw new TypeError("sampleRate must be an integer between 3000 and 768000")
	}
	if (maxLength !== undefined && !(Number.isSafeInteger(maxLength) && maxLength > 0)) {
		throw new TypeError("maxLength must be a positive integer")
	}
	if (!(Number.isFinite(start) && start >= 0)) {
		throw new TypeError("start must be a non-negative number")
	}
	if (end !== undefined && !(Number.isFinite(end) && end > start)) {
		throw new TypeError("end must be a number greater than start")
	}
	if (signal !== undefined && !(signal instanceof AbortSignal)) {
		throw new TypeError("signal must be an AbortSignal")
	}
	const { byteSource } = parseSource(source)
	if (signal?.aborted) {
		byteSource?.close()
		return Promise.reject(signal.reason)
	}

	let file = null
	let aborted = false
	let onAbort = null
	const cancelled = new Promise((resolve) => {
		onAbort = () => {
			aborted = true
			byteSource?.close()
			file?.close()
			resolve(signal.reason)
		}
		signal?.addEventListener('abort', onAbort, { once: true })
	})

	const run = async () => {
		if (!byteSource) { await acquireDecode(cancelled) }
		try {
			try {
				file = await open(source)
			}
			catch (error) {
				throw audioError(error.message)
			}
			if (aborted) { file.close() }
			return await readTrack(file, { track, sampleRate: sampleRate ?? undefined, maxLength, start, end }, interleaved)
		}
		finally {
			file?.close()
			byteSource?.close()
			if (!byteSource) { releaseDecode() }
		}
	}

	const result = run()
	if (!signal) { return result }
	return Promise.race([ result, cancelled.then((reason) => { throw reason }) ])
		.finally(() => { signal.removeEventListener('abort', onAbort) })
}

const decodeAudio = (source, options = {}) => runDecodeAudio(source, options, false)

const decodeAudioInterleaved = (source, options = {}) => runDecodeAudio(source, options, true)


const videoTrack = (file, index) => {
	if (index !== undefined) {
		const track = file.tracks[index]
		if (track?.type !== 'video') { throw new Error(`track ${index} is not a video track`) }
		return track
	}
	const tracks = file.tracks.filter((track) => track.type === 'video')
	if (tracks.length === 0) { throw new Error("no video track") }
	const track = tracks.find((x) => x.decodable)
	if (!track) { throw new Error(`no decoder for ${tracks[0].codec}`) }
	return track
}

const iterateFrames = async function * (source, track, start, end, options) {
	const file = await open(source)
	try {
		const reader = videoTrack(file, track).createReader(options)
		const segment = start > 0 ? file.seek(start) : 0
		for (;;) {
			const frame = await reader.read()
			if (!frame) { return }
			if (frame.segment < segment) {
				reader.release(frame)
				continue
			}
			if (end !== undefined && frame.timestamp >= end) { return }
			yield frame
			reader.release(frame)
		}
	}
	finally {
		file.close()
	}
}

const decodeVideo = (source, options = {}) => {
	const { track, start = 0, end, ...readerOptions } = options
	checkTrack(track)
	if (!(Number.isFinite(start) && start >= 0)) { throw new TypeError("start must be a non-negative number") }
	if (end !== undefined && !(Number.isFinite(end) && end > start)) {
		throw new TypeError("end must be a number greater than start")
	}
	validateOptions(readerOptions)
	parseSource(source)
	return iterateFrames(source, track, start, end, readerOptions)
}

const decodeFrame = (source, time = 0, options = {}) => {
	if (!(Number.isFinite(time) && time >= 0)) { throw new TypeError("time must be a non-negative number") }
	const { track, ...readerOptions } = options
	checkTrack(track)
	validateOptions(readerOptions)
	parseSource(source)
	return firstFrame(source, track, time, readerOptions)
}

const firstFrame = async (source, track, time, readerOptions) => {
	const iterator = iterateFrames(source, track, time, undefined, { ...readerOptions, frames: 2 })
	try {
		const { value } = await iterator.next()
		return value ?? null
	}
	finally {
		await iterator.return()
	}
}

module.exports = { decodeAudio, decodeAudioInterleaved, decodeVideo, decodeFrame }
