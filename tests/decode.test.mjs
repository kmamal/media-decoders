import T from '@kmamal/testing'
import Fs from 'node:fs'
import M from '../src/javascript/index.js'
import { fixture, readAll, near } from './helpers/common.mjs'

const CODEC_FIXTURES = {
	vp8: 'vp8.webm',
	vp9: 'vp9.webm',
	av1: 'av1.webm',
	theora: 'theora.ogv',
	h264: 'h264.mp4',
	hevc: 'hevc.mp4',
}

T.test("decoders list", (t) => {
	for (const codec of [ 'vp8', 'vp9', 'av1', 'theora', 'opus', 'vorbis', 'flac', 'mp3', 'pcm_s16le' ]) {
		t.ok(M.decoders.includes(codec), { codec })
	}
	t.ok(!M.decoders.includes('mpeg2video'))
	t.equal(typeof M.versions.ffmpeg, 'string')
})

for (const [ codec, name ] of Object.entries(CODEC_FIXTURES)) {
	T.test(`decode ${codec}`, async (t) => {
		t.timeout(10e3)
		if (!M.decoders.includes(codec)) { return }
		const file = await M.open(fixture(name))
		t.ok(near(file.duration, 2, 0.01), { duration: file.duration })
		const track = file.tracks.find((x) => x.type === 'video')
		t.equal(track.codec, codec)
		t.equal(track.decodable, true)
		t.equal(track.width, 64)
		t.equal(track.height, 48)

		const frames = await readAll(track.createReader({ format: 'gray' }))
		t.equal(frames.length, 20)
		frames.forEach((frame, index) => {
			t.equal(frame.number, index, { frame })
			t.ok(near(frame.timestamp, index / 10, 1e-3), { frame })
			t.ok(near(frame.duration, 0.1, 1e-3), { frame })
			t.equal(frame.segment, 0)
		})
		file.close()
	})
}

T.test("frame buffers are shared and can't be detached", async (t) => {
	t.timeout(10e3)
	const file = await M.open(fixture('vp9.webm'))
	const reader = file.tracks[0].createReader({ format: 'gray' })
	const frame = await reader.read()
	const { buffer } = frame.data
	t.ok(buffer instanceof SharedArrayBuffer)
	t.throws(() => structuredClone(buffer, { transfer: [ buffer ] }))
	t.equal(buffer.byteLength > 0, true)
	const clone = structuredClone(frame.data)
	t.equal(clone[0], frame.data[0])
	reader.release(frame)
	const frames = await readAll(reader)
	t.equal(frames.length, 19)
	file.close()
})

T.test("open from buffer", async (t) => {
	t.timeout(10e3)
	const file = await M.open(Fs.readFileSync(fixture('vp9.webm')))
	const frames = await readAll(file.tracks[0].createReader({ format: 'gray' }))
	t.equal(frames.map((x) => x.number), Array.from({ length: 20 }, (_, i) => i))
	file.close()
})

T.test("open from file URL", async (t) => {
	const { pathToFileURL } = await import('node:url')
	const file = await M.open(pathToFileURL(fixture('vp9.webm')))
	t.equal(file.tracks.length, 1)
	file.close()
})

T.test("open errors", async (t) => {
	t.timeout(10e3)
	await t.throwsAsync(() => M.open(fixture('does-not-exist.webm')))
	await t.throwsAsync(() => M.open(Buffer.from('definitely not a media file')))
})

T.test("frame formats", async (t) => {
	t.timeout(10e3)
	const file = await M.open(fixture('vp9.webm'))
	const reader = file.tracks[0].createReader({ format: 'yuv420p', width: 31, height: 17 })
	const frame = await reader.read()
	t.equal(frame.format, 'yuv420p')
	t.equal(frame.width, 31)
	t.equal(frame.height, 17)
	t.equal(frame.displayWidth, 64)
	t.equal(frame.displayHeight, 48)
	t.equal(frame.planes.length, 3)
	t.equal(frame.planes[0].length, 31 * 17)
	t.equal(frame.planes[1].length, 16 * 9)
	t.equal(frame.planes[2].length, 16 * 9)
	t.equal(frame.data, undefined)
	t.equal(frame.matrix, 'bt601')
	t.equal(frame.fullRange, false)
	t.equal(frame.transfer, 'sdr')
	t.equal(frame.planes[0][0], 16)
	t.equal(frame.planes[1][0], 128)
	file.close()

	const file2 = await M.open(fixture('vp9.webm'))
	const reader2 = file2.tracks[0].createReader()
	const frame2 = await reader2.read()
	t.equal(frame2.format, 'rgba')
	t.equal(frame2.data.length, 64 * 48 * 4)
	t.equal(frame2.matrix, undefined)
	t.equal([ ...frame2.data.subarray(0, 4) ], [ 0, 0, 0, 255 ])
	t.throws(() => file2.tracks[0].createReader())
	file2.close()
})

const TARGET = [ 200, 50, 100 ]
const COLOR_FIXTURES = [
	[ 'hd-bt601.webm', 'bt601', false ],
	[ 'hd-bt709.webm', 'bt709', false ],
	[ 'untagged-sd.webm', 'bt601', false ],
	[ 'untagged-hd.webm', 'bt709', false ],
	[ 'full-range.webm', 'bt709', true ],
	[ 'ten-bit.webm', 'bt709', false ],
	[ 'yuv444.webm', 'bt709', false ],
]

for (const [ name, matrix, fullRange ] of COLOR_FIXTURES) {
	T.test(`colour ${name}`, async (t) => {
		t.timeout(10e3)
		const file = await M.open(fixture(name))
		const track = file.tracks[0]
		t.equal(track.matrix, matrix)
		t.equal(track.fullRange, fullRange)

		const rgba = await track.createReader({ format: 'rgba', width: 16, height: 16 }).read()
		const pixel = [ ...rgba.data.subarray(0, 3) ]
		t.ok(pixel.every((value, i) => Math.abs(value - TARGET[i]) <= 6), { pixel })
		file.close()

		const file2 = await M.open(fixture(name))
		const yuv = await file2.tracks[0].createReader({ format: 'yuv420p', width: 16, height: 16 }).read()
		t.equal(yuv.matrix, matrix)
		t.equal(yuv.fullRange, fullRange)
		file2.close()

		const file3 = await M.open(fixture(name))
		const gray = await file3.tracks[0].createReader({ format: 'gray', width: 16, height: 16 }).read()
		t.equal(gray.data.length, 256)
		t.ok(Math.abs(gray.data[0] - yuv.planes[0][0]) <= 1, { gray: gray.data[0], yuv: yuv.planes[0][0] })
		file3.close()
	})
}

T.test("transfer", async (t) => {
	t.timeout(10e3)
	const file = await M.open(fixture('pq.webm'))
	t.equal(file.tracks[0].transfer, 'pq')
	t.equal(file.tracks[0].matrix, 'bt2020')
	const frame = await file.tracks[0].createReader({ format: 'yuv420p' }).read()
	t.equal(frame.transfer, 'pq')
	t.equal(frame.matrix, 'bt2020')
	file.close()
})

T.test("non-square pixels", async (t) => {
	t.timeout(10e3)
	const file = await M.open(fixture('sar.webm'))
	const track = file.tracks[0]
	t.equal(track.width, 64)
	t.equal(track.height, 48)
	t.equal(track.displayWidth, 72)
	t.equal(track.displayHeight, 48)
	const frame = await track.createReader({ width: 36, height: 24 }).read()
	t.equal(frame.width, 36)
	t.equal(frame.displayWidth, 72)
	t.equal(frame.displayHeight, 48)
	file.close()
})

const firstFrame = async (name, options) => {
	const file = await M.open(fixture(name))
	const track = file.tracks[0]
	const frame = await track.createReader(options).read()
	file.close()
	return { track, frame }
}

const orientPlane = (plane, width, height, bytes, from) => {
	const out = new Uint8Array(plane.length)
	const outWidth = height
	for (let y = 0; y < width; y++) {
		for (let x = 0; x < outWidth; x++) {
			const [ sx, sy ] = from(x, y)
			for (let k = 0; k < bytes; k++) { out[(y * outWidth + x) * bytes + k] = plane[(sy * width + sx) * bytes + k] }
		}
	}
	return out
}

const maxDiff = (a, b) => {
	let diff = 0
	for (let i = 0; i < a.length; i++) { diff = Math.max(diff, Math.abs(a[i] - b[i])) }
	return diff
}

for (const [ name, rotation, flip, from ] of [
	[ 'orient-90.mp4', 90, false, (w, h) => (x, y) => [ y, h - 1 - x ] ],
	[ 'orient-flip.mp4', 90, true, (w, h) => (x, y) => [ w - 1 - y, h - 1 - x ] ],
]) {
	T.test(`display matrix: ${name}`, async (t) => {
		t.timeout(10e3)
		for (const format of [ 'gray', 'yuv420p', 'rgba' ]) {
			const base = await firstFrame('orient.mp4', { format })
			const { track, frame } = await firstFrame(name, { format })
			t.equal(track.width, 34)
			t.equal(track.height, 18)
			t.equal(track.rotation, rotation)
			t.equal(track.flip, flip)
			t.equal(track.displayWidth, 18)
			t.equal(track.displayHeight, 34)
			t.equal(frame.width, 18)
			t.equal(frame.height, 34)
			t.equal(frame.planes.length, base.frame.planes.length)
			for (let i = 0; i < frame.planes.length; i++) {
				const width = i === 0 ? 34 : 17
				const height = i === 0 ? 18 : 9
				const bytes = format === 'rgba' ? 4 : 1
				const expected = orientPlane(base.frame.planes[i], width, height, bytes, from(width, height))
				const diff = maxDiff(frame.planes[i], expected)
				t.ok(diff <= (format === 'rgba' ? 2 : 0), { format, plane: i, diff })
			}
		}
	})
}

T.test("display matrix with a scaled reader", async (t) => {
	t.timeout(10e3)
	const { frame } = await firstFrame('orient-90.mp4', { format: 'rgba', width: 9, height: 17 })
	t.equal(frame.width, 9)
	t.equal(frame.height, 17)
	t.equal(frame.data.length, 9 * 17 * 4)
})

T.test("rgba frames with widths that are not a multiple of 16", async (t) => {
	t.timeout(10e3)
	const { frame } = await firstFrame('orient.mp4', { format: 'rgba' })
	t.equal(frame.width, 34)
	let opaque = true
	for (let i = 3; i < frame.data.length; i += 4) { opaque &&= frame.data[i] === 255 }
	t.ok(opaque)
})

T.test("no display matrix", async (t) => {
	const { track } = await firstFrame('orient.mp4', { format: 'gray' })
	t.equal(track.rotation, 0)
	t.equal(track.flip, false)
	t.equal(track.displayWidth, 34)
})

T.test("track that starts late", async (t) => {
	t.timeout(10e3)
	const file = await M.open(fixture('late-video.webm'))
	t.equal(file.startTime, 0)
	t.ok(near(file.duration, 2.5, 0.01), { duration: file.duration })
	const track = file.tracks.find((x) => x.type === 'video')
	t.ok(near(track.startTime, 0.5, 1e-3))
	const frames = await readAll(track.createReader({ format: 'gray' }))
	t.equal(frames.length, 21)
	t.equal(frames[0].timestamp, 0)
	t.ok(near(frames[0].duration, 0.5, 1e-3))
	t.equal(frames[0].luma, 16)
	t.ok(near(frames[1].timestamp, 0.5, 1e-3))
	t.equal(frames[1].number, 0)
	file.close()
})
