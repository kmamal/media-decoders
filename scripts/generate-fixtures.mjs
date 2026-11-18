import Fs from 'node:fs'
import Os from 'node:os'
import Path from 'node:path'
import { execFileSync } from 'node:child_process'
import C from './util/common.js'

const outDir = Path.resolve(process.argv[2] ?? Path.join(C.dir.root, 'tests/fixtures'))
const tmpDir = Fs.mkdtempSync(Path.join(Os.tmpdir(), 'media-decoders-fixtures-'))

const lavfi = (graph) => [ '-f', 'lavfi', '-i', graph ]

const numbered = (size, duration) => lavfi(`color=black:s=${size}:r=10:d=${duration},geq=lum=16+10*N:cb=128:cr=128,format=yuv420p`)
const gray = (duration) => lavfi(`color=gray:s=64x48:r=10:d=${duration}`)
const target = (size, filters) => lavfi(`color=0xC83264:s=${size}:r=10:d=0.3,${filters}`)
const sine = (duration = 1, options = '') => lavfi(`sine=frequency=440:duration=${duration}${options}`)

const vp9 = [ '-c:v', 'libvpx-vp9', '-g', '5', '-crf', '10', '-b:v', '0' ]
const lossless = [ '-c:v', 'libvpx-vp9', '-lossless', '1' ]
const mp3 = [ '-b:a', '64k', '-write_xing', '0', '-id3v2_version', '0' ]

const FIXTURES = {
	'vp8.webm': [ ...numbered('64x48', 2), '-c:v', 'libvpx', '-g', '5', '-b:v', '1M' ],
	'vp9.webm': [ ...numbered('64x48', 2), ...vp9, '-colorspace', 'bt470bg' ],
	'vp9.mp4': [ ...numbered('64x48', 2), ...vp9 ],
	'vp9-faststart.mp4': [ ...numbered('64x48', 2), ...vp9, '-movflags', '+faststart' ],
	'av1.webm': [ ...numbered('64x48', 2), '-c:v', 'libaom-av1', '-g', '5', '-crf', '10', '-b:v', '0', '-cpu-used', '8' ],
	'theora.ogv': [ ...numbered('64x48', 2), '-c:v', 'libtheora', '-g', '5', '-q:v', '10' ],
	'h264.mp4': [ ...numbered('64x48', 2), '-c:v', 'libx264', '-g', '5', '-bf', '2', '-crf', '5', '-colorspace', 'smpte170m' ],
	'hevc.mp4': [ ...numbered('64x48', 2), '-c:v', 'libx265', '-g', '5', '-crf', '5', '-tag:v', 'hvc1', '-x265-params', 'log-level=error' ],
	'sar.webm': [ ...numbered('64x48', 2), ...vp9, '-aspect', '3:2' ],
	'big-tail.mp4': [ ...lavfi('nullsrc=s=160x120:r=10:d=3,format=gray,geq=random(1)*255,format=yuv420p'), '-c:v', 'libvpx-vp9', '-g', '5', '-crf', '4', '-b:v', '0' ],

	'hd-bt601.webm': [ ...target('1280x720', 'format=yuv420p'), ...lossless, '-colorspace', 'smpte170m' ],
	'hd-bt709.webm': [ ...target('1280x720', 'scale=out_color_matrix=bt709,format=yuv420p'), ...lossless, '-colorspace', 'bt709' ],
	'untagged-sd.webm': [ ...target('64x48', 'format=yuv420p'), ...lossless ],
	'untagged-hd.webm': [ ...target('1280x720', 'scale=out_color_matrix=bt709,format=yuv420p,setparams=colorspace=unknown'), ...lossless ],
	'full-range.webm': [ ...target('64x48', 'scale=out_color_matrix=bt709:out_range=pc,format=yuv420p'), ...lossless, '-colorspace', 'bt709', '-color_range', 'pc' ],
	'ten-bit.webm': [ ...target('64x48', 'scale=out_color_matrix=bt709,format=yuv420p10le'), ...lossless, '-colorspace', 'bt709' ],
	'yuv444.webm': [ ...target('64x48', 'scale=out_color_matrix=bt709,format=yuv444p'), ...lossless, '-colorspace', 'bt709' ],
	'pq.webm': [ ...lavfi('color=gray:s=64x48:r=10:d=0.3,format=yuv420p,format=yuv420p10le,setparams=colorspace=bt2020nc:color_trc=smpte2084:color_primaries=bt2020'), ...vp9 ],

	'orient.mp4': [ ...lavfi('color=black:s=34x18:r=10:d=0.1,format=yuv420p,geq=lum=7*X+2*Y:cb=5*X+3*Y:cr=255-4*X-6*Y'), ...lossless ],

	'late-video.webm': [ ...sine(2), '-itsoffset', '0.5', ...numbered('64x48', 2), '-map', '0', '-map', '1', ...vp9, '-c:a', 'libopus' ],
	'late-audio.mkv': [ ...gray(1), '-itsoffset', '0.25', ...sine(0.75, ':sample_rate=48000'), '-map', '0', '-map', '1', '-pix_fmt', 'yuv420p', '-c:v', 'libvpx-vp9', '-c:a', 'pcm_s16le' ],
	'short-audio.webm': [ ...gray(2), ...sine(1, ':sample_rate=48000'), '-pix_fmt', 'yuv420p', '-c:v', 'libvpx-vp9', '-c:a', 'libopus' ],

	'sine.wav': [ ...sine() ],
	'sine24.wav': [ ...sine(), '-c:a', 'pcm_s24le' ],
	'sine.aiff': [ ...sine() ],
	'mulaw.wav': [ ...sine(), '-ar', '8000', '-c:a', 'pcm_mulaw' ],
	'stereo-f32.wav': [ ...sine(), '-ac', '2', '-c:a', 'pcm_f32le' ],
	'sine.flac': [ ...sine() ],
	'sine.m4a': [ ...sine() ],
	'sine.mp3': [ ...sine(), '-b:a', '128k' ],
	'sine.ogg': [ ...sine() ],
	'sine.opus': [ ...sine() ],
	'sine.webm': [ ...sine() ],
	'two-audio.mov': [ ...sine(), ...sine(1, ',volume=-1'), '-map', '0', '-map', '1', '-c:a', 'pcm_s16le' ],
	'chirp.ogg': [ ...lavfi('aevalsrc=0.4*sin(2*PI*(200+40*t)*t):s=44100:d=3'), '-c:a', 'libvorbis', '-q:a', '0' ],
}

const ffmpeg = (args, output) => {
	execFileSync('ffmpeg', [ '-v', 'error', '-y', ...args, output ], { stdio: [ 'ignore', 'inherit', 'inherit' ] })
}

const write = (name, generate) => {
	console.log("  ", name)
	generate(Path.join(outDir, name))
}

console.log("generate in", outDir)
Fs.mkdirSync(outDir, { recursive: true })

try {
	for (const [ name, args ] of Object.entries(FIXTURES)) {
		write(name, (output) => { ffmpeg(args, output) })
	}

	const orient = Path.join(outDir, 'orient.mp4')
	write('orient-90.mp4', (output) => { ffmpeg([ '-display_rotation', '-90', '-i', orient, '-c', 'copy' ], output) })
	write('orient-flip.mp4', (output) => { ffmpeg([ '-display_rotation', '90', '-display_hflip', '-i', orient, '-c', 'copy' ], output) })

	write('unknown-duration.mkv', (output) => {
		const bytes = execFileSync('ffmpeg', [ '-v', 'error', ...sine(), '-c:a', 'flac', '-f', 'matroska', '-' ], { maxBuffer: 1 << 26 })
		Fs.writeFileSync(output, bytes)
	})

	write('channel-change.mp3', (output) => {
		const mono = Path.join(tmpDir, 'mono.mp3')
		const stereo = Path.join(tmpDir, 'stereo.mp3')
		ffmpeg([ ...sine(0.5), ...mp3 ], mono)
		ffmpeg([ ...lavfi('sine=frequency=660:duration=0.5'), '-ac', '2', ...mp3 ], stereo)
		Fs.writeFileSync(output, Buffer.concat([ Fs.readFileSync(mono), Fs.readFileSync(stereo) ]))
	})
}
finally {
	Fs.rmSync(tmpDir, { recursive: true, force: true })
}
