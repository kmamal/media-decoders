import T from '@kmamal/testing'
import Fs from 'node:fs'
import M from '../src/javascript/index.js'
import { fixture, frameNumber, near } from './helpers/common.mjs'

const collect = async (iterator) => {
	const frames = []
	for await (const frame of iterator) {
		frames.push({ number: frameNumber(frame), timestamp: frame.timestamp })
	}
	return frames
}

T.test("decodeVideo reads the whole track", async (t) => {
	t.timeout(10e3)
	const frames = await collect(M.decodeVideo(fixture('vp9.webm'), { format: 'gray' }))
	t.equal(frames.map((x) => x.number), Array.from({ length: 20 }, (_, i) => i))
})

T.test("decodeVideo start and end", async (t) => {
	t.timeout(10e3)
	const frames = await collect(M.decodeVideo(fixture('vp9.webm'), { start: 0.55, end: 1.2, format: 'gray' }))
	t.equal(frames.map((x) => x.number), [ 5, 6, 7, 8, 9, 10, 11 ])
	t.ok(near(frames[0].timestamp, 0.5, 1e-3))
	const tail = await collect(M.decodeVideo(fixture('vp9.webm'), { start: 1.75, format: 'gray' }))
	t.equal(tail.map((x) => x.number), [ 17, 18, 19 ])
})

T.test("decodeVideo stops early", async (t) => {
	t.timeout(10e3)
	const frames = []
	for await (const frame of M.decodeVideo(fixture('vp9.webm'), { format: 'gray', frames: 2 })) {
		frames.push(frame)
		if (frames.length === 3) { break }
	}
	t.equal(frameNumber(frames[2]), 2)
})

T.test("decodeVideo with a thread limit", async (t) => {
	t.timeout(10e3)
	const frames = await collect(M.decodeVideo(fixture('vp9.webm'), { format: 'gray', threads: 1 }))
	t.equal(frames.map((x) => x.number), Array.from({ length: 20 }, (_, i) => i))
	for (const threads of [ -1, 0.5, '2' ]) {
		t.throwsWith(() => M.decodeVideo(fixture('vp9.webm'), { threads }), (error) => { t.ok(error instanceof TypeError) })
	}
})

T.test("decodeVideo errors", async (t) => {
	t.timeout(10e3)
	t.throws(() => M.decodeVideo(fixture('vp9.webm'), { start: -1 }))
	t.throws(() => M.decodeVideo(fixture('vp9.webm'), { start: 1, end: 1 }))
	await t.throwsAsync(() => collect(M.decodeVideo(fixture('sine.wav'))))
	t.throws(() => M.decodeVideo(fixture('vp9.webm'), { format: 'nope' }))
	t.throws(() => M.decodeVideo(new URL('https://example.com/a.webm')))
})

T.test("decodeFrame", async (t) => {
	t.timeout(10e3)
	const first = await M.decodeFrame(Fs.readFileSync(fixture('vp9.webm')))
	t.equal(first.format, 'rgba')
	t.equal(first.data.length, first.width * first.height * 4)
	t.equal(first.timestamp, 0)
	for (const [ time, expected ] of [ [ 1.55, 15 ], [ 0.33, 3 ], [ 5, 19 ] ]) {
		const frame = await M.decodeFrame(fixture('vp9.webm'), time, { format: 'gray' })
		t.equal(frameNumber(frame), expected, { time })
	}
	t.throws(() => M.decodeFrame(fixture('vp9.webm'), -1))
	t.throws(() => M.decodeFrame(fixture('vp9.webm'), 0, { format: 'nope' }))
	await t.throwsAsync(() => M.decodeFrame(fixture('sine.wav')))
})

T.test("decodeFrame and decodeVideo track option", async (t) => {
	t.timeout(10e3)
	const frame = await M.decodeFrame(fixture('late-audio.mkv'), 0, { track: 0, format: 'gray' })
	t.ok(frame)
	await t.throwsWithAsync(() => M.decodeFrame(fixture('late-audio.mkv'), 0, { track: 1 }), (error) => {
		t.equal(error.message, "track 1 is not a video track")
	})
	await t.throwsWithAsync(() => M.decodeFrame(fixture('vp9.webm'), 0, { track: 3 }), (error) => {
		t.equal(error.message, "track 3 is not a video track")
	})
	t.throwsWith(() => M.decodeFrame(fixture('vp9.webm'), 0, { track: -1 }), (error) => { t.ok(error instanceof TypeError) })
	t.throwsWith(() => M.decodeVideo(fixture('vp9.webm'), { track: 0.5 }), (error) => { t.ok(error instanceof TypeError) })
	const frames = await collect(M.decodeVideo(fixture('vp9.webm'), { track: 0, format: 'gray' }))
	t.equal(frames.length, 20)
})
