import T from '@kmamal/testing'
import Fs from 'node:fs'
import Os from 'node:os'
import Path from 'node:path'
import { execFileSync } from 'node:child_process'
import { root, fixture } from './helpers/common.mjs'

const C = (await import('../scripts/util/common.js')).default
const freeDir = Path.join(root, 'ffmpeg/free')

const runWithFree = (script) => {
	const tmp = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'media-decoders-free-'))
	try {
		Fs.cpSync(Path.join(root, 'src'), Path.join(tmp, 'src'), { recursive: true })
		Fs.cpSync(Path.join(root, 'dist'), Path.join(tmp, 'dist'), { recursive: true, verbatimSymlinks: true })
		for (const srcDir of [ freeDir, Path.join(freeDir, 'lib') ]) {
			for (const name of Fs.readdirSync(srcDir)) {
				if (!C.isFfmpegFile(name)) { continue }
				const dst = Path.join(tmp, 'dist', name)
				Fs.rmSync(dst, { force: true })
				Fs.cpSync(Path.join(srcDir, name), dst, { verbatimSymlinks: true })
			}
		}
		const scriptPath = Path.join(tmp, 'script.mjs')
		Fs.writeFileSync(scriptPath, `import M from ${JSON.stringify(Path.join(tmp, 'src/javascript/index.js'))}\n${script}`)
		return execFileSync(process.execPath, [ scriptPath ], { encoding: 'utf8' })
	}
	finally {
		Fs.rmSync(tmp, { recursive: true, force: true })
	}
}

T.test("free variant", (t) => {
	t.timeout(30e3)
	if (!Fs.existsSync(freeDir)) { return }

	const output = runWithFree(`
		const result = { decoders: M.decoders }
		const h264 = await M.open(${JSON.stringify(fixture('h264.mp4'))})
		result.h264 = h264.tracks.map((x) => [ x.codec, x.decodable ])
		h264.close()
		const vp9 = await M.open(${JSON.stringify(fixture('vp9.mp4'))})
		const reader = vp9.tracks[0].createReader({ format: 'gray' })
		let count = 0
		for (let frame; (frame = await reader.read()); count++) { reader.release(frame) }
		result.vp9 = count
		vp9.close()
		console.log(JSON.stringify(result))
	`)
	const result = JSON.parse(output)
	for (const codec of [ 'h264', 'hevc', 'aac' ]) {
		t.ok(!result.decoders.includes(codec), { codec })
	}
	for (const codec of [ 'vp8', 'vp9', 'av1', 'theora', 'opus', 'vorbis', 'flac', 'mp3' ]) {
		t.ok(result.decoders.includes(codec), { codec })
	}
	t.equal(result.h264, [ [ 'h264', false ] ])
	t.equal(result.vp9, 20)
})
