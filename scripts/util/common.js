const Fs = require('node:fs')
const Path = require('node:path')

const dir = {}
dir.root = Path.join(__dirname, '../..')
dir.ffmpeg = Path.join(dir.root, 'ffmpeg')
dir.build = Path.join(dir.root, 'build')
dir.dist = Path.join(dir.root, 'dist')
dir.publish = Path.join(dir.root, 'publish')

const pkgPath = Path.join(dir.root, 'package.json')
const pkg = JSON.parse(Fs.readFileSync(pkgPath).toString())
const version = pkg.version
const isPrerelease = version.includes('-')
const [ , owner, repo ] = pkg.repository.url.match(/([^/:]+)\/([^/]+)\.git$/u)

const isSet = (value) => ![ undefined, '', '0', 'false' ].includes(value)
const fromSource = isSet(process.env.MEDIA_DECODERS_FROM_SOURCE)

const { platform, arch } = process
const targetArch = process.env.CROSS_COMPILE_ARCH || arch
const assetName = `media_decoders.node-v${version}-${platform}-${targetArch}.tar.gz`
const freeAssetName = `ffmpeg-free-v${version}-${platform}-${targetArch}.tar.gz`

const ffmpeg = pkg.config.ffmpeg
ffmpeg.variants = [ 'full', 'free' ]
ffmpeg.assetName = (variant) => `FFmpeg-v${ffmpeg.version}-${variant}-${platform}-${targetArch}.tar.gz`

const isFfmpegFile = (name) => {
	if (name.endsWith('.md') || name.startsWith('COPYING')) { return true }
	switch (platform) {
		case 'linux': return name.includes('.so')
		case 'darwin': return name.endsWith('.dylib')
		case 'win32': return name.endsWith('.dll')
		default: return false
	}
}

module.exports = {
	dir,
	isSet,
	fromSource,
	version,
	isPrerelease,
	owner,
	repo,
	platform,
	arch,
	targetArch,
	assetName,
	freeAssetName,
	ffmpeg,
	isFfmpegFile,
}
