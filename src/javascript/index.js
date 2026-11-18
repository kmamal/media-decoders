const { bindings } = require('./common')
const { createByteSource } = require('./byte-source')
const { createFeed, createVideoFeed, getFeedUserData, getPosition, createFeedReader, createVideoFeedReader } = require('./feed')
const { open } = require('./media-file')
const { decodeAudio, decodeAudioInterleaved, decodeVideo, decodeFrame } = require('./decode')

module.exports = {
	versions: bindings.versions(),
	decoders: bindings.decoders(),
	open,
	decodeAudio,
	decodeAudioInterleaved,
	decodeFrame,
	decodeVideo,
	createFeed,
	getFeedUserData,
	getPosition,
	createFeedReader,
	createVideoFeed,
	createVideoFeedReader,
	createByteSource,
}
