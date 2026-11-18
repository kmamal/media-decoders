import Fs from 'node:fs'
import Path from 'node:path'
import Zlib from 'node:zlib'
import Stream from 'node:stream'
import C from './util/common.js'
import { packTar } from 'modern-tar/fs'

const commonHeaders = {
	"Accept": 'application/vnd.github+json',
	"Authorization": `Bearer ${process.env.GITHUB_TOKEN}`,
	'User-Agent': `@${C.owner}/${C.repo}@${C.version}`,
}

let response

getRelease: {
	console.log("get release", C.version)

	response = await fetch(
		`https://api.github.com/repos/${C.owner}/${C.repo}/releases/tags/v${C.version}`,
		{ headers: commonHeaders },
	)
	if (response.ok) {
		console.log("release exists", C.version)
		break getRelease
	}
	console.log(`bad status code ${response.status}`)

	console.log("create release", C.version)

	response = await fetch(
		`https://api.github.com/repos/${C.owner}/${C.repo}/releases`,
		{
			method: 'POST',
			headers: commonHeaders,
			body: JSON.stringify({
				tag_name: `v${C.version}`, // eslint-disable-line camelcase
				name: `v${C.version}`,
				prerelease: C.isPrerelease,
				make_latest: `${!C.isPrerelease}`, // eslint-disable-line camelcase
			}),
		},
	)
	if (!response.ok) { throw new Error(`bad status code ${response.status}`) }
}
const releaseId = (await response.json()).id

await Fs.promises.rm(C.dir.publish, { recursive: true }).catch(() => {})
await Fs.promises.mkdir(C.dir.publish, { recursive: true })

const freeDir = Path.join(C.dir.publish, 'ffmpeg-free')
await Fs.promises.mkdir(freeDir, { recursive: true })
for (const srcDir of [ Path.join(C.dir.ffmpeg, 'free'), Path.join(C.dir.ffmpeg, 'free/lib') ]) {
	const names = await Fs.promises.readdir(srcDir)
	for (const name of names) {
		if (!C.isFfmpegFile(name)) { continue }
		await Fs.promises.cp(
			Path.join(srcDir, name),
			Path.join(freeDir, name),
			{ verbatimSymlinks: true },
		)
	}
}

const assets = [
	{ assetName: C.assetName, srcDir: C.dir.dist },
	{ assetName: C.freeAssetName, srcDir: freeDir },
]

for (const { assetName, srcDir } of assets) {
	console.log("create archive", assetName)
	const assetPath = Path.join(C.dir.publish, assetName)

	await Stream.promises.pipeline(
		packTar(srcDir),
		Zlib.createGzip(),
		Fs.createWriteStream(assetPath),
	)
	const buffer = await Fs.promises.readFile(assetPath)

	response = await fetch(
		`https://api.github.com/repos/${C.owner}/${C.repo}/releases/${releaseId}/assets`,
		{ headers: commonHeaders },
	)
	if (!response.ok) { throw new Error(`bad status code ${response.status}`) }

	const list = await response.json()
	const asset = list.find((x) => x.name === assetName)
	if (asset) {
		console.log("delete asset", assetName)
		response = await fetch(
			`https://api.github.com/repos/${C.owner}/${C.repo}/releases/assets/${asset.id}`,
			{
				method: 'DELETE',
				headers: commonHeaders,
			},
		)
		if (!response.ok) { throw new Error(`bad status code ${response.status}`) }
	}

	console.log("upload", assetName)
	response = await fetch(
		`https://uploads.github.com/repos/${C.owner}/${C.repo}/releases/${releaseId}/assets?name=${assetName}`,
		{
			method: 'POST',
			headers: {
				...commonHeaders,
				'Content-Type': 'application/gzip',
			},
			body: buffer,
		},
	)
	if (!response.ok) { throw new Error(`bad status code ${response.status}`) }
}
