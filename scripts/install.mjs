import C from './util/common.js'

process.env.MEDIA_DECODERS_WERROR ??= '0'

if (!C.fromSource) {
	try {
		await import('./download-release.mjs')
		process.exit(0)
	}
	catch (error) {
		console.log("failed to download release:", error.cause?.message ?? error.message)
	}
}
else {
	console.log("skip download and build from source")
}

try {
	await import('./download-ffmpeg.mjs')
}
catch (error) {
	console.log("failed to download ffmpeg:", error.cause?.message ?? error.message)
	await import('./build-ffmpeg.mjs')
}

await import('./build.mjs')
