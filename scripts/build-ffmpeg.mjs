import Fs from 'node:fs'
import Path from 'node:path'
import Zlib from 'node:zlib'
import Stream from 'node:stream'
import { pathToFileURL } from 'node:url'
import C from './util/common.js'
import { unpackTar } from 'modern-tar/fs'

const url = `https://github.com/${C.ffmpeg.owner}/${C.ffmpeg.repo}/archive/refs/tags/v${C.ffmpeg.version}.tar.gz`

console.log("fetch", url)
const response = await fetch(url)
if (!response.ok) { throw new Error(`bad status code ${response.status}`) }

console.log("unpack to", C.dir.ffmpeg)
await Fs.promises.rm(C.dir.ffmpeg, { recursive: true }).catch(() => {})
await Fs.promises.mkdir(C.dir.ffmpeg, { recursive: true })
await Stream.promises.pipeline(
	Stream.Readable.fromWeb(response.body),
	Zlib.createGunzip(),
	unpackTar(C.dir.ffmpeg),
)

const ffmpegRoot = Path.join(C.dir.ffmpeg, `${C.ffmpeg.repo}-${C.ffmpeg.version}`)
await import(pathToFileURL(Path.join(ffmpegRoot, 'scripts/build.mjs')).href)
await Promise.all(C.ffmpeg.variants.map(async (variant) => {
	await Fs.promises.cp(
		Path.join(ffmpegRoot, 'dist', variant),
		Path.join(C.dir.ffmpeg, variant),
		{
			recursive: true,
			verbatimSymlinks: true,
		},
	)
}))
