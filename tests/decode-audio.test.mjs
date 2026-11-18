import T from '@kmamal/testing'
import Fs from 'node:fs'
import Os from 'node:os'
import M from '../src/javascript/index.js'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { root, fixture, sleep } from './helpers/common.mjs'

const FILES = {
	'sine.mp3': { sampleRate: 44100, length: 44100, codec: 'mp3' },
	'sine.opus': { sampleRate: 48000, length: 48000, codec: 'opus' },
	'sine.webm': { sampleRate: 48000, length: 48000, codec: 'opus' },
	'sine.ogg': { sampleRate: 44100, length: 44100, codec: 'vorbis' },
	'sine.flac': { sampleRate: 44100, length: 44100, codec: 'flac' },
	'sine.m4a': { sampleRate: 44100, length: 44100, codec: 'aac' },
	'sine.wav': { sampleRate: 44100, length: 44100, codec: 'pcm_s16le' },
	'sine24.wav': { sampleRate: 44100, length: 44100, codec: 'pcm_s24le' },
	'sine.aiff': { sampleRate: 44100, length: 44100, codec: 'pcm_s16be' },
	'mulaw.wav': { sampleRate: 8000, length: 8000, codec: 'pcm_mulaw' },
}

const dominantFrequency = (channel, sampleRate) => {
	const samples = channel.subarray(channel.findIndex((x) => Math.abs(x) > 0.01))
	let crossings = 0
	for (let i = 1; i < samples.length; i++) {
		if (samples[i - 1] < 0 && samples[i] >= 0) { crossings++ }
	}
	return crossings * sampleRate / samples.length
}

for (const [ name, { sampleRate, length, codec } ] of Object.entries(FILES)) {
	T.test(`decodeAudio ${name}`, async (t) => {
		t.timeout(10e3)
		if (!M.decoders.includes(codec)) { return }
		const bytes = Fs.readFileSync(fixture(name))

		const native = await M.decodeAudio(bytes)
		t.equal(native.sampleRate, sampleRate)
		t.equal(native.channels.length, 1)
		t.equal(native.channels[0].length, length)
		t.ok(Math.abs(dominantFrequency(native.channels[0], sampleRate) - 440) < 3)

		const resampled = await M.decodeAudio(bytes, { sampleRate: 48000 })
		t.equal(resampled.sampleRate, 48000)
		t.equal(resampled.channels[0].length, Math.round(length * 48000 / sampleRate))
		t.ok(Math.abs(dominantFrequency(resampled.channels[0], 48000) - 440) < 3)
	})
}

T.test("decodeAudio stereo and shared memory", async (t) => {
	t.timeout(10e3)
	const bytes = Fs.readFileSync(fixture('stereo-f32.wav'))
	const shared = new Uint8Array(new SharedArrayBuffer(bytes.length))
	shared.set(bytes)
	const result = await M.decodeAudio(shared, { sampleRate: 22050 })
	t.equal(result.channels.length, 2)
	t.equal(result.channels[0].length, 22050)
})

T.test("decodeAudio errors", async (t) => {
	t.timeout(10e3)
	await t.throwsAsync(() => M.decodeAudio(Buffer.from('nothing to see here')))
	await t.throwsAsync(() => M.decodeAudio(Fs.readFileSync(fixture('vp9.webm'))))
	await t.throwsAsync(() => M.decodeAudio('not a buffer'))
	t.throws(() => M.decodeAudio(Fs.readFileSync(fixture('sine.wav')), { sampleRate: 0 }))
})

T.test("byte source from shared memory", async (t) => {
	t.timeout(10e3)
	const bytes = Fs.readFileSync(fixture('vp9.webm'))
	const shared = new Uint8Array(new SharedArrayBuffer(bytes.length))
	shared.set(bytes)
	const file = await M.open(shared)
	t.equal(file.duration, 2)
	file.close()
})

T.test("decodeAudio rejects output longer than maxLength", async (t) => {
	const bytes = Fs.readFileSync(fixture('sine.wav'))
	const decoded = await M.decodeAudio(bytes, { sampleRate: 48000, maxLength: 48000 })
	t.equal(decoded.channels[0].length, 48000)
	await t.throwsAsync(() => M.decodeAudio(bytes, { sampleRate: 48000, maxLength: 47999 }))
	t.throws(() => M.decodeAudio(bytes, { sampleRate: 8000, maxLength: 0 }))
})

T.test("decodeAudio start and end", async (t) => {
	t.timeout(10e3)
	for (const name of [ 'sine.mp3', 'sine.ogg', 'stereo-f32.wav', 'sine.webm', 'unknown-duration.mkv' ]) {
		const bytes = Fs.readFileSync(fixture(name))
		for (const sampleRate of [ undefined, 48000 ]) {
			const full = await M.decodeAudio(bytes, { sampleRate })
			const rate = full.sampleRate
			const length = full.channels[0].length
			for (const [ start, end ] of [ [ 0.25, 0.5 ], [ 0.3, undefined ], [ 0, 0.1 ], [ 0.9, 5 ], [ 2, 3 ] ]) {
				const part = await M.decodeAudio(bytes, { sampleRate, start, end })
				const to = end === undefined ? length : Math.min(Math.round(end * rate), length)
				const from = Math.min(Math.round(start * rate), to)
				t.equal(part.channels.length, full.channels.length)
				part.channels.forEach((channel, index) => {
					t.equal(channel, full.channels[index].subarray(from, to), { name, sampleRate, start, end })
				})
			}
		}
	}
})

T.test("decodeAudio start and end with maxLength, and decodeAudioInterleaved", async (t) => {
	t.timeout(10e3)
	const bytes = Fs.readFileSync(fixture('stereo-f32.wav'))
	const part = await M.decodeAudio(bytes, { sampleRate: 48000, start: 0.5, end: 0.75, maxLength: 12000 })
	t.equal(part.channels[0].length, 12000)
	await t.throwsAsync(() => M.decodeAudio(bytes, { sampleRate: 48000, start: 0.5, end: 0.75, maxLength: 11999 }))
	await t.throwsAsync(() => M.decodeAudio(bytes, { sampleRate: 48000, start: 0.5, maxLength: 23999 }))
	const interleaved = await M.decodeAudioInterleaved(bytes, { sampleRate: 48000, start: 0.5, end: 0.75 })
	t.equal(interleaved.data.length, 24000)
	t.equal(interleaved.data[0], part.channels[0][0])
	t.equal(interleaved.data[1], part.channels[1][0])
	t.throws(() => M.decodeAudio(bytes, { sampleRate: 48000, start: -1 }))
	t.throws(() => M.decodeAudio(bytes, { sampleRate: 48000, start: 0.5, end: 0.5 }))
	t.throws(() => M.decodeAudio(bytes, { sampleRate: 48000, end: Infinity }))
})

T.test("decodeAudio from a path, a URL and a byte source", async (t) => {
	t.timeout(10e3)
	const bytes = Fs.readFileSync(fixture('stereo-f32.wav'))
	const expected = await M.decodeAudio(bytes, { sampleRate: 48000, start: 0.25, end: 0.5 })
	const fromPath = await M.decodeAudio(fixture('stereo-f32.wav'), { sampleRate: 48000, start: 0.25, end: 0.5 })
	const fromUrl = await M.decodeAudio(pathToFileURL(fixture('stereo-f32.wav')), { sampleRate: 48000, start: 0.25, end: 0.5 })
	t.equal(fromPath.channels, expected.channels)
	t.equal(fromUrl.channels, expected.channels)

	const source = M.createByteSource({ size: bytes.length })
	const promise = M.decodeAudio(source, { sampleRate: 48000, start: 0.25, end: 0.5 })
	for (let offset = 0; offset < bytes.length; offset += 4096) {
		await sleep(1)
		source.push(offset, bytes.subarray(offset, offset + 4096))
	}
	source.end()
	t.equal((await promise).channels, expected.channels)
	source.close()

	await t.throwsAsync(() => M.decodeAudio(fixture('missing.wav')))
	t.throws(() => M.decodeAudio(new URL('https://example.com/a.wav')))
	const failing = M.createByteSource()
	const failed = M.decodeAudio(failing)
	failing.fail('network down')
	await t.throwsAsync(() => failed)
	failing.close()
	t.throws(() => M.decodeAudio(failing))
})

const readerSamples = async (name, sampleRate) => {
	const file = await M.open(fixture(name))
	const reader = file.tracks.find((x) => x.type === 'audio').createReader({ sampleRate })
	const channels = Array.from({ length: reader.channels }, () => [])
	for (;;) {
		const block = await reader.readChannels(0.3)
		if (!block) { break }
		block.channels.forEach((samples, index) => { channels[index].push(...samples) })
	}
	file.close()
	return channels.map((samples) => Float32Array.from(samples))
}

for (const [ name, codec ] of [
	...Object.entries(FILES).map(([ key, value ]) => [ key, value.codec ]),
	[ 'stereo-f32.wav', 'pcm_f32le' ],
	[ 'late-audio.mkv', 'pcm_s16le' ],
	[ 'late-video.webm', 'opus' ],
	[ 'short-audio.webm', 'opus' ],
]) {
	T.test(`decodeAudio matches an audio reader for ${name}`, async (t) => {
		t.timeout(10e3)
		if (!M.decoders.includes(codec)) { return }
		const bytes = Fs.readFileSync(fixture(name))
		for (const sampleRate of [ undefined, 48000 ]) {
			const decoded = await M.decodeAudio(bytes, { sampleRate })
			const channels = await readerSamples(name, decoded.sampleRate)
			t.equal(channels, decoded.channels, { name, sampleRate })
		}
	})
}

T.test("decodeAudio fills in a track that starts late", async (t) => {
	t.timeout(10e3)
	const { sampleRate, channels } = await M.decodeAudio(fixture('late-audio.mkv'))
	const start = Math.round(0.25 * sampleRate)
	t.equal(channels[0].length, sampleRate)
	t.ok(channels[0].subarray(0, start).every((x) => x === 0))
	t.ok(channels[0].subarray(start).some((x) => Math.abs(x) > 0.1))
})

T.test("decodeAudio places vorbis samples at their timestamps", async (t) => {
	t.timeout(10e3)
	const { sampleRate, channels } = await M.decodeAudio(fixture('chirp.ogg'))
	const signal = (time) => 0.4 * Math.sin(2 * Math.PI * (200 + 40 * time) * time)
	let error = 0
	for (let i = sampleRate; i < 2 * sampleRate; i++) { error = Math.max(error, Math.abs(channels[0][i] - signal(i / sampleRate))) }
	t.ok(error < 0.05, { error })
})

T.test("decodeAudio seeks to start", async (t) => {
	t.timeout(10e3)
	const bytes = Fs.readFileSync(fixture('chirp.ogg'))
	for (const sampleRate of [ undefined, 48000 ]) {
		const full = await M.decodeAudio(bytes, { sampleRate })
		const rate = full.sampleRate
		for (const [ start, end ] of [ [ 2, 2.5 ], [ 2.37, undefined ], [ 5, 6 ] ]) {
			const part = await M.decodeAudio(bytes, { sampleRate, start, end })
			const length = full.channels[0].length
			const to = end === undefined ? length : Math.min(Math.round(end * rate), length)
			const from = Math.min(Math.round(start * rate), to)
			t.equal(part.channels[0], full.channels[0].subarray(from, to), { sampleRate, start, end })
		}
	}
})

T.test("an audio reader matches decodeAudio after a seek back", async (t) => {
	t.timeout(10e3)
	const { sampleRate, channels } = await M.decodeAudio(fixture('chirp.ogg'))
	const file = await M.open(fixture('chirp.ogg'))
	const reader = file.tracks.find((x) => x.type === 'audio').createReader()
	await reader.readChannels(2.5)
	const segment = file.seek(1.5)
	let block
	do { block = await reader.readChannels(0.5) } while (block.segment !== segment)
	const from = Math.round(block.timestamp * sampleRate)
	t.equal(block.channels[0], channels[0].subarray(from, from + block.frames))
	file.close()
})

const LONG_DECODE = `
	const { parentPort } = require('node:worker_threads')
	const M = require(${JSON.stringify(`${root}/src/javascript/index.js`)})
	const frames = 600 * 44100
	const bytes = Buffer.alloc(44 + frames * 2)
	bytes.write('RIFF', 0)
	bytes.writeUInt32LE(36 + frames * 2, 4)
	bytes.write('WAVEfmt ', 8)
	bytes.writeUInt32LE(16, 16)
	bytes.writeUInt16LE(1, 20)
	bytes.writeUInt16LE(1, 22)
	bytes.writeUInt32LE(44100, 24)
	bytes.writeUInt32LE(88200, 28)
	bytes.writeUInt16LE(2, 32)
	bytes.writeUInt16LE(16, 34)
	bytes.write('data', 36)
	bytes.writeUInt32LE(frames * 2, 40)
	const source = M.createByteSource({ size: bytes.length })
	source.push(0, bytes)
	source.end()
`

const runWorker = (script) => {
	const worker = new Worker(script, { eval: true })
	const started = new Promise((resolve) => { worker.once('message', resolve) })
	const exited = new Promise((resolve) => {
		worker.once('exit', () => { resolve(performance.now()) })
	})
	return { worker, started, exited }
}

T.test("decodeAudio can be aborted", async (t) => {
	t.timeout(10e3)
	const bytes = Fs.readFileSync(fixture('sine.wav'))
	t.throwsWith(() => M.decodeAudio(bytes, { signal: {} }), (error) => { t.ok(error instanceof TypeError) })

	const reason = new Error("stop")
	const source = M.createByteSource({ size: bytes.length })
	await t.throwsWithAsync(() => M.decodeAudio(source, { signal: AbortSignal.abort(reason) }), (error) => { t.equal(error, reason) })
	t.equal(source.closed, true)

	const waiting = M.createByteSource({ size: bytes.length })
	waiting.push(0, bytes.subarray(0, 4096))
	const controller = new AbortController()
	const promise = M.decodeAudio(waiting, { signal: controller.signal })
	await sleep(20)
	controller.abort(reason)
	await t.throwsWithAsync(() => promise, (error) => { t.equal(error, reason) })
	t.equal(waiting.closed, true)

	const done = await M.decodeAudio(bytes, { signal: new AbortController().signal })
	t.equal(done.channels[0].length, 44100)

	const queued = Array.from({ length: Os.availableParallelism() }, () => M.decodeAudio(bytes))
	const last = new AbortController()
	const aborted = M.decodeAudio(bytes, { signal: last.signal })
	last.abort(reason)
	await t.throwsWithAsync(() => aborted, (error) => { t.equal(error, reason) })
	t.ok((await Promise.all(queued)).every((result) => result.channels[0].length === 44100))
	t.equal((await M.decodeAudio(bytes)).channels[0].length, 44100)
})

T.test("an aborted decode stops decoding", async (t) => {
	t.timeout(20e3)
	const time = async (abort) => {
		const { started, exited } = runWorker(`${LONG_DECODE}
			const controller = new AbortController()
			M.decodeAudio(bytes, { sampleRate: 48000, signal: controller.signal }).catch(() => {})
			M.decodeAudio(source, { sampleRate: 48000, signal: controller.signal }).catch(() => {})
			parentPort.postMessage(0)
			if (${abort}) { setTimeout(() => { controller.abort() }, 20) }
		`)
		await started
		const from = performance.now()
		return await exited - from
	}
	const full = await time(false)
	const aborted = await time(true)
	t.ok(aborted < full / 4, { full, aborted })
})

T.test("terminating a worker stops its decodes", async (t) => {
	t.timeout(20e3)
	const { worker, started } = runWorker(`${LONG_DECODE}
		M.decodeAudio(bytes, { sampleRate: 48000 })
		M.decodeAudio(source, { sampleRate: 48000 })
		parentPort.postMessage(0)
	`)
	await started
	await sleep(20)
	const from = performance.now()
	await worker.terminate()
	t.ok(performance.now() - from < 100, performance.now() - from)
	await sleep(1500)
})

T.test("decodeAudio track option", async (t) => {
	t.timeout(10e3)
	const expected = (await M.decodeAudio(fixture('sine.wav'))).channels[0]
	const maxDifference = (a, b) => a.reduce((max, x, i) => Math.max(max, Math.abs(x - b[i])), 0)
	const first = (await M.decodeAudio(fixture('two-audio.mov'))).channels[0]
	const second = (await M.decodeAudio(fixture('two-audio.mov'), { track: 1 })).channels[0]
	t.ok(maxDifference(first, expected) < 1e-3)
	t.ok(maxDifference(second, expected.map((x) => -x)) < 1e-3)
	t.ok(maxDifference((await M.decodeAudio(fixture('two-audio.mov'), { track: 0 })).channels[0], expected) < 1e-3)
	t.ok((await M.decodeAudio(fixture('late-audio.mkv'))).channels[0].length > 0)
	for (const track of [ 0, 5 ]) {
		await t.throwsWithAsync(() => M.decodeAudio(fixture('late-audio.mkv'), { track }), (error) => {
			t.equal(error.message, `unable to decode audio data: track ${track} is not an audio track`)
		})
	}
	for (const track of [ -1, 1.5, '1' ]) {
		t.throwsWith(() => M.decodeAudio(fixture('sine.wav'), { track }), (error) => { t.ok(error instanceof TypeError) })
	}
})

const threadCount = () => Number(Fs.readFileSync('/proc/self/status', 'utf8').match(/^Threads:\s+(?<count>\d+)/mu).groups.count)

T.test("many decodes share a bounded set of threads", async (t) => {
	t.timeout(30e3)
	const bytes = Fs.readFileSync(fixture('sine.mp3'))
	const count = 200
	const before = process.platform === 'linux' ? threadCount() : 0
	const promises = Array.from({ length: count }, () => M.decodeAudio(bytes))
	if (process.platform === 'linux') {
		const started = threadCount() - before
		t.ok(started <= Os.availableParallelism(), { started })
	}
	const results = await Promise.all(promises)
	t.ok(results.every((result) => result.channels[0].length === 44100))
})
