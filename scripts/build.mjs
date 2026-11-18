import Fs from 'node:fs'
import Path from 'node:path'
import { execSync } from 'node:child_process'
import C from './util/common.js'

await Promise.all([
	C.dir.build,
	C.dir.dist,
	C.dir.publish,
].map(async (dir) => {
	await Fs.promises.rm(dir, { recursive: true }).catch(() => {})
}))

const ffmpegDir = Path.join(C.dir.ffmpeg, 'full')
const FFMPEG_INC = Path.join(ffmpegDir, 'include')
const FFMPEG_LIB = Path.join(ffmpegDir, 'lib')

console.log("build in", C.dir.build)

const werror = C.isSet(process.env.MEDIA_DECODERS_WERROR ?? '1') ? 1 : 0

let archFlag = ''
if (process.env.CROSS_COMPILE_ARCH) {
	archFlag = `--arch ${process.env.CROSS_COMPILE_ARCH}`
}

process.chdir(C.dir.root)
execSync(`npx -y node-gyp rebuild ${archFlag} -j max --verbose -- -Dwerror=${werror}`, {
	stdio: 'inherit',
	env: {
		...process.env,
		FFMPEG_INC,
		FFMPEG_LIB,
	},
})

console.log("install to", C.dir.dist)
await Fs.promises.rm(C.dir.dist, { recursive: true }).catch(() => {})
await Fs.promises.mkdir(C.dir.dist, { recursive: true })
await Fs.promises.cp(
	Path.join(C.dir.build, 'Release/media_decoders.node'),
	Path.join(C.dir.dist, 'media_decoders.node'),
)

const copyFfmpeg = async (srcDir) => {
	const names = await Fs.promises.readdir(srcDir)
	await Promise.all(names.map(async (name) => {
		if (!C.isFfmpegFile(name)) { return }
		await Fs.promises.cp(
			Path.join(srcDir, name),
			Path.join(C.dir.dist, name),
			{ verbatimSymlinks: true },
		)
	}))
}
await copyFfmpeg(ffmpegDir)
await copyFfmpeg(FFMPEG_LIB)

// Strip binaries on linux
if (C.platform === 'linux') {
	execSync(`strip -s "${Path.join(C.dir.dist, 'media_decoders.node')}"`)
}
