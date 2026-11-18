import T from '@kmamal/testing'
import Fs from 'node:fs'
import { Worker } from 'node:worker_threads'
import M from '../src/javascript/index.js'
import { root, fixture, frameNumber, near, sleep } from './helpers/common.mjs'

const GRAY = { format: 'gray', width: 64, height: 48 }

const nextFrame = async (reader) => {
	for (;;) {
		const frame = reader.next()
		if (frame || reader.ended || reader.closed) { return frame }
		await reader.wait()
	}
}

const readNext = async (reader, limit = Infinity) => {
	const frames = []
	while (frames.length < limit) {
		const frame = await nextFrame(reader)
		if (!frame) { break }
		frames.push({ number: frameNumber(frame), timestamp: frame.timestamp, segment: frame.segment, file: frame.file })
		reader.release(frame)
	}
	return frames
}

const attachVideo = async (name, options = GRAY) => {
	const file = await M.open(fixture(name))
	const feed = M.createVideoFeed()
	const reader = M.createVideoFeedReader(feed, options)
	file.attach(feed, file.tracks.find((x) => x.type === 'video'))
	return { file, feed, reader }
}

T.test("video feed reads every frame in order with next()", async (t) => {
	t.timeout(10e3)
	const { file, reader } = await attachVideo('vp9.webm')
	const first = await nextFrame(reader)
	t.equal(first.planes.length, 1)
	t.equal(first.data.length, 64 * 48)
	t.equal(first.displayWidth, file.tracks[0].displayWidth)
	t.equal(first.matrix, file.tracks[0].matrix)
	t.equal(first.file, file.id)
	t.equal(first.segment, 0)
	reader.release(first)
	const frames = await readNext(reader)
	t.equal(frames.map((x) => x.number), Array.from({ length: 19 }, (_, i) => i + 1))
	t.ok(near(frames.at(-1).timestamp, 1.9, 1e-3))
	t.ok(reader.ended)
	t.equal(reader.next(), null)
	reader.close()
	file.close()
})

T.test("video feed reader opened after the attach", async (t) => {
	t.timeout(10e3)
	const file = await M.open(fixture('vp9.webm'))
	const feed = M.createVideoFeed()
	file.attach(feed, file.tracks[0])
	await sleep(20)
	const reader = M.createVideoFeedReader(feed, { format: 'rgba', width: 8, height: 6 })
	const frame = await nextFrame(reader)
	t.equal(frame.data.length, 8 * 6 * 4)
	t.equal(frame.matrix, undefined)
	reader.release(frame)
	t.equal((await readNext(reader)).length, 19)
	reader.close()
	file.close()
})

T.test("video feed at() returns the frame for a time", async (t) => {
	t.timeout(10e3)
	const { file, reader } = await attachVideo('vp9.webm', { ...GRAY, frames: 3 })
	const results = []
	for (const time of [ 0, 0.05, 0.25, 0.25, 0.71, 1, 1.95, 2, 2.5 ]) {
		await reader.wait({ time })
		const { frame, ended } = reader.at({ time })
		results.push([ frameNumber(frame), ended ])
	}
	t.equal(results, [
		[ 0, false ],
		[ 0, false ],
		[ 2, false ],
		[ 2, false ],
		[ 7, false ],
		[ 10, false ],
		[ 19, false ],
		[ 19, true ],
		[ 19, true ],
	])
	const a = reader.at({ time: 2.5 }).frame
	t.equal(reader.at({ time: 2.5, file: file.id, segment: 0 }).frame, a)
	reader.close()
	file.close()
})

T.test("video feed at() repeats its frame until the next one is due", async (t) => {
	t.timeout(10e3)
	const { file, reader } = await attachVideo('vp9.webm')
	await reader.wait({ time: 0.3 })
	const frame = reader.at({ time: 0.3 }).frame
	t.equal(frameNumber(frame), 3)
	t.equal(reader.at({ time: 0.35 }).frame, frame)
	t.equal(reader.at({ time: 0.2 }).frame, frame)
	await reader.wait({ time: 0.4 })
	const later = reader.at({ time: 0.4 }).frame
	t.equal(frameNumber(later), 4)
	t.notEqual(later, frame)
	reader.close()
	file.close()
})

T.test("video feed at() keeps its frame for another file and follows the latest segment", async (t) => {
	t.timeout(10e3)
	const { file, reader } = await attachVideo('vp9.webm')
	await reader.wait({ time: 0.5 })
	const frame = reader.at({ time: 0.5 }).frame
	t.equal(frameNumber(frame), 5)
	t.equal(reader.at({ file: file.id + 1000, time: 1.5 }).frame, frame)
	t.equal(reader.at({ file: -1, segment: -1, time: 0 }).frame, frame)
	t.equal(reader.at({ file: file.id, segment: -1, time: 1.5 }).frame, frame)

	const segment = file.seek(1.2)
	await reader.wait({ time: 1.3, segment })
	t.equal(frameNumber(reader.at({ time: 1.3, segment }).frame), 13)
	t.equal(reader.at({ time: 1.3, segment }).frame.segment, segment)
	await reader.wait({ time: 1.5 })
	const latest = reader.at({ time: 1.5 }).frame
	t.equal(frameNumber(latest), 15)
	t.equal(latest.segment, segment)
	reader.close()
	file.close()
})

T.test("video feed at() follows an audio feed", async (t) => {
	t.timeout(10e3)
	const file = await M.open(fixture('short-audio.webm'))
	const audioFeed = M.createFeed()
	const videoFeed = M.createVideoFeed()
	const audio = M.createFeedReader(audioFeed, { sampleRate: 48000 })
	const video = M.createVideoFeedReader(videoFeed, GRAY)
	file.attach(audioFeed, file.tracks.find((x) => x.type === 'audio'))
	file.attach(videoFeed, file.tracks.find((x) => x.type === 'video'))
	const channels = [ new Float32Array(4800) ]
	let position
	let frame = null
	while (!frame) {
		await audio.wait(4800)
		audio.readInto(channels)
		position = M.getPosition(audioFeed)
		await video.wait(position)
		frame = video.at(position).frame
	}
	t.equal(position.file, file.id)
	t.ok(position.time > 0, position)
	t.equal(frame.file, file.id)
	t.equal(frame.segment, position.segment)
	t.ok(frame.timestamp <= position.time && position.time < frame.timestamp + frame.duration, frame)
	audio.close()
	video.close()
	file.close()
})

T.test("a video feed reader uses next() or at() but not both", async (t) => {
	t.timeout(10e3)
	const { file, feed, reader } = await attachVideo('vp9.webm')
	await nextFrame(reader)
	t.throws(() => reader.at({ time: 0 }), /next\(\) mode/u)
	reader.close()
	const other = M.createVideoFeedReader(feed, GRAY)
	other.at({ time: 0 })
	t.throws(() => other.next(), /at\(\) mode/u)
	other.close()
	file.close()
})

T.test("video feed frames wait for a release", async (t) => {
	t.timeout(10e3)
	const { file, reader } = await attachVideo('vp9.webm', { ...GRAY, frames: 2 })
	const a = await nextFrame(reader)
	const b = await nextFrame(reader)
	t.equal([ frameNumber(a), frameNumber(b) ], [ 0, 1 ])
	await sleep(50)
	t.equal(reader.next(), null)
	t.equal(reader.ended, false)
	reader.release(a)
	reader.release(a)
	const c = await nextFrame(reader)
	t.equal(frameNumber(c), 2)
	t.equal(frameNumber(b), 1)
	reader.release(b)
	reader.release(c)
	t.equal((await readNext(reader)).length, 17)
	reader.close()
	file.close()
})

T.test("video feed follows a seek and a loop", async (t) => {
	t.timeout(10e3)
	const { file, reader } = await attachVideo('vp9.webm')
	await readNext(reader, 3)
	const segment = file.seek(1.5)
	let frame = await nextFrame(reader)
	while (frame.segment !== segment) {
		reader.release(frame)
		frame = await nextFrame(reader)
	}
	t.equal(frameNumber(frame), 15)
	reader.release(frame)
	file.setLoop(true)
	const frames = await readNext(reader, 10)
	t.equal(frames.map((x) => x.number), [ 16, 17, 18, 19, 0, 1, 2, 3, 4, 5 ])
	t.ok(frames[4].segment > segment)
	file.setLoop(false)
	const rest = await readNext(reader)
	t.equal(rest.at(-1).number, 19)
	t.ok(reader.ended)
	reader.close()
	file.close()
})

T.test("a reopened video feed reader continues where the old one stopped", async (t) => {
	t.timeout(10e3)
	const { file, feed, reader } = await attachVideo('vp9.webm')
	const before = await readNext(reader, 8)
	t.throws(() => M.createVideoFeedReader(feed, GRAY), /already has a reader/u)
	reader.close()
	t.equal(reader.next(), null)
	await reader.wait()

	const second = M.createVideoFeedReader(feed, { format: 'yuv420p', width: 32, height: 16 })
	const frame = await nextFrame(second)
	t.equal(frame.planes.map((x) => x.length), [ 32 * 16, 16 * 8, 16 * 8 ])
	t.ok(near(frame.timestamp, 0.8, 1e-3), { timestamp: frame.timestamp })
	t.ok(frame.segment > before.at(-1).segment)
	second.release(frame)
	const after = await readNext(second)
	t.equal(after.length, 11)
	second.close()
	file.close()
})

T.test("detaching a video feed wakes its reader, and another file can take over", async (t) => {
	t.timeout(10e3)
	const { file, feed, reader } = await attachVideo('vp9.webm', { ...GRAY, frames: 2 })
	const held = await nextFrame(reader)
	await nextFrame(reader)
	const waiting = reader.wait()
	file.detach(feed)
	await waiting
	t.equal(reader.next(), null)
	t.equal(reader.ended, false)
	t.equal(frameNumber(held), 0)
	reader.release(held)

	const other = await M.open(fixture('vp8.webm'))
	other.attach(feed, other.tracks[0])
	const frames = await readNext(reader)
	t.equal(frames.length, 20)
	t.ok(frames.every((x) => x.file === other.id))
	t.ok(reader.ended)
	t.equal(file.tracks[0].createReader({ format: 'gray' }).width, file.tracks[0].width)
	reader.close()
	other.close()
	file.close()
})

T.test("video feed reports a failing source", async (t) => {
	t.timeout(10e3)
	const bytes = Fs.readFileSync(fixture('short-audio.webm'))
	const source = M.createByteSource({ size: bytes.length })
	source.push(0, bytes.subarray(0, bytes.length >> 1))
	const file = await M.open(source)
	file.on('decodeError', () => {})
	const feed = M.createVideoFeed()
	const reader = M.createVideoFeedReader(feed, GRAY)
	file.attach(feed, file.tracks.find((x) => x.type === 'video'))
	source.fail("network down")
	const frames = await readNext(reader)
	t.ok(frames.length > 0, frames.length)
	t.ok(reader.ended)
	t.equal(reader.error.message, "network down")
	t.equal(reader.error.fatal, true)
	t.ok(reader.error.errno < 0)
	reader.close()
	file.close()
})

T.test("video feed reader on a worker thread", async (t) => {
	t.timeout(10e3)
	const file = await M.open(fixture('vp9.webm'))
	const feed = M.createVideoFeed()
	file.attach(feed, file.tracks[0])
	const worker = new Worker(`
		const { parentPort, workerData } = require('node:worker_threads')
		const M = require(workerData.module)
		const reader = M.createVideoFeedReader(workerData.feed, { format: 'gray', width: 64, height: 48 })
		const step = async () => {
			const numbers = []
			for (;;) {
				const frame = reader.next()
				if (frame) {
					numbers.push(Math.round((frame.planes[0][0] - 16) / 10))
					reader.release(frame)
					continue
				}
				if (reader.ended) { break }
				await reader.wait()
			}
			reader.close()
			parentPort.postMessage(numbers)
		}
		step()
	`, { eval: true, workerData: { feed, module: `${root}/src/javascript/index.js` } })
	const numbers = await new Promise((resolve, reject) => {
		worker.once('message', resolve)
		worker.once('error', reject)
	})
	t.equal(numbers, Array.from({ length: 20 }, (_, i) => i))
	await worker.terminate()
	file.close()
})

T.test("video feed keeps working after a reader dies with its worker", async (t) => {
	t.timeout(10e3)
	const file = await M.open(fixture('vp9.webm'))
	const feed = M.createVideoFeed()
	file.attach(feed, file.tracks[0])
	const worker = new Worker(`
		const { parentPort, workerData } = require('node:worker_threads')
		const M = require(workerData.module)
		const reader = M.createVideoFeedReader(workerData.feed, { format: 'rgba', width: 640, height: 480 })
		const step = async () => {
			let count = 0
			while (count < 5) {
				const frame = reader.next()
				if (frame) {
					count += 1
					reader.release(frame)
					continue
				}
				await reader.wait()
			}
			parentPort.postMessage(count)
			setInterval(() => {}, 1000)
		}
		step()
	`, { eval: true, workerData: { feed, module: `${root}/src/javascript/index.js` } })
	const consumed = await new Promise((resolve, reject) => {
		worker.once('message', resolve)
		worker.once('error', reject)
	})
	await worker.terminate()
	const reader = M.createVideoFeedReader(feed, GRAY)
	const frames = await readNext(reader)
	t.ok(frames[0].number >= consumed, frames[0])
	t.equal(frames.at(-1).number, 19)
	reader.close()
	file.close()
})

T.test("video feed validation", async (t) => {
	t.timeout(10e3)
	const file = await M.open(fixture('short-audio.webm'))
	const video = file.tracks.find((x) => x.type === 'video')
	const audio = file.tracks.find((x) => x.type === 'audio')
	const feed = M.createVideoFeed()
	t.throws(() => file.attach(feed), /needs a video track/u)
	t.throws(() => file.attach(feed, audio), /not an audio track|not a video track/u)
	t.throws(() => file.attach(M.createFeed(), video), /not an audio track/u)
	t.throws(() => M.createFeedReader(feed, { sampleRate: 48000 }), /not a feed/u)
	t.throws(() => M.getPosition(feed), /not a feed/u)
	t.throws(() => M.createVideoFeedReader(M.createFeed(), GRAY), /not a video feed/u)
	t.throws(() => M.createVideoFeedReader(feed), /options/u)
	t.throws(() => M.createVideoFeedReader(feed, { width: 4, height: 4 }), /invalid format/u)
	t.throws(() => M.createVideoFeedReader(feed, { format: 'gray', height: 4 }), /width/u)
	t.throws(() => M.createVideoFeedReader(feed, { ...GRAY, frames: 1 }), /frames/u)
	t.equal(M.getFeedUserData(feed).length, M.getFeedUserData(M.createFeed()).length)

	const reader = M.createVideoFeedReader(feed, GRAY)
	t.throws(() => reader.at({}), /time/u)
	t.throws(() => reader.at({ time: 0, segment: 0.5 }), /segment/u)
	file.attach(feed, video)
	t.throws(() => file.attach(feed, video), /already attached to this file/u)
	t.throws(() => video.createReader(), /already has a reader/u)
	const other = await M.open(fixture('vp9.webm'))
	t.throws(() => other.attach(feed, other.tracks[0]), /attached to another file/u)
	file.detach(feed)
	other.attach(feed, other.tracks[0])
	t.equal((await readNext(reader)).length, 20)
	reader.close()
	other.close()
	file.close()
})
