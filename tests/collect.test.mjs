import T from '@kmamal/testing'
import M from '../src/javascript/index.js'
import { fixture, root, sleep } from './helpers/common.mjs'
import Fs from 'node:fs'
import V8 from 'node:v8'
import Vm from 'node:vm'
import { spawnSync } from 'node:child_process'

V8.setFlagsFromString('--expose-gc')
const gc = Vm.runInNewContext('gc')

const collect = async (done = () => false) => {
	for (let i = 0; i < 50 && !done(); i++) {
		gc()
		await sleep(5)
	}
}

const tracker = () => {
	const counts = {}
	const registry = new FinalizationRegistry((key) => { counts[key] = (counts[key] ?? 0) + 1 })
	const track = (value, key) => {
		registry.register(value, key)
		return value
	}
	return { counts, track }
}

T.test("unclosed files, feed readers and byte sources are collected", async (t) => {
	t.timeout(20e3)
	const { counts, track } = tracker()
	const create = async () => {
		for (let i = 0; i < 20; i++) {
			track(await M.open(fixture('sine.wav')), 'file')
			track(M.createFeedReader(M.createFeed(), { sampleRate: 44100 }), 'reader')
			track(M.createByteSource(), 'source')
		}
	}
	await create()
	await collect(() => counts.file === 20 && counts.reader === 20 && counts.source === 20)
	t.equal(counts, { file: 20, reader: 20, source: 20 })
})

T.test("a collected feed reader frees its feed", async (t) => {
	t.timeout(10e3)
	const feed = M.createFeed()
	const { counts, track } = tracker()
	track(M.createFeedReader(feed, { sampleRate: 44100 }), 'reader')
	await collect(() => counts.reader === 1)
	const reader = M.createFeedReader(feed, { sampleRate: 44100 })
	t.ok(!reader.closed)
	reader.close()
})

const sine = (seconds, rate = 44100) => {
	const frames = seconds * rate
	const bytes = Buffer.alloc(44 + frames * 2)
	bytes.write('RIFF', 0)
	bytes.writeUInt32LE(36 + frames * 2, 4)
	bytes.write('WAVEfmt ', 8)
	bytes.writeUInt32LE(16, 16)
	bytes.writeUInt16LE(1, 20)
	bytes.writeUInt16LE(1, 22)
	bytes.writeUInt32LE(rate, 24)
	bytes.writeUInt32LE(rate * 2, 28)
	bytes.writeUInt16LE(2, 32)
	bytes.writeUInt16LE(16, 34)
	bytes.write('data', 36)
	bytes.writeUInt32LE(frames * 2, 40)
	for (let i = 0; i < frames; i++) {
		bytes.writeInt16LE(Math.round(Math.sin(i / rate * 2 * Math.PI * 440) * 16000), 44 + i * 2)
	}
	return bytes
}

const settled = (promise) => {
	const state = { done: false }
	promise.then(() => { state.done = true })
	return state
}

T.test("a file is kept while a video read waits on it", async (t) => {
	t.timeout(10e3)
	const bytes = Fs.readFileSync(fixture('late-video.webm'))
	const split = Math.floor(bytes.length * 0.8)
	const source = M.createByteSource({ size: bytes.length })
	source.push(0, bytes.subarray(0, split))
	const start = async () => {
		const file = await M.open(source)
		const reader = file.tracks.find((x) => x.type === 'video').createReader({ format: 'gray' })
		for (let i = 0; i < 4; i++) { reader.release(await reader.read()) }
		return { waiting: reader.read() }
	}
	const { waiting } = await start()
	const state = settled(waiting)
	await collect()
	t.equal(state.done, false)
	source.push(split, bytes.subarray(split))
	source.end()
	const frame = await waiting
	t.ok(frame !== null)
})

T.test("a feed reader is kept while it waits", async (t) => {
	t.timeout(10e3)
	const bytes = sine(10)
	const split = 44 + 6 * 44100 * 2
	const source = M.createByteSource({ size: bytes.length })
	source.push(0, bytes.subarray(0, split))
	const file = await M.open(source)
	const feed = M.createFeed()
	file.attach(feed, file.tracks[0])
	const start = async () => {
		const reader = M.createFeedReader(feed, { sampleRate: 44100, buffer: 2 })
		const channels = [ new Float32Array(4410) ]
		let frames = 0
		while (frames < 44100 * 5.5) {
			await reader.wait(4410)
			frames += reader.readInto(channels)
		}
		return { waiting: reader.wait(32768).then(() => reader) }
	}
	const { waiting } = await start()
	const state = settled(waiting)
	await collect()
	t.equal(state.done, false)
	source.push(split, bytes.subarray(split))
	source.end()
	const reader = await waiting
	t.equal(reader.readInto([ new Float32Array(32768) ]), 32768)
	reader.close()
	file.close()
})

T.test("a file is kept while it is attached to a feed", async (t) => {
	t.timeout(10e3)
	const feed = M.createFeed()
	const { counts, track } = tracker()
	const attach = async () => {
		const file = track(await M.open(fixture('sine.wav')), 'file')
		file.setLoop(true)
		file.attach(feed, file.tracks[0])
		return new WeakRef(file)
	}
	const file = await attach()
	await collect()
	const reader = M.createFeedReader(feed, { sampleRate: 44100 })
	const channels = [ new Float32Array(4410) ]
	let frames = 0
	while (frames < 44100 * 2.5) {
		await reader.wait(4410)
		gc()
		const count = reader.readInto(channels)
		if (count === 0) { break }
		frames += count
	}
	t.ok(frames >= 44100 * 2.5, frames)
	t.equal(counts.file, undefined)
	file.deref().detach(feed)
	await collect(() => counts.file === 1)
	t.equal(counts.file, 1)
	reader.close()
})

T.test("decodeAudio closes its byte source", async (t) => {
	t.timeout(10e3)
	const bytes = Fs.readFileSync(fixture('sine.wav'))
	const source = M.createByteSource({ size: bytes.length })
	source.push(0, bytes)
	source.end()
	const result = await M.decodeAudio(source)
	t.equal(result.channels[0].length, 44100)
	t.ok(source.closed)
})

T.test("decodeAudio keeps its byte source while it decodes", async (t) => {
	t.timeout(10e3)
	const bytes = sine(10)
	const decode = () => {
		const source = M.createByteSource({ size: bytes.length })
		source.push(0, bytes)
		source.end()
		return M.decodeAudio(source)
	}
	const decoding = decode()
	const timer = setInterval(gc, 1)
	const result = await decoding
	clearInterval(timer)
	t.equal(result.channels[0].length, 441000)
})

T.test("an unclosed byte source does not hold the process at exit", (t) => {
	t.timeout(20e3)
	const script = "require('./src/javascript/index.js').createByteSource()"
	const { status, signal } = spawnSync(process.execPath, [ '-e', script ], { cwd: root, timeout: 10e3 })
	t.equal({ status, signal }, { status: 0, signal: null })
})
