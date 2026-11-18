import T from '@kmamal/testing'
import M from '../src/javascript/index.js'
import { fixture, readAll, near } from './helpers/common.mjs'

T.test("a closed video reader ends its reads", async (t) => {
	t.timeout(10e3)
	const file = await M.open(fixture('vp9.webm'))
	const track = file.tracks[0]
	const reader = track.createReader({ format: 'gray' })
	const frame = await reader.read()
	const pending = (async () => {
		await reader.read()
		return reader.read()
	})()
	reader.close()
	t.equal(await pending, null)
	t.ok(reader.closed)
	t.ok(reader.ended)
	t.equal(reader.tryRead(), null)
	reader.release(frame)
	reader.close()
	file.close()
})

T.test("a new video reader with other options continues where the old one stopped", async (t) => {
	t.timeout(10e3)
	const file = await M.open(fixture('vp9.webm'))
	const track = file.tracks[0]
	const first = track.createReader({ format: 'gray' })
	const before = await readAll(first, 8)
	t.equal(before.at(-1).number, 7)
	t.throws(() => track.createReader())
	first.close()

	const second = track.createReader({ format: 'gray', width: 32, height: 16 })
	t.equal(second.width, 32)
	const frame = await second.read()
	t.equal(frame.planes[0].length, 32 * 16)
	t.ok(near(frame.timestamp, 0.8, 1e-3), { timestamp: frame.timestamp })
	t.ok(frame.segment > before.at(-1).segment)
	second.release(frame)
	const after = await readAll(second)
	t.equal(after.length, 11)
	t.ok(near(after.at(-1).timestamp, 1.9, 1e-3))
	file.close()
})

T.test("a reader closed before reading leaves the file at the start", async (t) => {
	t.timeout(10e3)
	const file = await M.open(fixture('vp9.webm'))
	const track = file.tracks[0]
	track.createReader({ format: 'gray' }).close()
	const frames = await readAll(track.createReader({ format: 'gray' }))
	t.equal(frames.length, 20)
	t.equal(frames[0].number, 0)
	t.equal(frames[0].segment, 0)
	file.close()
})

T.test("a new audio reader continues where the old one stopped", async (t) => {
	t.timeout(10e3)
	const file = await M.open(fixture('sine.wav'))
	const track = file.tracks[0]
	const first = track.createReader()
	const block = await first.readChannels(0.4)
	t.equal(block.frames, 17640)
	const pending = first.readChannels(10)
	first.close()
	t.equal(await pending, null)
	t.ok(first.ended)
	t.equal(await first.readChannels(), null)

	const second = track.createReader({ sampleRate: 48000 })
	let frames = 0
	let start = -1
	let next
	while ((next = await second.readChannels(0.1))) {
		if (start < 0) { start = next.timestamp }
		frames += next.frames
	}
	t.ok(start >= 0.4 - 1e-3 && start <= 0.4 + 0.1, { start })
	t.ok(near(frames / 48000, 1 - start, 2e-3), { frames, start })
	file.close()
})

T.test("a track can be attached to a feed after its reader closes", async (t) => {
	t.timeout(10e3)
	const file = await M.open(fixture('sine.wav'))
	const track = file.tracks[0]
	const reader = track.createReader()
	await reader.readChannels(0.25)
	t.throws(() => file.attach(M.createFeed(), track))
	reader.close()
	const feed = M.createFeed()
	file.attach(feed, track)
	const feedReader = M.createFeedReader(feed, { sampleRate: 44100 })
	const channels = [ new Float32Array(1024) ]
	let frames = 0
	while (!feedReader.ended) {
		await feedReader.wait(1024)
		frames += feedReader.readInto(channels)
	}
	t.ok(frames > 0.7 * 44100 && frames <= 0.75 * 44100 + 1024, { frames })
	feedReader.close()
	file.close()
})

T.test("closing the video reader leaves the audio reader alone", async (t) => {
	t.timeout(10e3)
	const file = await M.open(fixture('short-audio.webm'))
	const video = file.tracks.find((x) => x.type === 'video').createReader()
	const audio = file.tracks.find((x) => x.type === 'audio').createReader({ sampleRate: 48000 })
	const frame = await video.read()
	video.release(frame)
	let block = await audio.readChannels(0.25)
	let end = block.timestamp + block.frames / 48000
	video.close()
	while ((block = await audio.readChannels(0.25))) {
		t.equal(block.segment, 0)
		t.ok(near(block.timestamp, end, 1e-6), { timestamp: block.timestamp, end })
		end += block.frames / 48000
	}
	t.ok(near(end, 1, 2e-3), { end })
	file.close()
})
