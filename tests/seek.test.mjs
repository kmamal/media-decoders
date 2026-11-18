import T from '@kmamal/testing'
import M from '../src/javascript/index.js'
import { fixture, frameNumber, readAll, readSegment, near } from './helpers/common.mjs'

const FIXTURES = [ 'vp9.webm', 'av1.webm', 'theora.ogv', 'vp9.mp4', 'h264.mp4' ]

for (const name of FIXTURES) {
	T.test(`seek ${name}`, async (t) => {
		t.timeout(10e3)
		const codec = name === 'h264.mp4' ? 'h264' : null
		if (codec && !M.decoders.includes(codec)) { return }

		const file = await M.open(fixture(name))
		const reader = file.tracks[0].createReader({ format: 'gray' })

		let frame = await reader.read()
		t.equal(frameNumber(frame), 0)

		for (const [ time, expected ] of [ [ 1.55, 15 ], [ 0.33, 3 ], [ 1.95, 19 ], [ 0, 0 ], [ 5, 19 ], [ 0.7, 7 ] ]) {
			const segment = file.seek(time)
			reader.release(frame)
			frame = await readSegment(reader, segment)
			t.equal(frame.segment, segment)
			t.equal(frameNumber(frame), expected, { time })
			t.ok(near(frame.timestamp, expected / 10, 1e-3))
		}
		reader.release(frame)
		file.close()
	})

	T.test(`step ${name}`, async (t) => {
		t.timeout(10e3)
		if (name === 'h264.mp4' && !M.decoders.includes('h264')) { return }

		const file = await M.open(fixture(name))
		const reader = file.tracks[0].createReader({ format: 'gray' })
		let frame = await reader.read()
		for (let i = 1; i < 20; i++) {
			const segment = file.seek(frame.timestamp + frame.duration)
			reader.release(frame)
			frame = await readSegment(reader, segment)
			t.equal(frameNumber(frame), i)
		}
		reader.release(frame)
		t.equal(await reader.read(), null)
		t.equal(reader.ended, true)
		file.close()
	})
}

T.test("loop", async (t) => {
	t.timeout(10e3)
	const file = await M.open(fixture('vp9.webm'))
	file.setLoop(true)
	const frames = await readAll(file.tracks[0].createReader({ format: 'gray' }), 50)
	t.equal(frames.length, 50)
	frames.forEach((frame, index) => {
		t.equal(frame.number, index % 20)
		t.equal(frame.segment, Math.floor(index / 20))
		t.ok(near(frame.timestamp, (index % 20) / 10, 1e-3))
	})
	file.close()
})

T.test("loop turned off", async (t) => {
	t.timeout(10e3)
	const file = await M.open(fixture('vp9.webm'))
	file.setLoop(true)
	const reader = file.tracks[0].createReader({ format: 'gray' })
	const first = await readAll(reader, 25)
	file.setLoop(false)
	const rest = await readAll(reader)
	const all = [ ...first, ...rest ]
	t.equal(all.at(-1).number, 19)
	t.equal(all.at(-1).segment, 1)
	t.equal(reader.ended, true)
	file.close()
})

T.test("seek after end", async (t) => {
	t.timeout(10e3)
	const file = await M.open(fixture('vp9.webm'))
	const reader = file.tracks[0].createReader({ format: 'gray' })
	await readAll(reader)
	t.equal(reader.ended, true)
	const segment = file.seek(0.5)
	t.equal(reader.ended, false)
	const frame = await readSegment(reader, segment)
	t.equal(frameNumber(frame), 5)
	file.close()
})

T.test("close while waiting", async (t) => {
	t.timeout(10e3)
	const file = await M.open(fixture('vp9.webm'))
	const reader = file.tracks[0].createReader({ format: 'gray', frames: 2 })
	const held = [ await reader.read(), await reader.read() ]
	const promise = reader.wait()
	file.close()
	await promise
	t.equal(reader.tryRead(), null)
	t.equal(reader.ended, true)
	t.equal(held.length, 2)
})

T.test("loop turned on after the end", async (t) => {
	t.timeout(10e3)
	const file = await M.open(fixture('vp9.webm'))
	const reader = file.tracks[0].createReader({ format: 'gray' })
	const first = await readAll(reader)
	t.equal(first.length, 20)
	t.equal(reader.ended, true)
	file.setLoop(true)
	t.equal(reader.ended, false)
	const second = await readAll(reader, 5)
	t.equal(second.map((x) => x.number), [ 0, 1, 2, 3, 4 ])
	t.equal(second[0].segment, 1)
	file.close()
})
