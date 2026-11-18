import Path from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = Path.resolve(Path.dirname(fileURLToPath(import.meta.url)), '../..')

export const fixture = (name) => Path.join(root, 'tests/fixtures', name)

export const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

export const frameNumber = (frame) => Math.round((frame.planes[0][0] - 16) / 10)

export const readAll = async (reader, limit = Infinity) => {
	const frames = []
	while (frames.length < limit) {
		const frame = await reader.read()
		if (!frame) { break }
		frames.push({
			timestamp: frame.timestamp,
			duration: frame.duration,
			segment: frame.segment,
			number: frameNumber(frame),
			luma: frame.planes[0][0],
		})
		reader.release(frame)
	}
	return frames
}

export const readSegment = async (reader, segment) => {
	for (;;) {
		const frame = await reader.read()
		if (!frame || frame.segment === segment) { return frame }
		reader.release(frame)
	}
}

export const near = (a, b, tolerance = 1e-6) => Math.abs(a - b) <= tolerance

export const multichannelWav = (rate, seconds, channels) => {
	const count = rate * seconds
	const size = count * channels * 2
	const bytes = Buffer.alloc(44 + size)
	bytes.write('RIFF', 0)
	bytes.writeUInt32LE(36 + size, 4)
	bytes.write('WAVE', 8)
	bytes.write('fmt ', 12)
	bytes.writeUInt32LE(16, 16)
	bytes.writeUInt16LE(1, 20)
	bytes.writeUInt16LE(channels, 22)
	bytes.writeUInt32LE(rate, 24)
	bytes.writeUInt32LE(rate * channels * 2, 28)
	bytes.writeUInt16LE(channels * 2, 32)
	bytes.writeUInt16LE(16, 34)
	bytes.write('data', 36)
	bytes.writeUInt32LE(size, 40)
	for (let i = 0; i < count; i++) {
		for (let c = 0; c < channels; c++) {
			bytes.writeInt16LE(Math.round(1000 * (c + 1) * Math.sin(i / 10)), 44 + (i * channels + c) * 2)
		}
	}
	return bytes
}
