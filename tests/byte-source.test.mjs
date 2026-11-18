import T from '@kmamal/testing'
import Fs from 'node:fs'
import M from '../src/javascript/index.js'
import { fixture, readAll, sleep } from './helpers/common.mjs'

const CHUNK = 4096

const sequentialSource = (bytes) => {
	const requests = []
	const source = M.createByteSource()
	source.on('request', ({ offset }) => { requests.push(offset) })
	;(async () => {
		for (let offset = 0; offset < bytes.length; offset += CHUNK) {
			await sleep(0)
			source.push(offset, bytes.subarray(offset, offset + CHUNK))
		}
		source.end()
	})()
	return { source, requests }
}

const rangedSource = (bytes, options = {}) => {
	const requests = []
	let generation = 0
	let source = null
	const load = async (offset) => {
		const current = ++generation
		source.restart(offset)
		for (let position = offset; position < bytes.length; position += CHUNK) {
			await sleep(0)
			if (current !== generation) { return }
			if (!source.push(position, bytes.subarray(position, position + CHUNK))) {
				await source.drain()
			}
		}
		if (current === generation) { source.end() }
	}
	source = M.createByteSource({
		size: bytes.length,
		randomAccess: true,
		...options,
	})
	source.on('request', ({ offset }) => {
		requests.push(offset)
		load(offset)
	})
	load(0)
	return { source, requests }
}

for (const name of [ 'vp9.webm', 'vp9.mp4', 'big-tail.mp4' ]) {
	T.test(`sequential ${name}`, async (t) => {
		t.timeout(20e3)
		const bytes = Fs.readFileSync(fixture(name))
		const { source } = sequentialSource(bytes)
		const file = await M.open(source)
		const frames = await readAll(file.tracks[0].createReader({ format: 'gray' }))
		t.equal(frames.length, name === 'big-tail.mp4' ? 30 : 20)
		file.close()
	})

	T.test(`ranged ${name}`, async (t) => {
		t.timeout(20e3)
		const bytes = Fs.readFileSync(fixture(name))
		const { source, requests } = rangedSource(bytes)
		const file = await M.open(source)
		const frames = await readAll(file.tracks[0].createReader({ format: 'gray' }))
		t.equal(frames.length, name === 'big-tail.mp4' ? 30 : 20)
		if (name === 'big-tail.mp4') {
			t.ok(requests.length >= 2, { requests })
			t.ok(requests[0] > bytes.length - 2000, { requests })
		}
		file.close()
	})
}

T.test("ranged source with a small window", async (t) => {
	t.timeout(20e3)
	const bytes = Fs.readFileSync(fixture('big-tail.mp4'))
	const { source } = rangedSource(bytes, { aheadLimit: 32 * 1024, behindLimit: 16 * 1024 })
	const file = await M.open(source)
	const reader = file.tracks[0].createReader({ format: 'gray' })
	const frames = await readAll(reader)
	t.equal(frames.length, 30)
	const buffered = source.bufferedRanges.reduce((sum, [ start, end ]) => sum + end - start, 0)
	t.ok(buffered < bytes.length / 2, { buffered })
	file.close()
})

T.test("failed source", async (t) => {
	t.timeout(20e3)
	const bytes = Fs.readFileSync(fixture('vp9.webm'))
	const source = M.createByteSource()
	source.push(0, bytes.subarray(0, 200))
	setTimeout(() => { source.fail("network down") }, 50)
	await t.throwsAsync(() => M.open(source))
})

T.test("closing a file closes its byte source", async (t) => {
	t.timeout(10e3)
	const bytes = Fs.readFileSync(fixture('sine.wav'))
	const source = M.createByteSource({ size: bytes.length, randomAccess: true })
	source.push(0, bytes)
	source.end()
	const file = await M.open(source)
	file.close()
	t.ok(source.closed)
	t.equal(source.push(0, bytes), false)
	await source.drain()
})

T.test("a failed open closes its byte source", async (t) => {
	t.timeout(10e3)
	const source = M.createByteSource()
	source.push(0, new Uint8Array(1024))
	source.end()
	await t.throwsAsync(() => M.open(source))
	t.ok(source.closed)
	await source.drain()
})

T.test("ranged source that skips past its full window", async (t) => {
	t.timeout(20e3)
	const wav = Fs.readFileSync(fixture('sine.wav'))
	const dataOffset = wav.indexOf('data', 12)
	const junk = Buffer.alloc(8 + 200000)
	junk.write('junk', 0)
	junk.writeUInt32LE(200000, 4)
	const bytes = Buffer.concat([ wav.subarray(0, dataOffset), junk, wav.subarray(dataOffset) ])
	bytes.writeUInt32LE(bytes.length - 8, 4)

	const source = M.createByteSource({
		size: bytes.length,
		randomAccess: true,
		aheadLimit: 64 * 1024,
		behindLimit: 16 * 1024,
	})
	source.on('request', () => {})
	let offset = 0
	while (source.push(offset, bytes.subarray(offset, offset + CHUNK))) { offset += CHUNK }
	offset += CHUNK
	;(async () => {
		await source.drain()
		for (; offset < bytes.length; offset += CHUNK) {
			if (!source.push(offset, bytes.subarray(offset, offset + CHUNK))) {
				await source.drain()
			}
		}
		source.end()
	})()

	const file = await M.open(source)
	const reader = file.tracks[0].createReader()
	let frames = 0
	for (;;) {
		const chunk = await reader.readChannels(0.1)
		if (!chunk) { break }
		frames += chunk.frames
	}
	t.equal(frames, 44100)
	file.close()
})
