# @kmamal/media-decoders

Audio and video decoding for Node.js via [FFmpeg](https://ffmpeg.org/).

- **Containers**: mp4/mov/m4a, webm/mkv, ogg, wav, aiff, mp3, flac, aac (ADTS)
- **Video**: AV1 (dav1d), VP8, VP9, Theora, H.264, HEVC
- **Audio**: Opus, Vorbis, FLAC, MP3, AAC, PCM (8 to 64 bit, integer and float, A-law, µ-law)

This package officially supports Linux, Mac, and Windows.
Prebuilt binaries exist for x64 and arm architectures on all supported platforms.

## Examples

### Video (a single frame, or a range of frames)

```js
const poster = await decoders.decodeFrame('movie.webm', 5)
console.log(poster.width, poster.height, poster.timestamp, poster.data.length)

for await (const frame of decoders.decodeVideo('movie.webm', { start: 10, end: 15 })) {
	console.log(frame.timestamp)
}
```

### Video (one frame at a time)

```js
const decoders = require('@kmamal/media-decoders')

const file = await decoders.open('movie.webm')
const video = file.tracks.find((track) => track.type === 'video')
const reader = video.createReader({ format: 'rgba', frames: 4 })

let frame
while ((frame = await reader.read())) {
	console.log(frame.width, frame.height, frame.timestamp, frame.data.length)
	reader.release(frame) // the reader stalls once all 4 frames are held
}
file.close()
```

### Audio (all at once)

```js
const clip = await decoders.decodeAudio('song.ogg', { sampleRate: 48000, start: 10, end: 15 })
console.log(clip.sampleRate, clip.channels.length, clip.channels[0].length) // 48000 2 240000
```

### Audio (one block at a time)

```js
const file = await decoders.open('song.ogg')
const audio = file.tracks.find((track) => track.type === 'audio')
const reader = audio.createReader({ sampleRate: 48000 })
const block = await reader.readChannels(0.5) // read 500ms of audio
console.log(block.channels.length, block.frames, block.timestamp, block.channels[0][0])
file.close()
```

## Installation

```sh
npm install @kmamal/media-decoders
```

Future versions of npm will require you to approve scripts before they run. Approve this package's script with:

```bash
npm install-scripts approve @kmamal/media-decoders
```

## API

### Contents

- [Media time and segments](#media-time-and-segments)
- [Errors](#errors)
- [Event emitters](#event-emitters)
- [decoders.versions](#decodersversions)
- [decoders.decoders](#decodersdecoders)
- [decoders.decodeAudio(source[, options])](#decodersdecodeaudiosource-options)
- [decoders.decodeAudioInterleaved(source[, options])](#decodersdecodeaudiointerleavedsource-options)
- [decoders.decodeFrame(source[, time[, options]])](#decodersdecodeframesource-time-options)
- [decoders.decodeVideo(source[, options])](#decodersdecodevideosource-options)
- [decoders.open(source[, options])](#decodersopensource-options)
- [class MediaFile](#class-mediafile)
  - [Event: 'decodeError'](#event-decodeerror)
  - [Event: 'close'](#file-event-close)
  - [file.id](#fileid)
  - [file.duration](#fileduration)
  - [file.startTime](#filestarttime)
  - [file.format](#fileformat)
  - [file.tracks](#filetracks)
  - [file.loop](#fileloop)
  - [file.setLoop(loop)](#filesetlooploop)
  - [file.lastSegment](#filelastsegment)
  - [file.seek(time)](#fileseektime)
  - [file.attach(feed[, track])](#fileattachfeed-track)
  - [file.detach(feed)](#filedetachfeed)
  - [file.closed](#fileclosed)
  - [file.close()](#fileclose)
- [class Track](#class-track)
- [class VideoTrack extends Track](#class-videotrack-extends-track)
  - [videoTrack.createReader([options])](#videotrackcreatereaderoptions)
- [class VideoReader](#class-videoreader)
  - [Event: 'close'](#video-reader-event-close)
  - [videoReader.read()](#videoreaderread)
  - [videoReader.tryRead()](#videoreadertryread)
  - [videoReader.wait()](#videoreaderwait)
  - [videoReader.release(frame)](#videoreaderreleaseframe)
  - [videoReader.ended](#videoreaderended)
  - [videoReader.closed](#videoreaderclosed)
  - [videoReader.close()](#videoreaderclose)
- [class VideoFrame](#class-videoframe)
- [class AudioTrack extends Track](#class-audiotrack-extends-track)
  - [audioTrack.createReader([options])](#audiotrackcreatereaderoptions)
- [class AudioReader](#class-audioreader)
  - [Event: 'close'](#audio-reader-event-close)
  - [audioReader.readChannels([duration])](#audioreaderreadchannelsduration)
  - [audioReader.readInterleaved([duration])](#audioreaderreadinterleavedduration)
  - [audioReader.readChannelsInto(channels)](#audioreaderreadchannelsintochannels)
  - [audioReader.readInterleavedInto(data)](#audioreaderreadinterleavedintodata)
  - [audioReader.ended](#audioreaderended)
  - [audioReader.closed](#audioreaderclosed)
  - [audioReader.close()](#audioreaderclose)
- [class AudioBlock](#class-audioblock)
- [class AudioChannelsBlock extends AudioBlock](#class-audiochannelsblock-extends-audioblock)
- [class AudioInterleavedBlock extends AudioBlock](#class-audiointerleavedblock-extends-audioblock)
- [Audio feeds](#audio-feeds)
  - [decoders.createFeed()](#decoderscreatefeed)
  - [decoders.getFeedUserData(feed)](#decodersgetfeeduserdatafeed)
  - [decoders.getPosition(feed[, lagFrames])](#decodersgetpositionfeed-lagframes)
  - [decoders.createFeedReader(feed, options)](#decoderscreatefeedreaderfeed-options)
- [class FeedReader](#class-feedreader)
  - [Event: 'close'](#feed-reader-event-close)
  - [feedReader.readInto(channels[, options])](#feedreaderreadintochannels-options)
  - [feedReader.wait([frames[, options]])](#feedreaderwaitframes-options)
  - [feedReader.sampleRate](#feedreadersamplerate)
  - [feedReader.channels](#feedreaderchannels)
  - [feedReader.ended](#feedreaderended)
  - [feedReader.error](#feedreadererror)
  - [feedReader.closed](#feedreaderclosed)
  - [feedReader.close()](#feedreaderclose)
- [Video feeds](#video-feeds)
  - [decoders.createVideoFeed()](#decoderscreatevideofeed)
  - [decoders.createVideoFeedReader(feed, options)](#decoderscreatevideofeedreaderfeed-options)
- [class VideoFeedReader](#class-videofeedreader)
  - [Event: 'close'](#video-feed-reader-event-close)
  - [videoFeedReader.next()](#videofeedreadernext)
  - [videoFeedReader.at(position)](#videofeedreaderatposition)
  - [videoFeedReader.release(frame)](#videofeedreaderreleaseframe)
  - [videoFeedReader.wait([position])](#videofeedreaderwaitposition)
  - [videoFeedReader.format](#videofeedreaderformat)
  - [videoFeedReader.width](#videofeedreaderwidth)
  - [videoFeedReader.height](#videofeedreaderheight)
  - [videoFeedReader.ended](#videofeedreaderended)
  - [videoFeedReader.error](#videofeedreadererror)
  - [videoFeedReader.closed](#videofeedreaderclosed)
  - [videoFeedReader.close()](#videofeedreaderclose)
- [decoders.createByteSource([options])](#decoderscreatebytesourceoptions)
- [class ByteSource](#class-bytesource)
  - [Event: 'request'](#event-request)
  - [Event: 'drain'](#event-drain)
  - [Event: 'close'](#byte-source-event-close)
  - [byteSource.push(offset, bytes)](#bytesourcepushoffset-bytes)
  - [byteSource.drain()](#bytesourcedrain)
  - [byteSource.restart(offset)](#bytesourcerestartoffset)
  - [byteSource.size](#bytesourcesize)
  - [byteSource.setSize(size)](#bytesourcesetsizesize)
  - [byteSource.end()](#bytesourceend)
  - [byteSource.fail([message])](#bytesourcefailmessage)
  - [byteSource.bufferedRanges](#bytesourcebufferedranges)
  - [byteSource.randomAccess](#bytesourcerandomaccess)
  - [byteSource.closed](#bytesourceclosed)
  - [byteSource.close()](#bytesourceclose)

### Media time and segments

All times are in seconds.
Media time starts at the file's [`startTime`](#filestarttime), the earliest start of its tracks, so the first frame of a typical file is at `0` and [`duration`](#fileduration) is measured from there.
A track that starts later is filled in up to its first timestamp: with silence for audio, and with a black frame for video.

Each open file has one thread that demuxes and decodes for all of its tracks.
Tracks that nothing reads are discarded at the demuxer.

Every [`seek()`](#fileseektime), and every time a [looping](#fileloop) file wraps around to its start, begins a new segment for all tracks at once.
Segments are numbered in order, and [video frames](#class-videoframe), [audio blocks](#class-audioblock) and [feed positions](#decodersgetpositionfeed-lagframes) carry the number of the segment they belong to.
Compare segment numbers before timestamps, so that a frame from before a seek is never mistaken for one after it.

### Errors

Damaged or truncated data doesn't stop a file.
A packet that the decoder rejects is skipped and decoding goes on, as the `ffmpeg` command does, so the picture or sound resumes where the decoder can pick up again, usually at the next keyframe.
Damage that the demuxer notices, such as a broken container element or a checksum mismatch, is skipped too, although the demuxer may skip everything up to the next point it can resynchronize at, which can be the end of the file.
Each of these is a non-fatal error that the file emits as a [`'decodeError'`](#event-decodeerror) event.
Damage that FFmpeg doesn't notice, such as changed bytes inside an MP3 frame, decodes into wrong pictures or sound without an error.

A fatal error ends a track: its decoder can't be opened, it has no data at all, or reading the file fails, for example after [`byteSource.fail()`](#bytesourcefailmessage).
The track's reader still returns what was decoded before the error, and then rejects with the error instead of resolving to `null`.
A failed read ends every track of the file, and seeking or looping doesn't restart them.

Errors are `<Error>` objects with two extra properties:
- `fatal: <boolean>` Whether the error ended the track, or every track if `track` is `null`.
- `track: <Track>|<null>` The [track](#class-track) that the error happened in, or `null` for an error of the whole file, such as a failed read or a demuxer error.

Invalid arguments throw right away, even for functions that return a promise or a generator.
The promise only rejects for failures that happen while opening or decoding the file.

### Event emitters

Objects that emit events ([`MediaFile`](#class-mediafile), [`VideoReader`](#class-videoreader), [`AudioReader`](#class-audioreader), [`FeedReader`](#class-feedreader), [`VideoFeedReader`](#class-videofeedreader) and [`ByteSource`](#class-bytesource)) are Node.js [`EventEmitters`](https://nodejs.org/api/events.html), so the usual `on()`, `once()`, `off()`, `removeAllListeners()`, etc. all work.

Each object accepts only the event names listed in this document.
Attaching a listener for any other event name throws.
Every event is an object with a `type` property that holds the event's name.

Every emitter also supports the special `'*'` event.
Listeners registered for `'*'` receive every event the object emits, with the event's name as an extra first argument:

```js
file.on('*', (type, event) => { console.log(type, event) })
```

When you close an object, it emits `'close'`, and then removes all of its listeners at the end of the current tick, and attaching new listeners to it throws.

If one of your listeners throws, the library catches the exception and re-emits it as an `'error'` event on the same object.
As with any `EventEmitter`, if there is no `'error'` listener the exception is rethrown, which usually becomes an uncaught exception.

### decoders.versions

- `<object>`
  - `ffmpeg: <string>` The FFmpeg release that the libraries were built from.
  - `avcodec, avformat, avutil, swscale, swresample: <number>` The versions of the individual libraries, packed by FFmpeg as `major << 16 | minor << 8 | micro`.

The versions of the FFmpeg libraries that were loaded at runtime.

### decoders.decoders

- `<string>[]`

The names of the codecs that the loaded FFmpeg libraries can decode, in alphabetical order, such as `'av1'`, `'h264'` and `'opus'`.
The names are the ones that [`track.codec`](#class-track) uses.
The list depends on which [variant](#patented-codecs) of the libraries is installed.

### decoders.decodeAudio(source[, options])

- `source` A file, as for [`decoders.open()`](#decodersopensource-options).
- `options: <object>`
  - `track: <number>` The [index](#class-track) of the audio track to decode. Default: the first audio track that has a decoder
  - `sampleRate: <number>` The sample rate of the result. Must be an integer from `3000` to `768000`. Default: the sample rate of the track
  - `start: <number>` Where the result starts, in seconds. Must be non-negative. Default: `0`
  - `end: <number>` Where the result ends, in seconds. Must be greater than `start`. Default: the end of the audio
  - `maxLength: <number>` The most frames that the result may have. Must be a positive integer. Default: no limit
  - `signal: <AbortSignal>` Aborts the decode. Default: none
- Returns: `<Promise>` Resolves to an `<object>`:
  - `sampleRate: <number>` The sample rate of the channels.
  - `channels: <Float32Array>[]` One array of samples per channel.

Decodes an audio track of a file into float32 samples.
The result is in [media time](#media-time-and-segments), so a track that starts late begins with silence, and gaps in its timestamps are filled with silence too.
It has the same samples and channels as an [audio reader](#class-audioreader) at the same sample rate.
Decoding seeks to shortly before `start` and stops at `end`, and the result is the same as when decoding from the beginning.
In containers whose timestamps are coarser than one sample, such as Matroska and WebM (whole milliseconds), a seek can't land on an exact sample, so all of the audio before `start` is decoded instead.
A range that starts past the end of the audio gives empty data.

Damaged data is skipped as described in [Errors](#errors), and the promise rejects only if no audio can be decoded at all.
A [fatal error](#errors) after some audio was decoded, such as a failed read, ends the result there instead of rejecting.
The promise also rejects if the result would be longer than `maxLength`.
When `signal` aborts, the promise rejects with the signal's `reason` and the decoding thread stops shortly after.
Decodes also stop when the Node.js environment that started them exits, so terminating a `Worker` doesn't wait for them.
Each decode opens the file and reads it through an [audio reader](#class-audioreader), so it runs on the file's thread.
At most one decode per CPU core runs at a time while the rest wait their turn, so starting many decodes at once doesn't start as many threads.
A decode from a [`ByteSource`](#class-bytesource) doesn't wait its turn, because it may wait for data.
The file's thread decodes up to 2²⁰ frames ahead (about 22 seconds at 48 kHz), and the JS thread copies them into the result.
If the JS thread stays blocked once that much is waiting, the decode stalls until the JS thread is free again.
A [`ByteSource`](#class-bytesource) is closed once the promise settles, as [`decoders.open()`](#decodersopensource-options) closes it with the file.

### decoders.decodeAudioInterleaved(source[, options])

- `source`, `options`: As for [`decoders.decodeAudio()`](#decodersdecodeaudiosource-options).
- Returns: `<Promise>` Resolves to an `<object>`:
  - `sampleRate: <number>` The sample rate of the samples.
  - `channels: <number>` The number of channels.
  - `data: <Float32Array>` The samples, with the channels interleaved (e.g. `L R L R …` for stereo).

Works like [`decoders.decodeAudio()`](#decodersdecodeaudiosource-options), but puts all the channels in one array.

### decoders.decodeFrame(source[, time[, options]])

- `source` A file, as for [`decoders.open()`](#decodersopensource-options).
- `time: <number>` The [media time](#media-time-and-segments) of the frame, in seconds. Must be non-negative. Default: `0`
- `options: <object>`
  - `track: <number>` The [index](#class-track) of the video track to decode. Default: the first video track that has a decoder
  - `format`, `width`, `height`, `threads`: As for [`videoTrack.createReader()`](#videotrackcreatereaderoptions).
- Returns: `<Promise>` Resolves to the [`<VideoFrame>`](#class-videoframe) that is shown at `time`, or to `null` if the track has no frames.

Opens the file, decodes one frame of a video track, and closes the file.
The promise rejects with a [fatal error](#errors), and ignores non-fatal ones.
The frame's `timestamp` can be before `time`, and a `time` past the end gives the last frame.

### decoders.decodeVideo(source[, options])

- `source` A file, as for [`decoders.open()`](#decodersopensource-options).
- `options: <object>`
  - `track: <number>` As for [`decoders.decodeFrame()`](#decodersdecodeframesource-time-options).
  - `start: <number>` The [media time](#media-time-and-segments) to start at, in seconds. Must be non-negative. Default: `0`
  - `end: <number>` The media time to stop at, in seconds. Must be greater than `start`. Default: the end of the track
  - `format`, `width`, `height`, `frames`, `threads`: As for [`videoTrack.createReader()`](#videotrackcreatereaderoptions).
- Returns: `<AsyncGenerator>` Yields [`<VideoFrame>`s](#class-videoframe) in order.

Opens the file, decodes a video track from `start` to `end`, and closes the file once the generator finishes.
The generator throws a [fatal error](#errors), and ignores non-fatal ones.
The first frame is the one shown at `start`, so its `timestamp` can be before `start`; the last one is the last frame whose `timestamp` is before `end`.

A yielded frame is valid until you ask for the next one, after which its memory is reused, so copy anything that you keep.
The last frame before you stop early, with `break` or `return`, stays valid.

### decoders.open(source[, options])

- `source: <string>|<URL>|<ArrayBuffer>|<SharedArrayBuffer>|<ArrayBufferView>|`[`<ByteSource>`](#class-bytesource) The file to open:
  - A path, or a `file:` URL. Other URL schemes are rejected.
  - A buffer that holds the whole file. Its bytes are copied.
  - A [`ByteSource`](#class-bytesource) that you fill with bytes as they arrive.
- `options: <object>`
  - `maxQueuedBytes: <number>` The most bytes of undecoded data that one track may hold. Must be a positive number or `Infinity`. Default: `67108864` (64 MiB)
- Returns: `<Promise>` Resolves to a [`<MediaFile>`](#class-mediafile).

Opens a file and probes its tracks.

The file reads its tracks together, so a track that is not being read holds on to its data while the others go ahead.
When one track holds `maxQueuedBytes`, the file stops reading until that track is read, and the other tracks wait.
Read the tracks together, or close the reader of a track you don't need.
To read the tracks one after the other instead, for example all of the audio and then all of the video, open the file with `maxQueuedBytes: Infinity`, which keeps all of the data that the waiting track hasn't read yet in memory.

### class MediaFile

The API does not expose the `MediaFile` class.
Instead, [`decoders.open()`](#decodersopensource-options) resolves to objects of type `MediaFile`.

### Event: 'decodeError'

- `error: <Error>` The [error](#errors).

Emitted each time an error happens while decoding, fatal or not.
Errors that happen while the file is opening are emitted just after the promise of [`decoders.open()`](#decodersopensource-options) resolves.

<a id="file-event-close"></a>

### Event: 'close'

Emitted when the file is [closed](#fileclose).

### file.id

- `<number>`

A number that no other file opened by this process has, on any thread.
[`decoders.getPosition()`](#decodersgetpositionfeed-lagframes) reports it as `file`, to tell which file a feed's sound came from.

### file.duration

- `<number>`

The length of the file in seconds, measured from [`startTime`](#filestarttime).

### file.startTime

- `<number>`

The earliest start time of the file's tracks, in seconds, in the file's own timeline.
All other times in the API are relative to it.

### file.format

- `<string>`

The name of the FFmpeg demuxer that opened the file, such as `'matroska,webm'` or `'mov,mp4,m4a,3gp,3g2,mj2'`.

### file.tracks

- [`<Track>`](#class-track)`[]`

The file's tracks, in the order they are stored in the file.

### file.loop

- `<boolean>`

Is `true` if the file starts over when it reaches its end.
Default: `false`

### file.setLoop(loop)

- `loop: <boolean>` Whether the file should loop.

Makes the file start over when it reaches its end, or stop doing so.
Each time it wraps around starts a new [segment](#media-time-and-segments).
An audio track loops gaplessly, because the start of the file is written to the feed right after its end.
Turning looping on for a file that has already ended starts it over.
Turning it off after the decoder has wrapped around, while the feed still plays the previous pass, ends every track at the end of that pass.

### file.lastSegment

- `<number>`

The number of the most recent [segment](#media-time-and-segments), including one that a seek has requested but that hasn't been reached yet.

### file.seek(time)

- `time: <number>` The time to seek to, in seconds. Negative times are treated as `0`.
- Returns: `<number>` The number of the new [segment](#media-time-and-segments), or `-1` if the file is closed.

Starts a new segment at `time` for all tracks.
The call returns at once, and the file's thread performs the seek.
Video starts at the frame that is showing at `time` and audio starts at `time` exactly, rather than at the keyframe before it.
Audio after a seek has the same samples as when playing through to `time`, except in containers whose timestamps are coarser than one sample, such as Matroska and WebM (whole milliseconds), where it can be off by up to half a millisecond.

### file.attach(feed[, track])

- `feed: <SharedArrayBuffer>` A feed from [`decoders.createFeed()`](#decoderscreatefeed) or [`decoders.createVideoFeed()`](#decoderscreatevideofeed).
- `track:` [`<AudioTrack>`](#class-audiotrack-extends-track)`|`[`<VideoTrack>`](#class-videotrack-extends-track)`|<null>` One of the file's tracks, of the same kind as the feed. Default: `null`
- Returns: `<number>` The feed's new [generation](#decodersgetpositionfeed-lagframes).

Starts decoding `track` into the feed, which you then read through a [`FeedReader`](#class-feedreader) or a [`VideoFeedReader`](#class-videofeedreader).
The track can't already have a reader, and attaching it on a file that has already started playing works like [creating a reader](#class-track) then.

Without a track, an audio feed plays one channel of silence for the file's duration.
A video feed needs a track.
That way the [position](#decodersgetpositionfeed-lagframes) of a video without sound advances like that of any other file.

Each audio or video track can be attached to one feed, and the file to one more audio feed without a track.
All of a file's feeds share its position, so they are meant to be played together: a seek or a loop applies to all of them, and a feed that is not being read holds the others back once it fills up.
A feed can be attached to one file at a time.

### file.detach(feed)

- `feed: <SharedArrayBuffer>` A feed that is [attached](#fileattachfeed-track) to the file.

Stops writing into the feed, and frees its track, if it had one.
The feed's reader stays open and reads nothing until the feed is attached again.
To switch a feed to another audio track, such as one in another language, detach it and attach it again with the other track; it carries on from where it was, in a new [segment](#media-time-and-segments) and a new [generation](#decodersgetpositionfeed-lagframes).
Does nothing if the feed is not attached to the file, or if the file is closed.

### file.closed

- `<boolean>`

Is `true` once the file has been closed.

### file.close()

Stops the file's thread and frees everything that the file holds.
Pending reads and [`wait()`](#videoreaderwait) calls resolve, and the reader of its feed reads silence from then on.
The file's readers emit [`'close'`](#video-reader-event-close), and then the file's [`ByteSource`](#class-bytesource), if it has one, is closed as well, and the file emits [`'close'`](#file-event-close).

Files are also closed when the Node.js environment that opened them exits, so a `Worker` can be terminated in the middle of playback.

A file that is no longer referenced is closed when it is garbage collected, without emitting `'close'`, so `close()` frees the file's thread and memory sooner but isn't required.
A file is kept alive while one of its readers has a pending read or [`wait()`](#videoreaderwait), and while it is [attached](#fileattachfeed-track) to a feed, until it is [detached](#filedetachfeed).

### class Track

The API does not expose the `Track` class.
It serves as the base class for [`VideoTrack`](#class-videotrack-extends-track) and [`AudioTrack`](#class-audiotrack-extends-track), and the entries of [`file.tracks`](#filetracks) whose `type` is `'other'` are plain `Track` objects.

All tracks have these properties:

- `index: <number>` The position of the track in `file.tracks`.
- `type: <string>` One of `'video'`, `'audio'` or `'other'`.
- `codec: <string>` The name of the codec, as in [`decoders.decoders`](#decodersdecoders).
- `decodable: <boolean>` Is `true` if the loaded libraries have a decoder for the codec.
- `startTime: <number>` The time of the track's first frame, relative to the file's [`startTime`](#filestarttime).
- `duration: <number>|<null>` The length of the track in seconds, or `null` if the file doesn't say.

A track can be read by one reader at a time.
Closing the reader frees the track for a new one, for example with another size or format.
A new reader on a file that has already started playing starts where playback is, the same as a [seek](#fileseektime) to the current position, so the other tracks move to a new segment as well.

### class VideoTrack extends Track

The API does not expose the `VideoTrack` class.
Instead, the entries of [`file.tracks`](#filetracks) whose `type` is `'video'` are objects of type `VideoTrack`.
They also have these properties:

- `width, height: <number>` The coded size of the picture in pixels.
- `displayWidth, displayHeight: <number>` The size that the picture is meant to be shown at, after correcting for non-square pixels and the rotation.
- `rotation: <number>` How far the picture is rotated clockwise when it is shown: `0`, `90`, `180` or `270`.
- `flip: <boolean>` Is `true` if the picture is mirrored horizontally before it is rotated.
- `frameRate: <number>|<null>` The frame rate that FFmpeg guesses for the track, or `null` if it can't guess one.
- `matrix: <string>` The colour matrix: `'bt601'`, `'bt709'` or `'bt2020'`. When the file doesn't say, pictures smaller than 720 rows are taken to be `'bt601'` and larger ones `'bt709'`.
- `fullRange: <boolean>` Is `true` if the samples use the full range instead of the limited (studio) range.
- `transfer: <string>` The transfer function: `'sdr'`, `'pq'` or `'hlg'`.

`rotation` and `flip` come from the stream's display matrix, such as the one in a phone recording.
Frames come out upright, because the matrix is applied after the conversion the same way that the `ffmpeg` command applies it.
Matrices that rotate by other angles than multiples of 90° are ignored.

A video track is decoded into a [video feed](#video-feeds), either one that you [attach](#fileattachfeed-track) it to or one that a reader creates for itself.
Each track can have one video reader or one attached feed, but not both.

### videoTrack.createReader([options])

- `options: <object>`
  - `format: <string>` The pixel format of the frames: `'rgba'`, `'yuv420p'` or `'gray'`. Default: `'rgba'`
  - `width: <number>` The width of the frames in pixels. Default: the width of the upright picture
  - `height: <number>` The height of the frames in pixels. Default: the height of the upright picture
  - `frames: <number>` How many frames the reader's pool holds. At least `2`. Default: `4`
  - `threads: <number>` How many threads the decoder and the scaler may each use. Must be a non-negative integer, where `0` means one per core. Default: `0`
- Returns: [`<VideoReader>`](#class-videoreader)

Starts decoding the track, and returns a reader that pulls it.
The frames are converted to `format` and scaled to `width` × `height`.
The size of the upright picture is the coded size, swapped for a rotation of `90` or `270`.

### class VideoReader

The API does not expose the `VideoReader` class.
Instead, [`videoTrack.createReader()`](#videotrackcreatereaderoptions) returns objects of type `VideoReader`.
Their `format`, `width` and `height` properties hold the reader's resolved options.

<a id="video-reader-event-close"></a>

### Event: 'close'

Emitted when the reader or its file is closed.

### videoReader.read()

- Returns: `<Promise>` Resolves to the next [`<VideoFrame>`](#class-videoframe), or to `null` once the track has [ended](#videoreaderended).
  Rejects with the [fatal error](#errors) that ended the track, if one did.

### videoReader.tryRead()

- Returns: [`<VideoFrame>`](#class-videoframe)`|<null>` The next frame, or `null` if none is ready yet.

### videoReader.wait()

- Returns: `<Promise>` Resolves when a frame is ready, the track has ended, or the file has been closed.

### videoReader.release(frame)

- `frame:` [`<VideoFrame>`](#class-videoframe) A frame that this reader returned.

Gives the frame's memory back to the pool, so the reader can decode into it again.
Releasing a frame twice does nothing.

### videoReader.ended

- `<boolean>`

Is `true` if the track has reached its end and all its frames have been read, or if the reader or the file is closed.
A [seek](#fileseektime) or a [loop](#fileloop) makes it `false` again.

### videoReader.closed

- `<boolean>`

Is `true` once the reader or the file has been closed.

### videoReader.close()

Stops decoding the track and frees the reader's pool.
Pending reads resolve to `null`, frames that you still hold must not be used anymore, and releasing them does nothing.
The track can then be given a new reader.

### class VideoFrame

The API does not expose the `VideoFrame` class.
Instead, a [`VideoReader`](#class-videoreader), [`decoders.decodeFrame()`](#decodersdecodeframesource-time-options) and [`decoders.decodeVideo()`](#decodersdecodevideosource-options) return objects of type `VideoFrame`.
They are plain objects with these properties:

- `width, height: <number>` The size of the frame in pixels, as set by the reader.
- `displayWidth, displayHeight: <number>` The track's [`displayWidth` and `displayHeight`](#class-videotrack-extends-track).
- `format: <string>` The reader's pixel format.
- `planes: <Uint8Array>[]` The pixels, without padding between rows:
  - `'rgba'`: one plane of 4 bytes per pixel.
  - `'gray'`: one plane of 1 byte per pixel.
  - `'yuv420p'`: three planes, Y at full size and U and V at half the size in each direction, rounded up.
- `data: <Uint8Array>` The only plane, for `'rgba'` and `'gray'` frames.
- `timestamp: <number>` The [media time](#media-time-and-segments) of the frame.
- `duration: <number>` How long the frame is shown for.
- `segment: <number>` The [segment](#media-time-and-segments) that the frame belongs to.
- `file: <number>` The [`id`](#fileid) of the file that the frame came from.
- `matrix: <string>` The colour matrix, for `'yuv420p'` and `'gray'` frames, as with the track's [`matrix`](#class-videotrack-extends-track).
- `fullRange: <boolean>` The range, for `'yuv420p'` and `'gray'` frames, as with the track's [`fullRange`](#class-videotrack-extends-track).
- `transfer: <string>` The transfer function, as with the track's [`transfer`](#class-videotrack-extends-track).

`'rgba'` frames have been converted with the stream's colour matrix and range, so they don't have `matrix` and `fullRange`.
`'yuv420p'` and `'gray'` frames keep the stream's samples as they are.
HDR transfer functions are not applied to any format.

The planes are views into the reader's internal buffers.
They stay valid until you [release](#videoreaderreleaseframe) the frame, after which the reader writes new pixels into them.
The buffers are `SharedArrayBuffer`s, so a frame can be posted to a worker without a copy.
The worker sees the same memory, so release the frame only once the worker is done with it.

### class AudioTrack extends Track

The API does not expose the `AudioTrack` class.
Instead, the entries of [`file.tracks`](#filetracks) whose `type` is `'audio'` are objects of type `AudioTrack`.
They also have these properties:

- `sampleRate: <number>` The sample rate of the track.
- `channels: <number>` The number of channels.

An audio track is decoded into a [feed](#audio-feeds), either one that you [attach](#fileattachfeed-track) it to or one that a reader creates for itself.
Each track can have one audio reader or one attached feed, but not both.

### audioTrack.createReader([options])

- `options: <object>`
  - `sampleRate: <number>` The sample rate of the blocks. Must be an integer between `3000` and `768000`. Default: the track's `sampleRate`
- Returns: [`<AudioReader>`](#class-audioreader)

Starts decoding the track, and returns a reader that pulls it.
The sound is resampled to `sampleRate`.

### class AudioReader

The API does not expose the `AudioReader` class.
Instead, [`audioTrack.createReader()`](#audiotrackcreatereaderoptions) returns objects of type `AudioReader`.
Their `sampleRate` property holds the reader's resolved sample rate, and `channels` holds the number of channels in each block.
That is the track's channel count, with no limit, unlike [feeds](#audio-feeds), which mix down to 8 by default.

Every read resolves to an [`<AudioChannelsBlock>`](#class-audiochannelsblock-extends-audioblock) or an [`<AudioInterleavedBlock>`](#class-audiointerleavedblock-extends-audioblock), depending on the method, and you can mix the methods freely on the same reader.
Each read waits until it can fill the whole block.
A block is shorter than asked for only where it reaches a [segment](#media-time-and-segments) boundary (a seek or a loop), the end of the track, or a change in the track's channel count.

<a id="audio-reader-event-close"></a>

### Event: 'close'

Emitted when the reader or its file is closed.

### audioReader.readChannels([duration])

- `duration: <number>` How many seconds of sound to read. Must be a positive number. Default: `1`
- Returns: `<Promise>` Resolves to the next [`<AudioChannelsBlock>`](#class-audiochannelsblock-extends-audioblock), or to `null` once the track has [ended](#audioreaderended).
  Rejects with the [fatal error](#errors) that ended the track, if one did.

Reads `duration` seconds, rounded to a whole number of frames, into new arrays, one per channel.
The arrays belong to the caller, and are as long as the block.

### audioReader.readInterleaved([duration])

- `duration: <number>` How many seconds of sound to read. Must be a positive number. Default: `1`
- Returns: `<Promise>` Resolves to the next [`<AudioInterleavedBlock>`](#class-audiointerleavedblock-extends-audioblock), or to `null` once the track has [ended](#audioreaderended).
  Rejects with the [fatal error](#errors) that ended the track, if one did.

Reads `duration` seconds, rounded to a whole number of frames, into a new array with the channels interleaved.
The array belongs to the caller, and is as long as the block.

### audioReader.readChannelsInto(channels)

- `channels: <Float32Array>[]` One array per channel to fill. They should all have the same length.
- Returns: `<Promise>` Resolves to the next [`<AudioChannelsBlock>`](#class-audiochannelsblock-extends-audioblock), or to `null` once the track has [ended](#audioreaderended).
  Rejects with the [fatal error](#errors) that ended the track, if one did.

Fills the arrays with as many frames as they are long, and resolves to a block whose `channels` are the same arrays.
Arrays past the reader's `channels` are filled with silence, and channels past the number of arrays are dropped.
In a shorter block, the samples past `frames` are silence.

### audioReader.readInterleavedInto(data)

- `data: <Float32Array>` The array to fill, with room for a whole number of frames of the reader's `channels`.
- Returns: `<Promise>` Resolves to the next [`<AudioInterleavedBlock>`](#class-audiointerleavedblock-extends-audioblock), or to `null` once the track has [ended](#audioreaderended).
  Rejects with the [fatal error](#errors) that ended the track, if one did.

Fills the array with interleaved samples, and resolves to a block whose `data` is the same array.
In a shorter block, the samples past `frames * channels` are silence.

### audioReader.ended

- `<boolean>`

Is `true` if the track has reached its end and all its sound has been read, or if the reader or the file is closed.
A [seek](#fileseektime) or a [loop](#fileloop) makes it `false` again.

### audioReader.closed

- `<boolean>`

Is `true` once the reader or the file has been closed.

### audioReader.close()

Stops decoding the track and detaches the file from the reader's feed.
Pending reads resolve to `null`.
The track can then be given a new reader, or be [attached](#fileattachfeed-track) to a feed.

### class AudioBlock

The API does not expose the `AudioBlock` class.
It only serves as the base class for [`AudioChannelsBlock`](#class-audiochannelsblock-extends-audioblock) and [`AudioInterleavedBlock`](#class-audiointerleavedblock-extends-audioblock).

All blocks are plain objects with these properties:

- `frames: <number>` How many frames the block holds.
- `timestamp: <number>` The [media time](#media-time-and-segments) of the first frame.
- `segment: <number>` The [segment](#media-time-and-segments) that the block belongs to. A block never spans two segments.

### class AudioChannelsBlock extends AudioBlock

The API does not expose the `AudioChannelsBlock` class.
Instead, [`audioReader.readChannels()`](#audioreaderreadchannelsduration) and [`audioReader.readChannelsInto()`](#audioreaderreadchannelsintochannels) resolve to objects of type `AudioChannelsBlock`.
They also have this property:

- `channels: <Float32Array>[]` One array of samples per channel.

### class AudioInterleavedBlock extends AudioBlock

The API does not expose the `AudioInterleavedBlock` class.
Instead, [`audioReader.readInterleaved()`](#audioreaderreadinterleavedduration) and [`audioReader.readInterleavedInto()`](#audioreaderreadinterleavedintodata) resolve to objects of type `AudioInterleavedBlock`.
They also have these properties:

- `channels: <number>` The number of channels.
- `data: <Float32Array>` The samples, with the channels interleaved (e.g. `L R L R …` for stereo).

### Audio feeds

An audio track is not pulled but attached to a feed, which carries its sound to a reader on any thread.

```js
const feed = decoders.createFeed()
file.attach(feed, audioTrack)

const reader = decoders.createFeedReader(feed, { sampleRate: 48000 })
const channels = [ new Float32Array(480), new Float32Array(480) ]
reader.readInto(channels)
```

A feed is a `SharedArrayBuffer`, so it can be posted to another thread, such as an audio worklet.
Its layout is private, and both sides go through the functions here.
The feed applies no volume and no pause: a player that needs them, such as the one in [`@kmamal/media-elements`](https://github.com/kmamal/media-elements), applies them to the blocks it reads, and keeps its settings in the feed's [user data](#decodersgetfeeduserdatafeed).

The file's thread resamples and mixes the sound to the reader's sample rate and channels, applies seeks and loops, and keeps up to the reader's `buffer` of it decoded ahead.
Because the file's thread does all of that without the JS thread, a busy JS thread never starves the reader.

### decoders.createFeed()

- Returns: `<SharedArrayBuffer>` A new feed.

### decoders.getFeedUserData(feed)

- `feed: <SharedArrayBuffer>` A feed from [`decoders.createFeed()`](#decoderscreatefeed).
- Returns: `<Uint8Array>` A view of 256 bytes of the feed.

The feed reserves these bytes for its users, so that anything that has the feed can also share some state with the other side.
They start out as zeros, and the decoder never reads or writes them.
The view starts at a multiple of 8 bytes into the feed.

### decoders.getPosition(feed[, lagFrames])

- `feed: <SharedArrayBuffer>` A feed from [`decoders.createFeed()`](#decoderscreatefeed).
- `lagFrames: <number>` How many frames, at the reader's sample rate, the position lies behind what the reader has consumed, or ahead of it if negative. Default: `0`
- Returns: `<object>`
  - `file: <number>` The [`id`](#fileid) of the file that the sound being heard came from, or `-1` if nothing has been heard yet.
  - `generation: <number>` The [attach](#fileattachfeed-track) that the sound being heard was written by, or `-1` if nothing has been heard yet.
  - `segment: <number>` The [segment](#media-time-and-segments) being heard, or `-1` if nothing has been heard yet.
  - `time: <number>` The [media time](#media-time-and-segments) being heard.
  - `ended: <boolean>` Is `true` once the end of the file has been heard.

Maps a position in the feed's sound to the file, counting back `lagFrames` frames from what the reader has consumed.
The frames are those of the feed, so at a playback rate of `2` one frame that is heard covers two of them.
A player computes `lagFrames` from the latency of its output, to get the position that is being heard.
The position can lie in a segment or a generation before the one that is being read, and counting back past the oldest sound that the feed remembers gives the oldest position it has.
A larger `lagFrames` can give an earlier position, so a caller whose lag shrinks and grows has to keep its own position from going backwards.

A negative `lagFrames` looks ahead of the reader, for a consumer whose own latency is larger than the audio's, such as video shown behind a compositor.
It counts from where the reader will continue, which after a seek is the start of the new segment rather than what the reader consumed last.
The position stops at the end of the sound that has been written so far, and `ended` is `true` once that is the end of the file.
It is a prediction: a seek drops the sound it was taken from, and turning off [`loop`](#filesetlooploop) cuts sound of the next pass that has already been written.

Every attach starts a new generation of the feed, and [`file.attach()`](#fileattachfeed-track) returns its number.
Generations count up from `1`.
Segment numbers belong to the file, so they carry on when the same file is attached again, and start over when another file is attached.
Compare the generation first, then the segment, then the time.
To match positions of different feeds, compare `file` instead of the generation, because each feed counts its own attaches.
For a moment after a new file is attached, the feed still reports positions from the earlier one, and a generation below the one that `attach()` returned is how you tell them apart.

This can be called from any thread that has the feed.

### decoders.createFeedReader(feed, options)

- `feed: <SharedArrayBuffer>` A feed from [`decoders.createFeed()`](#decoderscreatefeed).
- `options: <object>`
  - `sampleRate: <number>` The sample rate to read at. Must be an integer between `3000` and `768000`.
  - `channels: <number>` A fixed number of channels to mix every track to. Must be an integer between `1` and `512`. Default: none
  - `maxChannels: <number>` The most channels to read when `channels` is not set. Tracks with more channels are mixed down to this many. Must be an integer between `1` and `512`. Default: `8`
  - `buffer: <number>` How many seconds of sound the file's thread decodes ahead of the reader. Default: `1`
- Returns: [`<FeedReader>`](#class-feedreader)

Creates the reading side of a feed.
A feed has one reader at a time, so this throws if the feed already has one.
A reader can open before or after a file is attached to the feed, and on a different thread from the file.

Without `channels`, the sound keeps the channels of its track, up to `maxChannels`, so a [read](#feedreaderreadintochannels-options) stops short where that count changes, such as at a switch of track or in a file whose channels change midway.
With `channels`, the file's thread mixes every track up or down to that count, so reads never stop short for it, and a file without a track plays that many channels of silence instead of one.
Setting both `channels` and `maxChannels` throws.

The reader allocates its own buffer, of `buffer` × `sampleRate` frames of `channels` or `maxChannels` channels, and at least 256 frames.
A larger buffer rides out longer stalls of the file's thread, such as a slow network, while a smaller one uses less memory.
A buffer of more than 2²⁸ samples in total throws.

The reader holds the sound that the file's thread has decoded ahead, so opening a reader is handled like a seek to the current position, whether or not its sample rate is the same as the previous one's.

### class FeedReader

The API does not expose the `FeedReader` class.
Instead, [`decoders.createFeedReader()`](#decoderscreatefeedreaderfeed-options) returns objects of type `FeedReader`.

Readers are also closed when the Node.js environment that opened them exits.

<a id="feed-reader-event-close"></a>

### Event: 'close'

Emitted when the reader is [closed](#feedreaderclose).

### feedReader.readInto(channels[, options])

- `channels: <Float32Array>[]` One array per channel to fill. They should all have the same length.
- `options: <object>`
  - `rate: <number>` How many frames of the feed each frame of the block takes up, which plays the sound faster or slower. Must be a positive number. Default: `1`
- Returns: `<number>` How many frames came from the file.

Fills the whole length of every array.
Frames past the returned count are silence, and so are arrays past the sound's [`channels`](#feedreaderchannels).
The call never blocks: when the feed doesn't have enough sound yet, the rest of the block is silence.

A block runs on across a loop, so a looping file plays without gaps.
After a seek, the next block starts at the seek's target, and a block that was being read as the seek happened can end with sound from before the seek.
A block has one channel count, so where the sound changes its number of channels, the block stops short and the rest of it is silence.
The next block starts with the new channel count.
A `rate` other than `1` changes the pitch along with the speed.
It is applied by linear interpolation between the feed's samples, without an anti-aliasing filter, so above `1` the frequencies above half the reader's sample rate divided by `rate` fold back down as aliasing.
With a `rate` other than `1`, a loop restarts on its first sample, so it drifts by less than one sample at each loop.

### feedReader.wait([frames[, options]])

- `frames: <number>` The number of frames that the next read needs. Default: `128`
- `options: <object>`
  - `rate: <number>` The `rate` that the next read will use. Must be a positive number. Default: `1`
- Returns: `<Promise>` Resolves when the next `readInto()` at that `rate` can fill `frames` frames from the file.

A reader that isn't tied to real time, such as an offline render, awaits `wait()` before each `readInto()`, so that it never mistakes a starved feed for silence.
The promise also resolves when the sound reaches its end or a change in its number of channels, except for an end that a pending [seek](#fileseektime) or [loop](#fileloop) is about to replace, when the feed has no file attached, and when the reader is closed.
The promise resolves once the feed holds half of the reader's `buffer`, even for larger `frames`.

### feedReader.sampleRate

- `<number>`

The sample rate that the reader was opened at.

### feedReader.channels

- `<number>`

The number of channels in the sound that the last `readInto()` read, or `0` before the reader has read any sound.

### feedReader.ended

- `<boolean>`

Is `true` once the reader has consumed the sound up to the end of the file.
A [seek](#fileseektime), or turning on [`loop`](#filesetlooploop) after the end, makes it `false` as soon as `seek()` or `setLoop()` returns, even before the file's thread has caught up.

### feedReader.error

- `<Error>|<null>`

The [fatal error](#errors) that ended the feed's track or file, or `null` if there was none.
It is set as soon as the file's thread fails, and the sound decoded before the error still plays up to the [end](#feedreaderended).
It is cleared when the feed is attached again.

The feed carries the error itself, so a reader on another thread, which has no access to the [`MediaFile`](#class-mediafile), sees it too.
It is a new `<Error>` with the same message as the one that the file emitted in its [`'decodeError'`](#event-decodeerror) event, and with:
- `fatal: <boolean>` Always `true`.
- `errno: <number>` FFmpeg's negative error code, such as `-5` for a failed read.
Messages longer than 127 bytes are cut short.

### feedReader.closed

- `<boolean>`

Is `true` once the reader has been closed.

### feedReader.close()

Closes the reader, so that another one can open on the feed.
A closed reader reads silence.

A reader that is no longer referenced is closed when it is garbage collected, except while it has a pending [`wait()`](#feedreaderwaitframes-options).

### Video feeds

A video track can be attached to a video feed, which carries its frames to a reader on any thread, as an [audio feed](#audio-feeds) does with sound.

```js
const feed = decoders.createVideoFeed()
file.attach(feed, videoTrack)

const reader = decoders.createVideoFeedReader(feed, { format: 'rgba', width: 1280, height: 720 })
const { frame } = reader.at(decoders.getPosition(audioFeed, lagFrames))
```

The reader allocates a pool of frames in the size and format that it asks for, and the file's thread decodes into it, scales every frame to that size, and applies seeks and loops.
A reader reads in one of two ways, and the first call fixes which:

- [`next()`](#videofeedreadernext) hands out every frame in order, for readers that must not skip any, such as encoders.
- [`at(position)`](#videofeedreaderatposition) hands out the frame for a position, for display, and lets the file's thread skip the frames that are already behind it.

Unlike [`VideoReader`](#class-videoreader), a video feed reader works on any thread, and doesn't need the [`MediaFile`](#class-mediafile).

### decoders.createVideoFeed()

- Returns: `<SharedArrayBuffer>` A new video feed.

[`decoders.getFeedUserData()`](#decodersgetfeeduserdatafeed) works on video feeds too.

### decoders.createVideoFeedReader(feed, options)

- `feed: <SharedArrayBuffer>` A feed from [`decoders.createVideoFeed()`](#decoderscreatevideofeed).
- `options: <object>`
  - `format: <string>` The pixel format, one of `'rgba'`, `'yuv420p'` and `'gray'`, as for [`videoTrack.createReader()`](#videotrackcreatereaderoptions).
  - `width, height: <number>` The size of the frames in pixels.
  - `frames: <number>` How many frames the pool holds. Must be an integer of at least `2`. Default: `4`
- Returns: [`<VideoFeedReader>`](#class-videofeedreader)

Creates the reading side of a video feed.
A feed has one reader at a time, so this throws if the feed already has one.
A reader can open before or after a file is attached to the feed, and on a different thread from the file.
`format`, `width` and `height` are required, because a reader that opens before the attach has no track to take them from.

The pool is `frames` `SharedArrayBuffer`s of one frame each.
The frames that the reader holds count against it, so with nothing held, the file's thread decodes up to `frames` frames ahead.
The reader holds the frames that the file's thread has decoded ahead, so opening a reader is handled like a seek to the current position, as for audio.

### class VideoFeedReader

The API does not expose the `VideoFeedReader` class.
Instead, [`decoders.createVideoFeedReader()`](#decoderscreatevideofeedreaderfeed-options) returns objects of type `VideoFeedReader`.

The frames it returns are [`VideoFrame`](#class-videoframe)s with a `file` property.
They take `displayWidth` and `displayHeight` from their track, so that a consumer without the file has them too.
Frames of a [segment](#media-time-and-segments) that a seek has replaced can still come out, so check their `segment`, as with a [`VideoReader`](#class-videoreader).

Readers are also closed when the Node.js environment that opened them exits.

<a id="video-feed-reader-event-close"></a>

### Event: 'close'

Emitted when the reader is [closed](#videofeedreaderclose).

### videoFeedReader.next()

- Returns: [`<VideoFrame>`](#class-videoframe)`|<null>` The next frame, or `null` if there is none yet, or none anymore.

Hands out the decoded frames in order, without skipping any.
A frame stays yours until you [release](#videofeedreaderreleaseframe) it, and the file's thread can't decode more frames than the pool has room for.
Throws if the reader has called [`at()`](#videofeedreaderatposition).

### videoFeedReader.at(position)

- `position: <object>`
  - `file: <number>` The [`id`](#fileid) of the file to show. Default: the file that the feed is attached to.
  - `segment: <number>` The [segment](#media-time-and-segments) to show. Default: the file's latest segment.
  - `time: <number>` The [media time](#media-time-and-segments) to show.
- Returns: `<object>`
  - `frame:` [`<VideoFrame>`](#class-videoframe)`|<null>` The frame to show, or `null` if there has been none yet.
  - `ended: <boolean>` Is `true` once the position is past the end of the last frame of the file.

Returns the frame that is showing at `position`, which is the latest decoded frame of the segment that starts no later than `time`.
The call never blocks: when that frame isn't decoded yet, it returns the frame it returned before.
It returns the same object for as long as the frame stays the same, and the previous frame is released when it returns a new one, so a reader in this mode holds at most one frame.
Throws if the reader has called [`next()`](#videofeedreadernext).

The [position](#decodersgetpositionfeed-lagframes) of an audio feed of the same file can be passed as it is, to show the video that goes with the sound being heard: `at()` ignores its `generation` and `ended`.
For a `file` other than the one that the feed is attached to, `at()` keeps returning the frame it returned before, which covers the moment between attaching a new file to both feeds and hearing it.
Without a `segment`, a consumer that follows a clock of its own gets the frames of the latest seek.

The file's thread skips the frames that end before the last position, without converting them, so a display that falls behind catches up.

### videoFeedReader.release(frame)

- `frame:` [`<VideoFrame>`](#class-videoframe) A frame from this reader.

Gives the frame's buffer back to the pool.
Releasing a frame twice, or after the reader has closed, does nothing.

### videoFeedReader.wait([position])

- `position: <object>` A position as for [`at()`](#videofeedreaderatposition). Default: none
- Returns: `<Promise>` Resolves when the next [`next()`](#videofeedreadernext) returns a frame, or, with `position`, when [`at(position)`](#videofeedreaderatposition) returns its final frame.

Without `position`, it is for readers that use `next()`.
With `position`, it is for readers that use `at()` but aren't tied to real time, such as an offline render, and it waits until the frame for that position, or a later one, has been decoded.
The promise also resolves at the end of the file, except for an end that a pending [seek](#fileseektime) or [loop](#fileloop) is about to replace, when the feed has no file attached, on a fatal error, and when the reader is closed.

### videoFeedReader.format

- `<string>`

The pixel format that the reader was opened with.

### videoFeedReader.width

- `<number>`

The width of the frames, as the reader was opened with.

### videoFeedReader.height

- `<number>`

The height of the frames, as the reader was opened with.

### videoFeedReader.ended

- `<boolean>`

Is `true` once [`next()`](#videofeedreadernext) has handed out the last frame of the file.
For readers that use [`at()`](#videofeedreaderatposition), the `ended` that it returns tells whether a position is past the end.

### videoFeedReader.error

- `<Error>|<null>`

The [fatal error](#errors) that ended the feed's track or file, or `null` if there was none, as for [`feedReader.error`](#feedreadererror).

### videoFeedReader.closed

- `<boolean>`

Is `true` once the reader has been closed.

### videoFeedReader.close()

Closes the reader, so that another one can open on the feed.
Frames that you still hold keep their pixels, because their buffers belong to them, but the file's thread doesn't write into them anymore.
A closed reader returns no frames.

A reader that is no longer referenced is closed when it is garbage collected, except while it has a pending [`wait()`](#videofeedreaderwaitposition).

### decoders.createByteSource([options])

- `options: <object>`
  - `size: <number>` The size of the file in bytes, if it is known. Default: unknown
  - `randomAccess: <boolean>` Set to `true` to keep only a window of bytes around the read position, instead of everything that was pushed. Default: `false`
  - `aheadLimit: <number>` For random access, how many bytes past the read position to keep. Default: 16 MiB
  - `behindLimit: <number>` For random access, how many bytes before the read position to keep. Default: 4 MiB
- Returns: [`<ByteSource>`](#class-bytesource)

Creates a source that you fill with bytes, for example from `fetch`, so that a file can come from the network without FFmpeg's network code.
Pass it to [`decoders.open()`](#decodersopensource-options) and push bytes into it before and while the file opens.

```js
const source = decoders.createByteSource({ size })
const opening = decoders.open(source)
let offset = 0
for await (const chunk of response.body) {
  if (!source.push(offset, chunk)) { await source.drain() }
  offset += chunk.byteLength
}
source.end()
const file = await opening
```

### class ByteSource

The API does not expose the `ByteSource` class.
Instead, [`decoders.createByteSource()`](#decoderscreatebytesourceoptions) returns objects of type `ByteSource`.

The demuxer reads from the source on the file's thread, and waits there for bytes that haven't been pushed yet.
When it needs bytes that are neither buffered nor about to arrive from the current stream, the source asks for them with a [`'request'`](#event-request) event.

### Event: 'request'

- `offset: <number>` The position in the file that the demuxer needs bytes from.

Emitted when the demuxer needs bytes from somewhere else than the current stream, usually after a seek.
Respond by calling [`restart(offset)`](#bytesourcerestartoffset) and then pushing bytes from that offset, for example from a ranged request.

### Event: 'drain'

Emitted when a random-access source that [`push()`](#bytesourcepushoffset-bytes) turned away has room for more bytes again.

<a id="byte-source-event-close"></a>

### Event: 'close'

Emitted when the source is [closed](#bytesourceclose).

### byteSource.push(offset, bytes)

- `offset: <number>` The position of the bytes in the file.
- `bytes: <ArrayBuffer>|<ArrayBufferView>` The bytes. They are copied.
- Returns: `<boolean>` `false` if the source wants no more bytes for now, or if it is closed.

Adds bytes to the source.
A random-access source returns `false` once `aheadLimit` bytes past the read position are buffered.
Wait for the [`'drain'`](#event-drain) event or for [`drain()`](#bytesourcedrain) before pushing more.

### byteSource.drain()

- Returns: `<Promise>` Resolves when the source has room for more bytes, when it asks for other bytes, or when it is closed.

### byteSource.restart(offset)

- `offset: <number>` The position that the next pushed bytes start at.

Tells the source that a new stream of bytes begins at `offset`.
It also clears an error set by [`fail()`](#bytesourcefailmessage) and resolves pending [`drain()`](#bytesourcedrain) calls.

### byteSource.size

- `<number>|<null>`

The size of the file in bytes, or `null` if it isn't known yet or the source is closed.

### byteSource.setSize(size)

- `size: <number>` The size of the file in bytes.

Sets the size of the file, once it becomes known.
Without a size, the demuxer can't seek relative to the end of the file.

### byteSource.end()

Tells the source that the current stream has reached the end of the file.
If the size wasn't known, it becomes the end of what was pushed.

### byteSource.fail([message])

- `message: <string>` A description of the failure. Default: `'error'`

Makes the demuxer's reads fail, for example after a network error.
The failure reaches the file as a [`'decodeError'`](#event-decodeerror), or rejects [`decoders.open()`](#decodersopensource-options) if the file isn't open yet.

### byteSource.bufferedRanges

- `<number[][]>` A list of `[ start, end ]` pairs of byte offsets, with `end` exclusive.

The ranges of the file that the source holds at the moment.

### byteSource.randomAccess

- `<boolean>`

The `randomAccess` option that the source was created with.

### byteSource.closed

- `<boolean>`

Is `true` once the source has been closed.

### byteSource.close()

Frees the source's bytes and makes the demuxer's reads stop.
Closing a [file](#fileclose) also closes its source, and so does the end of a [`decodeAudio()`](#decodersdecodeaudiosource-options) call.

A source that is no longer referenced is closed when it is garbage collected.
A file keeps its source alive, and so does a `decodeAudio()` call until it settles.

## Patented codecs

H.264, HEVC and AAC are covered by patents. They are included in the default installation for convenience.
If you are building something that you don't plan to share with others then you'll be fine.
But if you are planning to distribute an application that uses these patented codecs then you will have to license them.
This is entirely your responsibility and not covered here.

If you don't actually need these codecs, and you still want to distribute your software, then you have the option of only bundling the patent-free codecs in your application. This project's FFMpeg binaries can be found in the [build-ffmpeg](https://github.com/kmamal/build-ffmpeg) project. Two versions are included in each release:

- The `full` binaries include the patented codecs.
- The `free` binaries don't.

The `full` binaries are downloaded by default into this package's `dist/` folder. You can replace them with the `free` binaries right before shipping. The best place to do this is as an extra step in you packaging process. This package itself functions the same way regardless of which binary is downloaded.
