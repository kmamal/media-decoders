import T from '@kmamal/testing'
import M from '../src/javascript/index.js'
import { fixture, readAll, sleep } from './helpers/common.mjs'

const tracks = (file) => [
	file.tracks.find((x) => x.type === 'video').createReader({ format: 'gray' }),
	file.tracks.find((x) => x.type === 'audio').createReader({ sampleRate: 48000 }),
]

T.test("a full packet queue stalls the other tracks until it drains", async (t) => {
	t.timeout(10e3)
	const file = await M.open(fixture('late-video.webm'), { maxQueuedBytes: 1 })
	const [ video, audio ] = tracks(file)
	let frames = 0
	const reading = (async () => {
		let block
		while ((block = await audio.readChannels(0.1))) { frames += block.frames }
	})()
	let done = false
	reading.then(() => { done = true })
	await sleep(300)
	t.ok(!done)
	t.ok(frames < 120000, { frames })
	const images = await readAll(video)
	await reading
	t.equal(images.length, 21)
	t.equal(frames, 120000)
	file.close()
})

T.test("unbounded packet queues let the tracks be read one after the other", async (t) => {
	t.timeout(10e3)
	const file = await M.open(fixture('late-video.webm'), { maxQueuedBytes: Infinity })
	const [ video, audio ] = tracks(file)
	let frames = 0
	while (frames < 120000) {
		const block = await audio.readChannels(0.1)
		frames += block.frames
	}
	t.equal(frames, 120000)
	const images = await readAll(video)
	t.equal(images.length, 21)
	t.equal(await audio.readChannels(0.1), null)
	file.close()
})

T.test("maxQueuedBytes must be a positive number", (t) => {
	for (const maxQueuedBytes of [ 0, -1, NaN, '1', null ]) {
		t.throws(() => M.open(fixture('vp9.webm'), { maxQueuedBytes }))
	}
})
