import T from '@kmamal/testing'
import Fs from 'node:fs'
import { Worker } from 'node:worker_threads'
import M from '../src/javascript/index.js'
import { root, fixture, sleep, near, multichannelWav } from './helpers/common.mjs'

const readFeed = async (reader, options = {}) => {
	const { limit = Infinity, block = 128, rate = 1, onBlock } = options
	const channels = [ new Float32Array(block), new Float32Array(block) ]
	const chunks = []
	let length = 0
	while (length < limit) {
		const size = Math.min(block, limit - length)
		await reader.wait(size, { rate })
		const count = reader.readInto(channels.map((channel) => channel.subarray(0, size)), { rate })
		if (count > 0) {
			chunks.push(channels[0].slice(0, count))
			length += count
		}
		onBlock?.(count)
		if (reader.ended) { break }
		if (count === 0) { await sleep(1) }
	}
	const result = new Float32Array(length)
	let offset = 0
	for (const chunk of chunks) {
		result.set(chunk, offset)
		offset += chunk.length
	}
	return result
}

const maxDifference = (a, b, offset = 0) => {
	let max = 0
	const length = Math.min(a.length, b.length - offset)
	for (let i = 0; i < length; i++) { max = Math.max(max, Math.abs(a[i] - b[i + offset])) }
	return max
}

const peak = (samples, from = 0, to = samples.length) => {
	let max = 0
	for (let i = from; i < to; i++) { max = Math.max(max, Math.abs(samples[i])) }
	return max
}

const attachAudio = async (name, options) => {
	const file = await M.open(fixture(name), options)
	const feed = M.createFeed()
	file.attach(feed, file.tracks.find((track) => track.type === 'audio'))
	return { file, feed }
}

for (const [ name, codec, sampleRate ] of [
	[ 'sine.wav', 'pcm_s16le', 44100 ],
	[ 'sine.wav', 'pcm_s16le', 48000 ],
	[ 'sine.ogg', 'vorbis', 44100 ],
	[ 'sine.webm', 'opus', 48000 ],
	[ 'sine.mp3', 'mp3', 48000 ],
	[ 'sine.m4a', 'aac', 44100 ],
]) {
	T.test(`feed matches decodeAudio for ${name} at ${sampleRate}`, async (t) => {
		t.timeout(10e3)
		if (!M.decoders.includes(codec)) { return }
		const expected = await M.decodeAudio(Fs.readFileSync(fixture(name)), { sampleRate })
		const { file, feed } = await attachAudio(name)
		const reader = M.createFeedReader(feed, { sampleRate })
		const samples = await readFeed(reader)
		t.equal(reader.channels, 1)
		t.equal(samples.length, expected.channels[0].length)
		t.ok(maxDifference(samples, expected.channels[0]) < 1e-3)
		t.ok(reader.ended)
		await sleep(20)
		const position = M.getPosition(feed)
		t.ok(position.ended)
		t.equal(position.segment, 0)
		t.ok(near(position.time, 1, 1e-3))
		reader.close()
		file.close()
	})
}

T.test("feed loops gaplessly", async (t) => {
	t.timeout(10e3)
	const expected = await M.decodeAudio(Fs.readFileSync(fixture('sine.wav')))
	const { file, feed } = await attachAudio('sine.wav')
	file.setLoop(true)
	const reader = M.createFeedReader(feed, { sampleRate: 44100 })
	const samples = await readFeed(reader, { limit: 44100 * 2.5 })
	t.equal(samples.length, 44100 * 2.5)
	const reference = expected.channels[0]
	for (let i = 0; i < 3; i++) {
		const part = samples.subarray(i * 44100, (i + 1) * 44100)
		t.equal(maxDifference(part, reference), 0)
	}
	const position = M.getPosition(feed)
	t.equal(position.segment, 2)
	t.ok(near(position.time, 0.5, 0.01))
	t.ok(!position.ended)
	reader.close()
	file.close()
})

const loopedSamples = (reference, rate, length) => {
	const result = new Float32Array(length)
	const size = reference.length
	let position = 0
	let end = size
	for (let i = 0; i < length; i++) {
		if (Math.floor(position) >= end) {
			position = end
			end += size
		}
		const index = Math.floor(position)
		const fraction = position - index
		const a = reference[index % size]
		result[i] = fraction > 0 && index + 1 < end
			? a + (reference[(index + 1) % size] - a) * fraction
			: a
		position += rate
	}
	return result
}

const checkWholeBlocks = async (t, reader, expected, block, rate = 1) => {
	const channels = [ new Float32Array(block) ]
	let short = 0
	let difference = 0
	for (let offset = 0; offset + block <= expected.length; offset += block) {
		await reader.wait(block, { rate })
		if (reader.readInto(channels, { rate }) !== block) { short += 1 }
		difference = Math.max(difference, maxDifference(channels[0], expected.subarray(offset, offset + block)))
	}
	t.equal(short, 0)
	t.ok(difference < 1e-6, difference)
}

for (const rate of [ 1, 1.5 ]) {
	T.test(`feed reads whole blocks across a loop wrap at rate ${rate}`, async (t) => {
		t.timeout(10e3)
		const reference = (await M.decodeAudio(Fs.readFileSync(fixture('sine.wav')))).channels[0]
		const { file, feed } = await attachAudio('sine.wav')
		file.setLoop(true)
		const reader = M.createFeedReader(feed, { sampleRate: 44100 })
		await checkWholeBlocks(t, reader, loopedSamples(reference, rate, Math.round(44100 * 2.5 / rate)), 128, rate)
		reader.close()
		file.close()
	})
}

T.test("feed waits for the next loop from a slow writer", async (t) => {
	t.timeout(20e3)
	const bytes = Fs.readFileSync(fixture('sine.wav'))
	const reference = (await M.decodeAudio(bytes)).channels[0]
	let generation = 0
	let source = null
	const load = async (offset) => {
		const current = ++generation
		source.restart(offset)
		for (let position = offset; position < bytes.length; position += 512) {
			await sleep(1)
			if (current !== generation) { return }
			if (!source.push(position, bytes.subarray(position, position + 512))) { await source.drain() }
		}
		if (current === generation) { source.end() }
	}
	source = M.createByteSource({
		size: bytes.length,
		randomAccess: true,
		behindLimit: 1024,
		aheadLimit: 1024,
	})
	source.on('request', ({ offset }) => { load(offset) })
	load(0)
	const file = await M.open(source)
	const feed = M.createFeed()
	file.attach(feed, file.tracks[0])
	file.setLoop(true)
	const reader = M.createFeedReader(feed, { sampleRate: 44100, buffer: 2 })
	await checkWholeBlocks(t, reader, loopedSamples(reference, 1, 44100 * 2.5), 32768)
	reader.close()
	file.close()
})

T.test("feed gives one short read at a channel-count change", async (t) => {
	t.timeout(10e3)
	const { file, feed } = await attachAudio('channel-change.mp3')
	const reader = M.createFeedReader(feed, { sampleRate: 44100 })
	const channels = [ new Float32Array(100), new Float32Array(100) ]
	const short = []
	let length = 0
	for (;;) {
		await reader.wait(100)
		const count = reader.readInto(channels)
		if (reader.ended) { break }
		if (count !== 100) {
			short.push({ count, channels: reader.channels })
			t.equal(peak(channels[0], count), 0)
		}
		length += count
	}
	t.equal(short.length, 1)
	t.equal(short[0].channels, 1)
	t.ok(short[0].count > 0 && short[0].count < 100, short[0])
	t.equal(reader.channels, 2)
	t.ok(length > 44100 * 0.9, length)
	reader.close()
	file.close()
})

T.test("feed stops at the end of the current loop", async (t) => {
	t.timeout(10e3)
	const { file, feed } = await attachAudio('sine.wav')
	file.setLoop(true)
	const reader = M.createFeedReader(feed, { sampleRate: 44100 })
	await readFeed(reader, { limit: 44100 * 1.2 })
	await sleep(50)
	file.setLoop(false)
	await sleep(50)
	const rest = await readFeed(reader)
	t.equal(rest.length, Math.round(44100 * 0.8))
	await sleep(20)
	const position = M.getPosition(feed)
	t.ok(position.ended)
	t.equal(position.segment, 1)
	t.ok(near(position.time, 1, 1e-3))
	reader.close()
	file.close()
})

T.test("feed position follows a loop shorter than the log", async (t) => {
	t.timeout(10e3)
	const frames = 500
	const wav = Buffer.alloc(44 + frames * 2)
	wav.write('RIFF', 0)
	wav.writeUInt32LE(36 + frames * 2, 4)
	wav.write('WAVEfmt ', 8)
	wav.writeUInt32LE(16, 16)
	wav.writeUInt16LE(1, 20)
	wav.writeUInt16LE(1, 22)
	wav.writeUInt32LE(44100, 24)
	wav.writeUInt32LE(88200, 28)
	wav.writeUInt16LE(2, 32)
	wav.writeUInt16LE(16, 34)
	wav.write('data', 36)
	wav.writeUInt32LE(frames * 2, 40)
	for (let i = 0; i < frames; i++) { wav.writeInt16LE(i * 40 - 10000, 44 + i * 2) }
	const file = await M.open(wav)
	const feed = M.createFeed()
	file.attach(feed, file.tracks[0])
	file.setLoop(true)
	const reader = M.createFeedReader(feed, { sampleRate: 44100 })
	await sleep(200)
	for (let loop = 0; loop < 100; loop++) {
		const samples = await readFeed(reader, { limit: frames })
		t.equal(samples.length, frames)
		await sleep(20)
		const position = M.getPosition(feed)
		t.equal(position.segment, loop + 1)
		t.equal(position.time, 0)
	}
	reader.close()
	file.close()
})

T.test("feed follows seeks", async (t) => {
	t.timeout(10e3)
	const expected = await M.decodeAudio(Fs.readFileSync(fixture('sine.wav')))
	const { file, feed } = await attachAudio('sine.wav')
	const reader = M.createFeedReader(feed, { sampleRate: 44100 })
	await readFeed(reader, { limit: 4410 })
	for (const time of [ 0.6, 0.2, 0.9 ]) {
		const segment = file.seek(time)
		let samples
		for (;;) {
			samples = await readFeed(reader, { limit: 128 })
			if (M.getPosition(feed).segment === segment) { break }
		}
		const position = M.getPosition(feed)
		t.ok(near(position.time, time, 0.01), { time, position })
		t.equal(maxDifference(samples, expected.channels[0], Math.round(time * 44100)), 0)
	}
	const rest = await readFeed(reader)
	t.equal(rest.length, Math.round(0.1 * 44100) - 128)
	reader.close()
	file.close()
})

T.test("feed reads at a playback rate", async (t) => {
	t.timeout(10e3)
	const expected = (await M.decodeAudio(Fs.readFileSync(fixture('sine.wav')))).channels[0]
	const { file, feed } = await attachAudio('sine.wav')
	const reader = M.createFeedReader(feed, { sampleRate: 44100 })

	let samples = await readFeed(reader, { limit: 1024 })
	t.equal(maxDifference(samples, expected.subarray(0, 1024)), 0)

	samples = await readFeed(reader, { limit: 1024, rate: 2 })
	t.ok(maxDifference(samples, expected.filter((_, i) => i >= 1024 && i < 3072 && i % 2 === 0)) < 1e-6)
	t.ok(near(M.getPosition(feed).time, 3072 / 44100, 1e-9))

	samples = await readFeed(reader, { limit: 100, rate: 1.5 })
	for (let i = 0; i < 100; i++) {
		const p = 3072 + i * 1.5
		const index = Math.floor(p)
		const value = expected[index] + (expected[index + 1] - expected[index]) * (p - index)
		t.ok(Math.abs(samples[i] - value) < 1e-6)
	}

	const channels = [ new Float32Array(128) ]
	t.throws(() => reader.readInto(channels, { rate: 0 }))
	t.throws(() => reader.readInto(channels, { rate: NaN }))
	t.throws(() => reader.wait(128, { rate: -1 }))
	reader.close()
	file.close()
})

T.test("feed position looks back by lagFrames", async (t) => {
	t.timeout(10e3)
	const { file, feed } = await attachAudio('sine.wav')
	const reader = M.createFeedReader(feed, { sampleRate: 44100 })
	await readFeed(reader, { limit: 4410, block: 4410 })
	t.ok(near(M.getPosition(feed).time, 0.1, 1e-9))
	t.ok(near(M.getPosition(feed, 2205).time, 0.05, 1e-9))
	t.equal(M.getPosition(feed, 1e6).time, 0)
	t.throws(() => M.getPosition(feed, NaN))
	t.throws(() => M.getPosition(feed, -Infinity))
	reader.close()
	file.close()
})

T.test("feed position looks ahead by a negative lagFrames", async (t) => {
	t.timeout(10e3)
	const { file, feed } = await attachAudio('sine.wav')
	const reader = M.createFeedReader(feed, { sampleRate: 44100 })
	await readFeed(reader, { limit: 22050, block: 4410 })
	while (!M.getPosition(feed, -1e9).ended) { await sleep(1) }
	t.ok(near(M.getPosition(feed, -2205).time, 0.55, 1e-9))
	t.ok(!M.getPosition(feed, -2205).ended)
	t.ok(near(M.getPosition(feed, -1e9).time, 1, 1e-9))
	t.ok(!M.getPosition(feed).ended)

	file.seek(0.25)
	while (M.getPosition(feed, -441).segment !== 1) { await sleep(1) }
	const ahead = M.getPosition(feed, -441)
	t.equal(ahead.file, file.id)
	t.ok(near(ahead.time, 0.26, 1e-3))
	t.equal(M.getPosition(feed).segment, 0)
	t.ok(near(M.getPosition(feed).time, 0.5, 1e-9))
	reader.close()
	file.close()
})

T.test("feed position names the file", async (t) => {
	t.timeout(10e3)
	const { file, feed } = await attachAudio('sine.wav')
	const other = await M.open(fixture('sine.wav'))
	t.equal(typeof file.id, 'number')
	t.ok(file.id !== other.id)
	t.equal(M.getPosition(feed).file, -1)
	const reader = M.createFeedReader(feed, { sampleRate: 44100 })
	await readFeed(reader, { limit: 1024 })
	t.equal(M.getPosition(feed).file, file.id)
	file.detach(feed)
	other.attach(feed, other.tracks[0])
	t.equal(M.getPosition(feed).file, file.id)
	await readFeed(reader, { limit: 1024 })
	t.equal(M.getPosition(feed).file, other.id)
	file.close()
	t.equal(file.id, other.id - 1)
	reader.close()
	other.close()
})

T.test("the feed's user data is left alone", async (t) => {
	t.timeout(10e3)
	const feed = M.createFeed()
	const data = M.getFeedUserData(feed)
	t.equal(data.length, 256)
	t.ok(data.buffer === feed)
	t.ok(data.every((x) => x === 0))
	data.fill(0xab)
	const file = await M.open(fixture('sine.wav'))
	file.setLoop(true)
	file.attach(feed, file.tracks[0])
	const reader = M.createFeedReader(feed, { sampleRate: 48000 })
	await readFeed(reader, { limit: 44100 * 1.5, block: 4096 })
	file.seek(0.5)
	await readFeed(reader, { limit: 4096 })
	reader.close()
	file.close()
	t.ok(data.every((x) => x === 0xab))
	t.throws(() => M.getFeedUserData(new SharedArrayBuffer(16)))
})

T.test("feed reader on a worker thread", async (t) => {
	t.timeout(10e3)
	const { file, feed } = await attachAudio('sine.wav')
	const worker = new Worker(`
		const { parentPort, workerData } = require('node:worker_threads')
		const M = require(workerData.module)
		const reader = M.createFeedReader(workerData.feed, { sampleRate: 48000 })
		const channels = [ new Float32Array(128) ]
		let length = 0
		const step = async () => {
			for (;;) {
				await reader.wait(128)
				length += reader.readInto(channels)
				if (reader.ended) { break }
			}
			reader.close()
			parentPort.postMessage(length)
		}
		step()
	`, { eval: true, workerData: { feed, module: `${root}/src/javascript/index.js` } })
	const length = await new Promise((resolve, reject) => {
		worker.once('message', resolve)
		worker.once('error', reject)
	})
	t.equal(length, 48000)
	await worker.terminate()
	file.close()
})

T.test("feed allows one reader at a time", async (t) => {
	t.timeout(10e3)
	const { file, feed } = await attachAudio('sine.wav')
	const reader = M.createFeedReader(feed, { sampleRate: 44100 })
	t.throws(() => M.createFeedReader(feed, { sampleRate: 44100 }))
	await readFeed(reader, { limit: 4410 })
	reader.close()
	const second = M.createFeedReader(feed, { sampleRate: 44100 })
	const samples = await readFeed(second)
	t.equal(samples.length, 44100 - 4410)
	second.close()
	file.close()
})

T.test("feed reopens at a new segment when the rate changes", async (t) => {
	t.timeout(10e3)
	const { file, feed } = await attachAudio('sine.wav')
	const reader = M.createFeedReader(feed, { sampleRate: 44100 })
	await readFeed(reader, { limit: 22050 })
	reader.close()
	const second = M.createFeedReader(feed, { sampleRate: 48000 })
	const first = await readFeed(second, { limit: 128 })
	t.equal(first.length, 128)
	const position = M.getPosition(feed)
	t.equal(position.segment, 1)
	t.ok(near(position.time, 0.5, 5e-3))
	const rest = await readFeed(second)
	t.equal(rest.length + 128, 24000)
	second.close()
	file.close()
})

T.test("feed reopens at a new segment at the same rate", async (t) => {
	t.timeout(10e3)
	const expected = await M.decodeAudio(fixture('sine.wav'))
	const { file, feed } = await attachAudio('sine.wav')
	const reader = M.createFeedReader(feed, { sampleRate: 44100 })
	const head = await readFeed(reader, { limit: 22050 })
	reader.close()
	const second = M.createFeedReader(feed, { sampleRate: 44100 })
	const tail = await readFeed(second)
	t.equal(M.getPosition(feed).segment, 1)
	t.equal(head.length + tail.length, 44100)
	t.ok(maxDifference(head, expected.channels[0]) < 1e-6)
	t.ok(maxDifference(tail, expected.channels[0], head.length) < 1e-6)
	second.close()
	file.close()
})

T.test("feed keeps working after a reader dies with its worker", async (t) => {
	t.timeout(10e3)
	const { file, feed } = await attachAudio('sine.wav')
	const worker = new Worker(`
		const { parentPort, workerData } = require('node:worker_threads')
		const M = require(workerData.module)
		const reader = M.createFeedReader(workerData.feed, { sampleRate: 44100 })
		const channels = [ new Float32Array(128) ]
		const step = async () => {
			let length = 0
			while (length < 4410) {
				await reader.wait(128)
				length += reader.readInto(channels)
			}
			parentPort.postMessage(length)
			setInterval(() => {}, 1000)
		}
		step()
	`, { eval: true, workerData: { feed, module: `${root}/src/javascript/index.js` } })
	const consumed = await new Promise((resolve, reject) => {
		worker.once('message', resolve)
		worker.once('error', reject)
	})
	await worker.terminate()
	const reader = M.createFeedReader(feed, { sampleRate: 44100 })
	const samples = await readFeed(reader)
	t.equal(samples.length + consumed, 44100)
	reader.close()
	file.close()
})

T.test("each attach starts a new generation of the feed", async (t) => {
	t.timeout(10e3)
	const { file, feed } = await attachAudio('sine.wav')
	t.equal(M.getPosition(feed).generation, -1)
	const reader = M.createFeedReader(feed, { sampleRate: 44100 })
	file.seek(0.5)
	await readFeed(reader, { limit: 1024 })
	const first = M.getPosition(feed)
	t.equal(first.generation, 1)
	t.equal(first.segment, 1)
	file.close()

	const second = await M.open(fixture('sine.wav'))
	t.equal(second.attach(feed, second.tracks[0]), 2)
	const stale = M.getPosition(feed)
	t.equal(stale.generation, 1)
	t.equal(stale.segment, 1)
	await readFeed(reader, { limit: 1024 })
	const fresh = M.getPosition(feed)
	t.equal(fresh.generation, 2)
	t.equal(fresh.segment, 0)
	t.ok(fresh.time < first.time)
	second.detach(feed)
	t.equal(second.attach(feed, second.tracks[0]), 3)
	reader.close()
	second.close()
})

T.test("feed writes silence for files without audio", async (t) => {
	t.timeout(10e3)
	const file = await M.open(fixture('vp9.webm'))
	const feed = M.createFeed()
	file.attach(feed)
	const reader = M.createFeedReader(feed, { sampleRate: 48000 })
	const samples = await readFeed(reader)
	t.equal(reader.channels, 1)
	t.equal(samples.length, Math.round(file.duration * 48000))
	t.equal(peak(samples), 0)
	await sleep(20)
	t.ok(M.getPosition(feed).ended)
	reader.close()
	file.close()
})

T.test("feed pads short audio to the video duration", async (t) => {
	t.timeout(10e3)
	const { file, feed } = await attachAudio('short-audio.webm')
	const video = file.tracks.find((track) => track.type === 'video').createReader({ format: 'gray' })
	const frames = (async () => {
		for (;;) {
			const frame = await video.read()
			if (!frame) { return }
			video.release(frame)
		}
	})()
	const reader = M.createFeedReader(feed, { sampleRate: 48000 })
	const samples = await readFeed(reader)
	await frames
	t.ok(near(samples.length / 48000, file.duration, 0.01))
	t.ok(peak(samples, 0, 40000) > 0.1)
	t.equal(peak(samples, 49000), 0)
	reader.close()
	file.close()
})

for (const before of [ 24000, 48000 ]) {
	T.test(`feed pads drained audio when video is enabled after ${before} frames`, async (t) => {
		t.timeout(10e3)
		const { file, feed } = await attachAudio('short-audio.webm')
		const reader = M.createFeedReader(feed, { sampleRate: 48000 })
		const head = await readFeed(reader, { limit: before })
		await sleep(50)
		t.equal(reader.ended, before === 48000)
		const video = file.tracks.find((track) => track.type === 'video').createReader({ format: 'gray' })
		video.release(await video.read())
		const frames = (async () => {
			for (;;) {
				const frame = await video.read()
				if (!frame) { return }
				video.release(frame)
			}
		})()
		const tail = await readFeed(reader)
		await frames
		t.ok(near((head.length + tail.length) / 48000, file.duration, 0.01))
		if (before < 48000) { t.ok(peak(tail, 0, 1000) > 0.1) }
		t.equal(peak(tail, tail.length - 38400), 0)
		reader.close()
		file.close()
	})
}

T.test("feed fills a late audio start with silence", async (t) => {
	t.timeout(10e3)
	const { file, feed } = await attachAudio('late-audio.mkv')
	const reader = M.createFeedReader(feed, { sampleRate: 48000 })
	const samples = await readFeed(reader)
	t.equal(samples.length, 48000)
	t.equal(peak(samples, 0, 12000), 0)
	t.ok(peak(samples, 12000, 13000) > 0.1)
	reader.close()
	file.close()
})

const readChannels = async (reader, count, block = 128) => {
	const planes = Array.from({ length: count }, () => new Float32Array(block))
	const chunks = []
	const counts = []
	for (;;) {
		await reader.wait(block)
		const read = reader.readInto(planes)
		if (read > 0) { chunks.push(planes.map((plane) => plane.slice(0, read))) }
		counts.push({ read, channels: reader.channels })
		if (reader.ended) { break }
		if (read === 0) { await sleep(1) }
	}
	const length = chunks.reduce((sum, chunk) => sum + chunk[0].length, 0)
	const channels = Array.from({ length: count }, () => new Float32Array(length))
	let offset = 0
	for (const chunk of chunks) {
		for (let c = 0; c < count; c++) { channels[c].set(chunk[c], offset) }
		offset += chunk[0].length
	}
	return { channels, counts }
}

T.test("feed mixes tracks with more than maxChannels down", async (t) => {
	t.timeout(10e3)
	const bytes = multichannelWav(48000, 1, 10)
	const expected = await M.decodeAudio(bytes)
	for (const [ maxChannels, count ] of [ [ undefined, 8 ], [ 2, 2 ], [ 12, 10 ] ]) {
		const file = await M.open(bytes)
		const feed = M.createFeed()
		file.attach(feed, file.tracks[0])
		const reader = M.createFeedReader(feed, { sampleRate: 48000, maxChannels })
		const { channels } = await readChannels(reader, 12)
		t.equal(reader.channels, count)
		t.equal(channels[0].length, 48000)
		t.ok(channels[count - 1].some((x) => x !== 0))
		t.ok(channels[count].every((x) => x === 0))
		if (count === 10) {
			let difference = 0
			for (let c = 0; c < 10; c++) { difference = Math.max(difference, maxDifference(channels[c], expected.channels[c])) }
			t.equal(difference, 0)
		}
		reader.close()
		file.close()
	}
})

T.test("feed mixes every track to a fixed channel count", async (t) => {
	t.timeout(10e3)
	const mono = (await M.decodeAudio(Fs.readFileSync(fixture('sine.wav')))).channels[0]
	{
		const { file, feed } = await attachAudio('sine.wav')
		const reader = M.createFeedReader(feed, { sampleRate: 44100, channels: 2 })
		const { channels } = await readChannels(reader, 2)
		t.equal(reader.channels, 2)
		t.equal(channels[0].length, mono.length)
		t.equal(maxDifference(channels[0], channels[1]), 0)
		t.ok(maxDifference(channels[0], mono.map((x) => x * Math.SQRT1_2)) < 1e-6)
		reader.close()
		file.close()
	}
	{
		const { file, feed } = await attachAudio('stereo-f32.wav')
		const reader = M.createFeedReader(feed, { sampleRate: 48000, channels: 1 })
		const { channels } = await readChannels(reader, 2)
		t.equal(reader.channels, 1)
		t.ok(peak(channels[0]) > 0.1)
		t.equal(peak(channels[1]), 0)
		reader.close()
		file.close()
	}
	{
		const { file, feed } = await attachAudio('channel-change.mp3')
		const reader = M.createFeedReader(feed, { sampleRate: 44100, channels: 2 })
		const { counts } = await readChannels(reader, 2, 100)
		t.equal(counts.slice(0, -1).filter(({ read }) => read > 0 && read < 100).length, 0)
		t.ok(counts.every(({ read, channels }) => read === 0 || channels === 2))
		reader.close()
		file.close()
	}
	{
		const file = await M.open(fixture('vp9.webm'))
		const feed = M.createFeed()
		file.attach(feed)
		const reader = M.createFeedReader(feed, { sampleRate: 48000, channels: 2 })
		const { channels } = await readChannels(reader, 2)
		t.equal(reader.channels, 2)
		t.equal(channels[0].length, Math.round(file.duration * 48000))
		reader.close()
		file.close()
	}
})

T.test("feed sizes its ring from buffer", async (t) => {
	t.timeout(10e3)
	const expected = (await M.decodeAudio(Fs.readFileSync(fixture('sine.wav')))).channels[0]
	const { file, feed } = await attachAudio('sine.wav')
	const reader = M.createFeedReader(feed, { sampleRate: 44100, buffer: 0.01 })
	const samples = await readFeed(reader, { block: 4096 })
	t.equal(samples.length, expected.length)
	t.equal(maxDifference(samples, expected), 0)
	reader.close()
	file.close()
})

T.test("feed rejects bad arguments", (t) => {
	t.throws(() => M.createFeedReader(new SharedArrayBuffer(16), { sampleRate: 48000 }))
	t.throws(() => M.createFeedReader(M.createFeed(), { sampleRate: 100 }))
	t.throws(() => M.createFeedReader(M.createFeed(), {}))
	t.throws(() => M.createFeedReader(M.createFeed(), { sampleRate: 48000, channels: 2, maxChannels: 2 }))
	for (const channels of [ 0, 1.5, 513, '2' ]) {
		t.throws(() => M.createFeedReader(M.createFeed(), { sampleRate: 48000, channels }))
		t.throws(() => M.createFeedReader(M.createFeed(), { sampleRate: 48000, maxChannels: channels }))
	}
	for (const buffer of [ 0, -1, NaN, Infinity, '1', 1e6 ]) {
		t.throws(() => M.createFeedReader(M.createFeed(), { sampleRate: 48000, buffer }))
	}
	t.throws(() => M.getPosition(new ArrayBuffer(16)))
})

T.test("feed reports the new segment after a seek to the end", async (t) => {
	t.timeout(10e3)
	const { file, feed } = await attachAudio('sine.wav')
	const reader = M.createFeedReader(feed, { sampleRate: 44100 })
	await readFeed(reader, { limit: 4410 })
	const segment = file.seek(file.duration)
	let position
	for (let i = 0; i < 1000; i++) {
		await readFeed(reader, { limit: 128 })
		position = M.getPosition(feed)
		if (position.segment === segment) { break }
		await sleep(1)
	}
	t.equal(position.segment, segment)
	t.ok(position.ended)
	t.ok(near(position.time, file.duration, 1e-3), position)
	reader.close()
	file.close()
})

const openTwoTracks = async () => {
	const file = await M.open(fixture('two-audio.mov'))
	const tracks = file.tracks.filter((track) => track.type === 'audio')
	return { file, tracks }
}

T.test("two feeds play two audio tracks of one file", async (t) => {
	t.timeout(10e3)
	const expected = (await M.decodeAudio(Fs.readFileSync(fixture('sine.wav')))).channels[0]
	const { file, tracks } = await openTwoTracks()
	const feeds = tracks.map((track) => {
		const feed = M.createFeed()
		file.attach(feed, track)
		return feed
	})
	const readers = feeds.map((feed) => M.createFeedReader(feed, { sampleRate: 44100 }))
	const [ first, second ] = await Promise.all(readers.map((reader) => readFeed(reader)))
	t.equal(first.length, 44100)
	t.equal(second.length, 44100)
	t.ok(maxDifference(first, expected) < 1e-3)
	t.ok(maxDifference(second, expected.map((x) => -x)) < 1e-3)
	await sleep(20)
	for (const feed of feeds) {
		const position = M.getPosition(feed)
		t.ok(position.ended)
		t.equal(position.segment, 0)
	}
	for (const reader of readers) { reader.close() }
	file.close()
})

T.test("two feeds follow a seek and a loop together", async (t) => {
	t.timeout(10e3)
	const { file, tracks } = await openTwoTracks()
	const feeds = tracks.map((track) => {
		const feed = M.createFeed()
		file.attach(feed, track)
		return feed
	})
	const readers = feeds.map((feed) => M.createFeedReader(feed, { sampleRate: 44100 }))
	await Promise.all(readers.map((reader) => readFeed(reader, { limit: 4410 })))
	const segment = file.seek(0.5)
	file.setLoop(true)
	await sleep(50)
	const parts = await Promise.all(readers.map((reader) => readFeed(reader, { limit: 44100 })))
	for (const part of parts) { t.equal(part.length, 44100) }
	await sleep(20)
	for (const feed of feeds) {
		const position = M.getPosition(feed)
		t.equal(position.segment, segment + 1)
		t.ok(near(position.time, 0.5, 0.01), position)
	}
	file.setLoop(false)
	const rest = await Promise.all(readers.map((reader) => readFeed(reader)))
	for (const part of rest) { t.ok(part.length <= 22050) }
	for (const reader of readers) { t.ok(reader.ended) }
	for (const reader of readers) { reader.close() }
	file.close()
})

T.test("a detached feed can be attached to another track", async (t) => {
	t.timeout(10e3)
	const expected = (await M.decodeAudio(Fs.readFileSync(fixture('sine.wav')))).channels[0]
	const { file, tracks } = await openTwoTracks()
	const feed = M.createFeed()
	file.attach(feed, tracks[0])
	const reader = M.createFeedReader(feed, { sampleRate: 44100 })
	const before = await readFeed(reader, { limit: 22050 })
	t.ok(maxDifference(before, expected) < 1e-3)
	file.detach(feed)
	file.attach(feed, tracks[1])
	const after = await readFeed(reader)
	t.equal(after.length, 22050)
	t.ok(maxDifference(after, expected.map((x) => -x), 22050) < 1e-3)
	await sleep(20)
	const position = M.getPosition(feed)
	t.ok(position.ended)
	t.equal(position.segment, 1)
	t.ok(near(position.time, 1, 1e-3))
	reader.close()
	file.close()
})

T.test("detaching a feed wakes its reader and frees the track", async (t) => {
	t.timeout(10e3)
	const { file, feed } = await attachAudio('sine.wav')
	const reader = M.createFeedReader(feed, { sampleRate: 44100 })
	await readFeed(reader, { limit: 4410 })
	await sleep(50)
	const pending = reader.wait(44100 * 10)
	file.detach(feed)
	await pending
	t.ok(!reader.ended)
	t.equal(reader.readInto([ new Float32Array(128) ]), 0)
	const track = file.tracks.find((x) => x.type === 'audio')
	const audio = track.createReader()
	const block = await audio.readChannels(0.1)
	t.ok(near(block.timestamp, 0.1, 1e-3), block)
	audio.close()
	reader.close()
	file.close()
})

T.test("a feed without a track can share a file with a track feed", async (t) => {
	t.timeout(10e3)
	const { file, feed } = await attachAudio('sine.wav')
	const silent = M.createFeed()
	file.attach(silent)
	const readers = [ feed, silent ].map((x) => M.createFeedReader(x, { sampleRate: 44100 }))
	const [ sound, silence ] = await Promise.all(readers.map((reader) => readFeed(reader)))
	t.equal(sound.length, 44100)
	t.equal(silence.length, 44100)
	t.ok(peak(sound) > 0.1)
	t.equal(peak(silence), 0)
	for (const reader of readers) { reader.close() }
	file.close()
})

T.test("a feed without a track attached mid-play starts at the current time", async (t) => {
	t.timeout(10e3)
	const file = await M.open(fixture('vp9.webm'))
	const video = file.tracks.find((track) => track.type === 'video').createReader({ format: 'gray' })
	for (;;) {
		const frame = await video.read()
		const { timestamp } = frame
		video.release(frame)
		if (timestamp >= 0.5) { break }
	}
	const feed = M.createFeed()
	file.attach(feed)
	const reader = M.createFeedReader(feed, { sampleRate: 48000 })
	await reader.wait(128)
	const frames = (async () => {
		for (;;) {
			const frame = await video.read()
			if (!frame) { return }
			video.release(frame)
		}
	})()
	const samples = await readFeed(reader)
	await frames
	t.ok(samples.length < 1.6 * 48000 && samples.length > 1.2 * 48000, samples.length)
	reader.close()
	video.close()
	file.close()
})

T.test("a track feed attached after a feed without a track starts at the current time", async (t) => {
	t.timeout(10e3)
	const file = await M.open(fixture('sine.wav'))
	const silent = M.createFeed()
	file.attach(silent)
	const silence = M.createFeedReader(silent, { sampleRate: 44100 })
	await readFeed(silence, { limit: 22050 })
	const feed = M.createFeed()
	file.attach(feed, file.tracks.find((track) => track.type === 'audio'))
	const reader = M.createFeedReader(feed, { sampleRate: 44100 })
	await reader.wait(128)
	const [ sound ] = await Promise.all([ readFeed(reader), readFeed(silence) ])
	t.ok(sound.length > 0.4 * 44100 && sound.length < 0.6 * 44100, sound.length)
	reader.close()
	silence.close()
	file.close()
})

T.test("a feed detached right after a seek resumes at the seek target", async (t) => {
	t.timeout(10e3)
	const file = await M.open(fixture('sine.wav'))
	const track = file.tracks.find((x) => x.type === 'audio')
	const first = M.createFeed()
	file.attach(first, track)
	const firstReader = M.createFeedReader(first, { sampleRate: 44100 })
	await readFeed(firstReader, { limit: 33075 })
	file.seek(0.1)
	file.detach(first)
	firstReader.close()
	const second = M.createFeed()
	file.attach(second, track)
	const reader = M.createFeedReader(second, { sampleRate: 44100 })
	const samples = await readFeed(reader)
	t.ok(samples.length > 0.85 * 44100 && samples.length < 0.95 * 44100, samples.length)
	reader.close()
	file.close()
})

T.test("a video track enabled right after a seek starts at the seek target", async (t) => {
	t.timeout(10e3)
	const file = await M.open(fixture('late-audio.mkv'))
	const feed = M.createFeed()
	file.attach(feed, file.tracks.find((x) => x.type === 'audio'))
	const reader = M.createFeedReader(feed, { sampleRate: 48000 })
	await readFeed(reader, { limit: 36000 })
	file.seek(0.1)
	while (reader._native.seeking) { await sleep(1) }
	const video = file.tracks.find((x) => x.type === 'video').createReader({ format: 'gray' })
	const frame = await video.read()
	t.ok(near(frame.timestamp, 0.1, 0.05), frame.timestamp)
	video.release(frame)
	video.close()
	reader.close()
	file.close()
})

const brokenOpus = () => {
	const bytes = Fs.readFileSync(fixture('short-audio.webm'))
	bytes[bytes.indexOf('OpusHead') + 18] = 255
	return bytes
}

T.test("feed reader reports the failure of its track", async (t) => {
	t.timeout(10e3)
	const file = await M.open(brokenOpus())
	const errors = []
	file.on('decodeError', ({ error }) => { errors.push(error) })
	const feed = M.createFeed()
	file.attach(feed, file.tracks.find((x) => x.type === 'audio'))
	const reader = M.createFeedReader(feed, { sampleRate: 48000 })
	await reader.wait(128)
	t.ok(reader.ended)
	const { error } = reader
	t.ok(error instanceof Error)
	t.equal(error.fatal, true)
	t.ok(Number.isInteger(error.errno) && error.errno < 0, error.errno)
	t.equal(reader.error, error)
	await sleep(10)
	t.equal(errors.length, 1)
	t.equal(error.message, errors[0].message)
	t.notEqual(error, errors[0])
	file.detach(feed)
	const other = await M.open(fixture('sine.wav'))
	other.attach(feed, other.tracks[0])
	t.equal(reader.error, null)
	t.equal((await readFeed(reader)).length, 48000)
	t.equal(reader.error, null)
	reader.close()
	other.close()
	file.close()
})

T.test("feed reader on a worker thread sees a failing source", async (t) => {
	t.timeout(10e3)
	const bytes = Fs.readFileSync(fixture('short-audio.webm'))
	const source = M.createByteSource({ size: bytes.length })
	source.push(0, bytes.subarray(0, bytes.length >> 1))
	const file = await M.open(source)
	file.on('decodeError', () => {})
	const feed = M.createFeed()
	file.attach(feed, file.tracks.find((x) => x.type === 'audio'))
	source.fail("network down")
	const worker = new Worker(`
		const { parentPort, workerData } = require('node:worker_threads')
		const M = require(workerData.module)
		const reader = M.createFeedReader(workerData.feed, { sampleRate: 48000 })
		const channels = [ new Float32Array(128) ]
		const step = async () => {
			let length = 0
			for (;;) {
				await reader.wait(128)
				length += reader.readInto(channels)
				if (reader.ended) { break }
			}
			const { message, errno, fatal } = reader.error
			reader.close()
			parentPort.postMessage({ length, message, errno, fatal })
		}
		step()
	`, { eval: true, workerData: { feed, module: `${root}/src/javascript/index.js` } })
	const result = await new Promise((resolve, reject) => {
		worker.once('message', resolve)
		worker.once('error', reject)
	})
	t.ok(result.length > 0)
	t.equal(result.message, "network down")
	t.equal(result.fatal, true)
	t.ok(result.errno < 0)
	await worker.terminate()
	file.close()
})

T.test("feed does not end while a loop is pending", async (t) => {
	t.timeout(10e3)
	const { file, feed } = await attachAudio('sine.wav')
	const reader = M.createFeedReader(feed, { sampleRate: 44100 })
	t.equal((await readFeed(reader)).length, 44100)
	t.ok(reader.ended)
	file.setLoop(true)
	t.ok(!reader.ended)
	const channels = [ new Float32Array(128) ]
	await reader.wait(128)
	t.equal(reader.readInto(channels), 128)
	t.ok(!reader.ended)
	file.setLoop(false)
	reader.close()
	file.close()
})

T.test("attach and detach validation", async (t) => {
	t.timeout(10e3)
	const { file, tracks } = await openTwoTracks()
	const feed = M.createFeed()
	file.attach(feed, tracks[0])
	t.throws(() => file.attach(feed, tracks[1]))
	t.throws(() => file.attach(feed))
	const silent = M.createFeed()
	file.attach(silent)
	t.throws(() => file.attach(M.createFeed()))
	t.throws(() => file.detach(new SharedArrayBuffer(16)))
	file.detach(M.createFeed())
	file.detach(silent)
	file.attach(silent)
	file.close()
	file.detach(feed)
	t.throws(() => file.attach(M.createFeed(), tracks[1]))
})
