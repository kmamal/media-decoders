import Fs from 'node:fs'
import Path from 'node:path'
import Zlib from 'node:zlib'
import Stream from 'node:stream'
import C from './util/common.js'
import { unpackTar } from 'modern-tar/fs'

await Fs.promises.rm(C.dir.ffmpeg, { recursive: true }).catch(() => {})

await Promise.all(C.ffmpeg.variants.map(async (variant) => {
	const url = `https://github.com/${C.ffmpeg.owner}/${C.ffmpeg.repo}/releases/download/v${C.ffmpeg.version}/${C.ffmpeg.assetName(variant)}`

	console.log("fetch", url)
	const response = await fetch(url)
	if (!response.ok) { throw new Error(`bad status code ${response.status}`) }

	const dirPath = Path.join(C.dir.ffmpeg, variant)
	console.log("unpack to", dirPath)
	await Fs.promises.mkdir(dirPath, { recursive: true })
	await Stream.promises.pipeline(
		Stream.Readable.fromWeb(response.body),
		Zlib.createGunzip(),
		unpackTar(dirPath),
	)
}))
