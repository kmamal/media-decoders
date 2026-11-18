import T from '@kmamal/testing'
import Fs from 'node:fs'
import M from '../src/javascript/index.js'
import { fixture } from './helpers/common.mjs'

const corrupt = (name, at) => {
	const bytes = new Uint8Array(Fs.readFileSync(fixture(name)))
	const offset = Math.floor(bytes.length * at)
	for (let i = 0; i < 24; i++) { bytes[offset + i] ^= 0xff }
	return bytes
}

const settle = () => new Promise((resolve) => { setImmediate(resolve) })

T.test("emitters accept only their own events", async (t) => {
	const file = await M.open(fixture('vp9.webm'))
	t.throws(() => file.on('nope', () => {}), /invalid event/u)
	t.throws(() => file.on('request', () => {}), /invalid event/u)
	file.on('decodeError', () => {})
	file.on('close', () => {})
	file.on('error', () => {})
	const source = M.createByteSource()
	t.throws(() => source.on('decodeError', () => {}), /invalid event/u)
	source.on('request', () => {})
	source.on('drain', () => {})
	source.close()
	file.close()
})

T.test("closing a file emits close on it and on its readers", async (t) => {
	const file = await M.open(fixture('short-audio.webm'))
	const events = []
	file.on('*', (type, event) => { events.push([ 'file', type, event.type ]) })
	const video = file.tracks.find((x) => x.type === 'video').createReader()
	const audio = file.tracks.find((x) => x.type === 'audio').createReader()
	video.on('close', (event) => { events.push([ 'video', event.type ]) })
	audio.on('close', (event) => { events.push([ 'audio', event.type ]) })
	file.close()
	file.close()
	video.close()
	t.equal(events, [
		[ 'video', 'close' ],
		[ 'audio', 'close' ],
		[ 'file', 'close', 'close' ],
	])
	t.throws(() => file.on('close', () => {}), /closed/u)
	t.throws(() => video.on('close', () => {}), /closed/u)
	await settle()
	t.equal(file.listenerCount('*'), 0)
	t.equal(video.listenerCount('close'), 0)
})

T.test("closing a reader emits close once", async (t) => {
	const file = await M.open(fixture('vp9.webm'))
	const reader = file.tracks[0].createReader({ format: 'gray' })
	let closes = 0
	reader.on('close', () => { closes += 1 })
	reader.close()
	reader.close()
	file.close()
	t.equal(closes, 1)
})

T.test("decode errors are emitted as decodeError events", async (t) => {
	t.timeout(10e3)
	const file = await M.open(corrupt('vp8.webm', 0.8))
	const events = []
	file.on('decodeError', (event) => { events.push(event) })
	const reader = file.tracks.find((x) => x.type === 'video').createReader({ format: 'gray' })
	let frame
	while ((frame = await reader.read())) { reader.release(frame) }
	t.ok(events.length > 0)
	for (const { type, error } of events) {
		t.equal(type, 'decodeError')
		t.ok(error instanceof Error)
		t.equal(error.fatal, false)
	}
	file.close()
})

T.test("a throwing listener is re-emitted as an error event", async (t) => {
	t.timeout(10e3)
	const file = await M.open(corrupt('sine.opus', 0.3))
	const thrown = new Error("from listener")
	const errors = []
	file.on('decodeError', () => { throw thrown })
	file.on('error', (error) => { errors.push(error) })
	await settle()
	t.ok(errors.length > 0)
	t.ok(errors.every((error) => error === thrown))
	file.close()
})

T.test("loop is read-only and set with setLoop()", async (t) => {
	const file = await M.open(fixture('sine.wav'))
	t.equal(file.loop, false)
	t.throws(() => { file.loop = true })
	file.setLoop(true)
	t.equal(file.loop, true)
	for (const value of [ 1, 'true', null, undefined ]) {
		t.throws(() => file.setLoop(value), /loop must be a boolean/u)
	}
	t.equal(file.loop, true)
	file.setLoop(false)
	t.equal(file.loop, false)
	file.close()
})

T.test("byte source size and buffered ranges", (t) => {
	const source = M.createByteSource()
	t.equal(source.size, null)
	t.equal(source.bufferedRanges, [])
	source.push(0, new Uint8Array(100))
	source.push(200, new Uint8Array(50))
	t.equal(source.bufferedRanges, [ [ 0, 100 ], [ 200, 250 ] ])
	source.end()
	t.equal(source.size, 250)
	source.setSize(1000)
	t.equal(source.size, 1000)
	t.equal(M.createByteSource({ size: 42 }).size, 42)
	let closes = 0
	source.on('close', () => { closes += 1 })
	source.close()
	source.close()
	t.equal(closes, 1)
	t.equal(source.size, null)
	t.equal(source.bufferedRanges, [])
	t.throws(() => source.on('drain', () => {}), /closed/u)
})

T.test("byte source emits drain once it has room again", async (t) => {
	t.timeout(10e3)
	const bytes = Fs.readFileSync(fixture('sine.wav'))
	const source = M.createByteSource({ size: bytes.length, randomAccess: true, aheadLimit: 16 * 1024, behindLimit: 4 * 1024 })
	const events = []
	let offset = 0
	const pushMore = () => {
		while (offset < bytes.length) {
			const more = source.push(offset, bytes.subarray(offset, offset + 4096))
			offset += 4096
			if (!more) { return }
		}
		source.end()
	}
	source.on('drain', (event) => {
		events.push(event)
		pushMore()
	})
	source.on('request', () => {})
	pushMore()
	const file = await M.open(source)
	const reader = file.tracks[0].createReader()
	while (await reader.readChannels()) { continue }
	t.ok(events.length > 0)
	t.equal(events[0], { type: 'drain' })
	file.close()
})

T.test("feed readers emit close", (t) => {
	const reader = M.createFeedReader(M.createFeed(), { sampleRate: 48000 })
	const videoReader = M.createVideoFeedReader(M.createVideoFeed(), { format: 'gray', width: 4, height: 4 })
	const events = []
	reader.on('*', (type) => { events.push([ 'audio', type ]) })
	videoReader.on('*', (type) => { events.push([ 'video', type ]) })
	reader.close()
	videoReader.close()
	reader.close()
	t.equal(events, [ [ 'audio', 'close' ], [ 'video', 'close' ] ])
})
