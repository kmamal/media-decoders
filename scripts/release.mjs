import { execSync } from 'node:child_process'

await import('./clean.mjs')

execSync('npm install', {
	stdio: 'inherit',
	env: {
		...process.env,
		MEDIA_DECODERS_FROM_SOURCE: 1,
		MEDIA_DECODERS_WERROR: 1,
	},
})

await import('./upload-release.mjs')
