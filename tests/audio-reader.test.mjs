import T from '@kmamal/testing'
import Fs from 'node:fs'
import M from '../src/javascript/index.js'
import { fixture, sleep, multichannelWav } from './helpers/common.mjs'

const audioReader = async (name, options) => {
	const file = await M.open(fixture(name))
	const track = file.tracks.find((x) => x.type === 'audio')
	const reader = track.createReader(options)
	return { file, reader }
}

T.test("audio reader matches decodeAudio", async (t) => {
	t.timeout(10e3)
	const expected = await M.decodeAudio(Fs.readFileSync(fixture('stereo-f32.wav')), { sampleRate: 48000 })
	const { file, reader } = await audioReader('stereo-f32.wav', { sampleRate: 48000 })
	t.equal(reader.sampleRate, 48000)
	t.equal(reader.channels, 2)
	let length = 0
	let difference = 0
	for (;;) {
		const block = await reader.readChannels(0.3)
		if (!block) { break }
		t.equal(block.channels.length, 2)
		t.equal(block.segment, 0)
		t.ok(Math.abs(block.timestamp - length / 48000) < 1e-9)
		for (let c = 0; c < 2; c++) {
			t.equal(block.channels[c].length, block.frames)
			for (let i = 0; i < block.frames; i++) {
				difference = Math.max(difference, Math.abs(block.channels[c][i] - expected.channels[c][length + i]))
			}
		}
		length += block.frames
	}
	t.equal(length, expected.channels[0].length)
	t.equal(difference, 0)
	t.ok(reader.ended)
	t.equal(await reader.readChannels(), null)
	file.close()
})

T.test("audio reader blocks", async (t) => {
	t.timeout(10e3)
	const { file, reader } = await audioReader('sine.wav')
	t.equal(reader.sampleRate, 44100)
	const first = await reader.readChannels()
	t.equal(first.frames, 44100)
	t.equal(first.channels[0].length, 44100)
	t.equal(await reader.readChannels(), null)
	file.close()

	const second = await audioReader('sine.wav')
	const block = await second.reader.readChannels(0.75)
	t.equal(block.frames, Math.round(0.75 * 44100))
	const rest = await second.reader.readChannels(0.75)
	t.equal(rest.frames, 44100 - block.frames)
	t.equal(rest.channels[0].length, rest.frames)
	second.file.close()
})

T.test("audio reader fills the arrays it is given", async (t) => {
	t.timeout(10e3)
	const { file, reader } = await audioReader('stereo-f32.wav')
	const channels = [ new Float32Array(30000), new Float32Array(30000), new Float32Array(30000).fill(1) ]
	const block = await reader.readChannelsInto(channels)
	t.equal(block.channels, channels)
	t.equal(block.frames, 30000)
	t.ok(channels[0].some((x) => x !== 0))
	t.ok(channels[2].every((x) => x === 0))
	const rest = await reader.readChannelsInto(channels)
	t.equal(rest.frames, 44100 - 30000)
	t.ok(channels[0].subarray(rest.frames).every((x) => x === 0))
	t.equal(await reader.readChannelsInto(channels), null)
	file.close()
})

T.test("audio reader mixes interleaved and channel reads", async (t) => {
	t.timeout(10e3)
	const expected = await M.decodeAudio(Fs.readFileSync(fixture('stereo-f32.wav')))
	const { file, reader } = await audioReader('stereo-f32.wav')
	const first = await reader.readInterleaved(0.5)
	t.equal(first.channels, 2)
	t.equal(first.data.length, first.frames * 2)
	const data = new Float32Array(1000 * 2)
	const second = await reader.readInterleavedInto(data)
	t.equal(second.data, data)
	t.equal(second.frames, 1000)
	let same = true
	for (let i = 0; i < first.frames; i++) {
		if (first.data[2 * i] !== expected.channels[0][i] || first.data[2 * i + 1] !== expected.channels[1][i]) { same = false }
	}
	for (let i = 0; i < second.frames; i++) {
		const at = first.frames + i
		if (data[2 * i] !== expected.channels[0][at] || data[2 * i + 1] !== expected.channels[1][at]) { same = false }
	}
	const third = await reader.readChannels(0.1)
	t.equal(third.channels.length, 2)
	for (let i = 0; i < third.frames; i++) {
		const at = first.frames + second.frames + i
		if (third.channels[0][i] !== expected.channels[0][at] || third.channels[1][i] !== expected.channels[1][at]) { same = false }
	}
	t.ok(same)
	file.close()
})

T.test("audio reader blocks end at segment boundaries", async (t) => {
	t.timeout(10e3)
	const { file, reader } = await audioReader('sine.wav')
	file.setLoop(true)
	const blocks = []
	for (let i = 0; i < 4; i++) {
		const { frames, timestamp, segment } = await reader.readChannels(0.4)
		blocks.push({ frames, timestamp, segment })
	}
	t.equal(blocks[2].frames, 44100 - 2 * 17640)
	t.equal(blocks[2].segment, 0)
	t.equal(blocks[3].segment, 1)
	t.equal(blocks[3].timestamp, 0)
	t.equal(blocks[3].frames, 17640)

	const segment = file.seek(0.5)
	let block
	do { block = await reader.readChannels(0.1) } while (block.segment !== segment)
	t.ok(Math.abs(block.timestamp - 0.5) < 1e-3)
	file.close()
})

T.test("audio reader loops a file of unknown duration", async (t) => {
	t.timeout(10e3)
	const { file, reader } = await audioReader('unknown-duration.mkv')
	t.equal(file.duration, 0)
	file.setLoop(true)
	const segments = new Set()
	let frames = 0
	while (frames < 3 * 44100) {
		const block = await reader.readChannels(0.25)
		frames += block.frames
		segments.add(block.segment)
	}
	t.ok(segments.size >= 3)
	t.ok(!reader.ended)
	file.setLoop(false)
	let block
	do { block = await reader.readChannels(0.25) } while (block)
	t.ok(reader.ended)
	file.close()
})

T.test("audio reader loops a file of unknown duration after a seek past its end", async (t) => {
	t.timeout(10e3)
	const { file, reader } = await audioReader('unknown-duration.mkv')
	file.setLoop(true)
	await reader.readChannels(0.1)
	const segment = file.seek(5)
	const segments = new Set()
	for (let i = 0; i < 12; i++) {
		const block = await reader.readChannels(0.25)
		t.ok(block)
		if (block.segment >= segment) { segments.add(block.segment) }
	}
	t.ok(segments.size >= 2)
	file.close()
})

T.test("audio reader loops a file of unknown duration that has ended", async (t) => {
	t.timeout(10e3)
	const { file, reader } = await audioReader('unknown-duration.mkv')
	let block
	do { block = await reader.readChannels(0.5) } while (block)
	t.ok(reader.ended)
	file.setLoop(true)
	for (let i = 0; i < 6; i++) {
		block = await reader.readChannels(0.5)
		t.ok(block)
		t.ok(block.segment >= 1)
	}
	t.ok(!reader.ended)
	file.close()
})

T.test("audio reader ends when the file closes", async (t) => {
	t.timeout(10e3)
	const { file, reader } = await audioReader('sine.wav')
	const pending = reader.readChannels()
	file.close()
	t.equal(await pending, null)
	t.ok(reader.ended)
})

T.test("audio reader validation", async (t) => {
	t.timeout(10e3)
	const { file, reader } = await audioReader('sine.wav')
	const track = file.tracks.find((x) => x.type === 'audio')
	t.throws(() => track.createReader())
	t.throws(() => file.attach(M.createFeed(), track))
	t.throws(() => reader.readChannels(0))
	t.throws(() => reader.readChannels([ new Float32Array(10) ]))
	t.throws(() => reader.readInterleaved(0))
	t.throws(() => reader.readChannelsInto([]))
	t.throws(() => reader.readChannelsInto(new Float32Array(10)))
	t.throws(() => reader.readInterleavedInto([ new Float32Array(10) ]))
	t.throws(() => reader.readInterleavedInto(new Float32Array(0)))
	file.close()

	const other = await M.open(fixture('sine.wav'))
	const otherTrack = other.tracks.find((x) => x.type === 'audio')
	t.throws(() => otherTrack.createReader({ sampleRate: 100 }))
	other.close()
	t.throws(() => otherTrack.createReader())
})

T.test("decodeAudioInterleaved", async (t) => {
	t.timeout(10e3)
	const bytes = Fs.readFileSync(fixture('stereo-f32.wav'))
	const planar = await M.decodeAudio(bytes, { sampleRate: 48000 })
	const interleaved = await M.decodeAudioInterleaved(bytes, { sampleRate: 48000 })
	t.equal(interleaved.sampleRate, 48000)
	t.equal(interleaved.channels, 2)
	t.equal(interleaved.data.length, planar.channels[0].length * 2)
	let same = true
	for (let i = 0; i < planar.channels[0].length; i++) {
		if (interleaved.data[2 * i] !== planar.channels[0][i] || interleaved.data[2 * i + 1] !== planar.channels[1][i]) { same = false }
	}
	t.ok(same)
})

T.test("audio reader resumes after a seek past the end", async (t) => {
	t.timeout(10e3)
	const { file, reader } = await audioReader('sine.wav')
	let drained = await reader.readChannels()
	while (drained) { drained = await reader.readChannels() }
	t.ok(reader.ended)
	const segment = file.seek(0.5)
	let block
	do { block = await reader.readChannels(0.1) } while (block && block.segment !== segment)
	t.ok(block)
	t.ok(Math.abs(block.timestamp - 0.5) < 1e-3)
	file.close()
})

T.test("audio reader ends after a seek to the end", async (t) => {
	t.timeout(10e3)
	const { file, reader } = await audioReader('sine.wav')
	await reader.readChannels(0.1)
	const segment = file.seek(file.duration + 1)
	t.equal(await reader.readChannels(), null)
	t.ok(reader.ended)
	t.equal(file.lastSegment, segment)
	file.close()
})

const sineWav = (rate, seconds) => {
	const count = rate * seconds
	const bytes = Buffer.alloc(44 + count * 2)
	bytes.write('RIFF', 0)
	bytes.writeUInt32LE(36 + count * 2, 4)
	bytes.write('WAVE', 8)
	bytes.write('fmt ', 12)
	bytes.writeUInt32LE(16, 16)
	bytes.writeUInt16LE(1, 20)
	bytes.writeUInt16LE(1, 22)
	bytes.writeUInt32LE(rate, 24)
	bytes.writeUInt32LE(rate * 2, 28)
	bytes.writeUInt16LE(2, 32)
	bytes.writeUInt16LE(16, 34)
	bytes.write('data', 36)
	bytes.writeUInt32LE(count * 2, 40)
	for (let i = 0; i < count; i++) { bytes.writeInt16LE(Math.round(10000 * Math.sin(i / 10)), 44 + i * 2) }
	return bytes
}

T.test("audio reader blocks longer than the feed", async (t) => {
	t.timeout(10e3)
	const bytes = sineWav(96000, 4)
	const expected = await M.decodeAudio(bytes)
	const file = await M.open(bytes)
	const reader = file.tracks[0].createReader()
	const first = await reader.readChannels()
	t.equal(first.frames, 96000)
	const second = await reader.readChannels(2.5)
	t.equal(second.frames, 96000 * 2.5)
	t.ok(Math.abs(second.timestamp - 1) < 1e-9)
	const target = [ new Float32Array(96000) ]
	const third = await reader.readChannelsInto(target)
	t.equal(third.frames, 96000 / 2)
	let difference = 0
	for (let i = 0; i < second.frames; i++) {
		difference = Math.max(difference, Math.abs(second.channels[0][i] - expected.channels[0][96000 + i]))
	}
	t.equal(difference, 0)
	t.equal(await reader.readChannels(), null)
	file.close()
})

T.test("loop turned off after the decoder wrapped", async (t) => {
	t.timeout(10e3)
	const file = await M.open(fixture('late-audio.mkv'))
	const video = file.tracks.find((x) => x.type === 'video').createReader()
	const audio = file.tracks.find((x) => x.type === 'audio').createReader({ sampleRate: 48000 })
	file.setLoop(true)
	let frame
	do {
		frame = await video.read()
		video.release(frame)
	} while (frame.segment < 1)
	file.setLoop(false)
	await sleep(100)
	t.equal(await video.read(), null)
	t.ok(video.ended)
	let frames = 0
	let block
	while ((block = await audio.readChannels(0.25))) {
		t.equal(block.segment, 0)
		frames += block.frames
	}
	t.equal(frames, 48000)
	t.ok(audio.ended)

	file.setLoop(true)
	frame = await video.read()
	t.ok(frame.segment >= 1)
	video.release(frame)
	block = await audio.readChannels(0.1)
	t.ok(block.segment >= 1)
	file.close()
})

T.test("readers end when a decoder fails to open", async (t) => {
	t.timeout(10e3)
	const bytes = Fs.readFileSync(fixture('short-audio.webm'))
	bytes[bytes.indexOf('OpusHead') + 18] = 255
	const file = await M.open(bytes)
	const errors = []
	file.on('decodeError', ({ error }) => { errors.push(error) })
	const audio = file.tracks.find((x) => x.type === 'audio').createReader({ sampleRate: 48000 })
	const video = file.tracks.find((x) => x.type === 'video').createReader()
	await t.throwsWithAsync(() => audio.readChannels(), (error) => {
		t.ok(error instanceof Error)
		t.equal(error.fatal, true)
		t.ok(errors.includes(error))
	})
	t.ok(audio.ended)
	let frames = 0
	let frame
	while ((frame = await video.read())) {
		frames += 1
		video.release(frame)
	}
	t.equal(frames, 20)
	t.equal(file.seek(0.5), 1)
	await t.throwsWithAsync(() => audio.readChannels(), (error) => { t.equal(error.fatal, true) })
	file.close()
})

T.test("audio reader keeps more than 8 channels", async (t) => {
	t.timeout(10e3)
	const bytes = multichannelWav(48000, 1, 10)
	const expected = await M.decodeAudio(bytes)
	t.equal(expected.channels.length, 10)
	const file = await M.open(bytes)
	t.equal(file.tracks[0].channels, 10)
	const reader = file.tracks[0].createReader()
	t.equal(reader.channels, 10)
	const block = await reader.readChannels(0.5)
	t.equal(block.channels.length, 10)
	const interleaved = await reader.readInterleaved(0.5)
	t.equal(interleaved.channels, 10)
	t.equal(interleaved.data.length, interleaved.frames * 10)
	let difference = 0
	for (let c = 0; c < 10; c++) {
		for (let i = 0; i < block.frames; i++) {
			difference = Math.max(difference, Math.abs(block.channels[c][i] - expected.channels[c][i]))
		}
		for (let i = 0; i < interleaved.frames; i++) {
			difference = Math.max(difference, Math.abs(interleaved.data[i * 10 + c] - expected.channels[c][block.frames + i]))
		}
	}
	t.equal(difference, 0)
	const peak = (channel) => Math.max(...channel.map(Math.abs))
	t.ok(Math.abs(peak(block.channels[9]) / peak(block.channels[0]) - 10) < 0.01)
	t.equal(await reader.readChannels(), null)
	file.close()
})
