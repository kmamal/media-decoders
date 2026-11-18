import T from '@kmamal/testing'
import Fs from 'node:fs'
import M from '../src/javascript/index.js'
import { fixture, sleep } from './helpers/common.mjs'

const corrupt = (name, at) => {
	const bytes = new Uint8Array(Fs.readFileSync(fixture(name)))
	const offset = Math.floor(bytes.length * at)
	for (let i = 0; i < 24; i++) { bytes[offset + i] ^= 0xff }
	return bytes
}

const truncate = (name, at) => {
	const bytes = Fs.readFileSync(fixture(name))
	return bytes.subarray(0, Math.floor(bytes.length * at))
}

const openWithErrors = async (bytes) => {
	const file = await M.open(bytes)
	const errors = []
	file.on('decodeError', ({ error }) => { errors.push(error) })
	return { file, errors }
}

const readVideo = async (file) => {
	const reader = file.tracks.find((x) => x.type === 'video').createReader({ format: 'gray' })
	const timestamps = []
	let frame
	while ((frame = await reader.read())) {
		timestamps.push(frame.timestamp)
		reader.release(frame)
	}
	return timestamps
}

const readAudio = async (file) => {
	const reader = file.tracks.find((x) => x.type === 'audio').createReader({ sampleRate: 48000 })
	let frames = 0
	let block
	while ((block = await reader.readChannels())) { frames += block.frames }
	return frames
}

const settle = () => new Promise((resolve) => { setImmediate(resolve) })

for (const name of [ 'vp8.webm', 'vp9.webm' ]) {
	for (const at of [ 0.6, 0.8 ]) {
		T.test(`corrupt ${name} at ${at * 100}% reports a non-fatal error`, async (t) => {
			t.timeout(10e3)
			const { file, errors } = await openWithErrors(corrupt(name, at))
			const timestamps = await readVideo(file)
			await settle()
			t.ok(timestamps.length > 0)
			t.ok(errors.length > 0)
			t.ok(errors.every((error) => error instanceof Error && error.fatal === false))
			file.close()
		})
	}
}

T.test("decoding continues after a decoder error", async (t) => {
	t.timeout(10e3)
	const { file, errors } = await openWithErrors(corrupt('vp8.webm', 0.8))
	const timestamps = await readVideo(file)
	t.ok(errors.length > 0)
	t.ok(errors.every((error) => error.track === file.tracks.find((x) => x.type === 'video')))
	t.equal(timestamps.length, 19)
	t.ok(timestamps.at(-1) > 1.85)
	file.close()
})

T.test("a track without data fails", async (t) => {
	t.timeout(10e3)
	const { file, errors } = await openWithErrors(corrupt('h264.mp4', 0.8))
	await t.throwsWithAsync(() => readVideo(file), (error) => {
		t.ok(error instanceof Error)
		t.equal(error.fatal, true)
		t.equal(error, errors.at(-1))
		t.equal(error.track, file.tracks.find((x) => x.type === 'video'))
	})
	t.equal(errors.length, 1)
	file.close()
	await t.throwsWithAsync(() => M.decodeFrame(corrupt('h264.mp4', 0.8)), (error) => { t.equal(error.fatal, true) })
})

for (const name of [ 'vp8.webm', 'vp9.webm' ]) {
	T.test(`truncated ${name} reports an error`, async (t) => {
		t.timeout(10e3)
		const { file, errors } = await openWithErrors(truncate(name, 0.5))
		const timestamps = await readVideo(file)
		t.ok(timestamps.length > 0)
		t.ok(errors.length > 0)
		t.ok(errors.every((error) => error.fatal === false))
		file.close()
	})
}

for (const name of [ 'sine.wav', 'sine.flac', 'sine.webm' ]) {
	T.test(`truncated ${name} reports an error`, async (t) => {
		t.timeout(10e3)
		const { file, errors } = await openWithErrors(truncate(name, 0.5))
		const frames = await readAudio(file)
		t.ok(frames > 0)
		t.ok(errors.length > 0)
		t.ok(errors.every((error) => error.fatal === false))
		file.close()
	})
}

T.test("decodeAudio decodes past errors", async (t) => {
	t.timeout(10e3)
	const { channels, sampleRate } = await M.decodeAudio(truncate('sine.flac', 0.5))
	t.ok(channels[0].length > sampleRate * 0.1)
})

T.test("decodeAudio keeps the audio before a failing source", async (t) => {
	t.timeout(10e3)
	const bytes = Fs.readFileSync(fixture('stereo-f32.wav'))
	const full = await M.decodeAudio(bytes)
	const source = M.createByteSource({ size: bytes.length })
	source.push(0, bytes.subarray(0, bytes.length >> 1))
	const promise = M.decodeAudio(source)
	await sleep(50)
	source.fail("network down")
	const { channels } = await promise
	t.ok(channels[0].length > full.sampleRate * 0.2)
	t.ok(channels[0].length < full.channels[0].length)
	t.equal(channels[0], full.channels[0].subarray(0, channels[0].length))
})

T.test("errors during open reach decodeError listeners", async (t) => {
	t.timeout(10e3)
	const { file, errors } = await openWithErrors(corrupt('sine.opus', 0.3))
	await settle()
	t.ok(errors.length > 0)
	file.close()
})

T.test("a failing source is a fatal error after the frames before it", async (t) => {
	t.timeout(10e3)
	const bytes = Fs.readFileSync(fixture('short-audio.webm'))
	const source = M.createByteSource({ size: bytes.length })
	source.push(0, bytes.subarray(0, bytes.length >> 1))
	const { file, errors } = await openWithErrors(source)
	file.setLoop(true)
	source.fail("network down")
	const video = file.tracks.find((x) => x.type === 'video').createReader()
	let frames = 0
	await t.throwsWithAsync(async () => {
		let frame
		while ((frame = await video.read())) {
			frames += 1
			video.release(frame)
		}
	}, (error) => {
		t.equal(error.message, "network down")
		t.equal(error.fatal, true)
		t.equal(error.track, null)
	})
	t.ok(frames > 0)
	t.equal(errors.at(-1).message, "network down")
	file.seek(0)
	await t.throwsWithAsync(() => video.read(), (error) => { t.equal(error.message, "network down") })
	file.close()
})

T.test("an audio reader rejects with the file's error after a failing source", async (t) => {
	t.timeout(10e3)
	const bytes = Fs.readFileSync(fixture('short-audio.webm'))
	const source = M.createByteSource({ size: bytes.length })
	source.push(0, bytes.subarray(0, bytes.length >> 1))
	const { file, errors } = await openWithErrors(source)
	source.fail("network down")
	const audio = file.tracks.find((x) => x.type === 'audio').createReader({ sampleRate: 48000 })
	let frames = 0
	await t.throwsWithAsync(async () => {
		let result
		while ((result = await audio.readChannels(0.1))) { frames += result.frames }
	}, (error) => {
		t.equal(error.message, "network down")
		t.equal(error, errors.at(-1))
	})
	t.ok(frames > 0)
	t.ok(audio.ended)
	file.close()
})
