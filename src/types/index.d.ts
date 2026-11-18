import { EventEmitter } from 'node:events'

export interface CloseEvent {
	readonly type: 'close'
}

export type FrameFormat = 'rgba' | 'yuv420p' | 'gray'
export type Matrix = 'bt601' | 'bt709' | 'bt2020'
export type Transfer = 'sdr' | 'pq' | 'hlg'

export interface VideoFrame {
	readonly width: number
	readonly height: number
	readonly displayWidth: number
	readonly displayHeight: number
	readonly format: FrameFormat
	readonly planes: Uint8Array[]
	readonly data?: Uint8Array
	readonly timestamp: number
	readonly duration: number
	readonly segment: number
	readonly file: number
	readonly matrix?: Matrix
	readonly fullRange?: boolean
	readonly transfer: Transfer
}

export interface VideoReaderOptions {
	format?: FrameFormat
	width?: number
	height?: number
	frames?: number
	threads?: number
}

export interface VideoReader extends EventEmitter {
	on (event: 'close', listener: (event: CloseEvent) => void): this
	on (event: '*', listener: (type: 'close', event: CloseEvent) => void): this
	on (event: 'error', listener: (error: Error) => void): this

	readonly format: FrameFormat
	readonly width: number
	readonly height: number
	readonly ended: boolean
	readonly closed: boolean
	read (): Promise<VideoFrame | null>
	tryRead (): VideoFrame | null
	wait (): Promise<void>
	release (frame: VideoFrame): void
	close (): void
}

export interface AudioBlock {
	readonly frames: number
	readonly timestamp: number
	readonly segment: number
}

export interface AudioChannelsBlock extends AudioBlock {
	readonly channels: Float32Array[]
}

export interface AudioInterleavedBlock extends AudioBlock {
	readonly channels: number
	readonly data: Float32Array
}

export interface AudioReaderOptions {
	sampleRate?: number
}

export interface AudioReader extends EventEmitter {
	on (event: 'close', listener: (event: CloseEvent) => void): this
	on (event: '*', listener: (type: 'close', event: CloseEvent) => void): this
	on (event: 'error', listener: (error: Error) => void): this

	readonly sampleRate: number
	readonly channels: number
	readonly ended: boolean
	readonly closed: boolean
	readChannels (duration?: number): Promise<AudioChannelsBlock | null>
	readInterleaved (duration?: number): Promise<AudioInterleavedBlock | null>
	readChannelsInto (channels: Float32Array[]): Promise<AudioChannelsBlock | null>
	readInterleavedInto (data: Float32Array): Promise<AudioInterleavedBlock | null>
	close (): void
}

export interface Track {
	readonly index: number
	readonly type: 'video' | 'audio' | 'other'
	readonly codec: string
	readonly decodable: boolean
	readonly startTime: number
	readonly duration: number | null
}

export interface VideoTrack extends Track {
	readonly type: 'video'
	readonly width: number
	readonly height: number
	readonly displayWidth: number
	readonly displayHeight: number
	readonly rotation: 0 | 90 | 180 | 270
	readonly flip: boolean
	readonly frameRate: number | null
	readonly matrix: Matrix
	readonly fullRange: boolean
	readonly transfer: Transfer
	createReader (options?: VideoReaderOptions): VideoReader
}

export interface AudioTrack extends Track {
	readonly type: 'audio'
	readonly sampleRate: number
	readonly channels: number
	createReader (options?: AudioReaderOptions): AudioReader
}

export interface OtherTrack extends Track {
	readonly type: 'other'
}

export type AnyTrack = VideoTrack | AudioTrack | OtherTrack

export interface DecodeError extends Error {
	fatal: boolean
	track: AnyTrack | null
}

export interface DecodeErrorEvent {
	readonly type: 'decodeError'
	readonly error: DecodeError
}

export interface MediaFile extends EventEmitter {
	on (event: 'decodeError', listener: (event: DecodeErrorEvent) => void): this
	on (event: 'close', listener: (event: CloseEvent) => void): this
	on (event: '*', listener: (type: 'decodeError' | 'close', event: DecodeErrorEvent | CloseEvent) => void): this
	on (event: 'error', listener: (error: Error) => void): this

	readonly id: number
	readonly duration: number
	readonly startTime: number
	readonly format: string
	readonly tracks: AnyTrack[]
	readonly closed: boolean
	readonly loop: boolean
	setLoop (loop: boolean): void
	readonly lastSegment: number
	seek (time: number): number
	attach (feed: Feed, track?: AudioTrack | null): number
	attach (feed: VideoFeed, track: VideoTrack): number
	detach (feed: Feed | VideoFeed): void
	close (): void
}

export interface ByteSourceOptions {
	size?: number
	randomAccess?: boolean
	aheadLimit?: number
	behindLimit?: number
}

export interface ByteSourceRequestEvent {
	readonly type: 'request'
	readonly offset: number
}

export interface ByteSourceDrainEvent {
	readonly type: 'drain'
}

export type ByteSourceEvent = ByteSourceRequestEvent | ByteSourceDrainEvent | CloseEvent

export interface ByteSource extends EventEmitter {
	on (event: 'request', listener: (event: ByteSourceRequestEvent) => void): this
	on (event: 'drain', listener: (event: ByteSourceDrainEvent) => void): this
	on (event: 'close', listener: (event: CloseEvent) => void): this
	on (event: '*', listener: (type: ByteSourceEvent['type'], event: ByteSourceEvent) => void): this
	on (event: 'error', listener: (error: Error) => void): this
	readonly randomAccess: boolean
	readonly size: number | null
	readonly bufferedRanges: Array<[ number, number ]>
	readonly closed: boolean
	push (offset: number, bytes: ArrayBufferView | ArrayBuffer): boolean
	drain (): Promise<void>
	restart (offset: number): void
	end (): void
	fail (message?: string): void
	setSize (size: number): void
	close (): void
}

export type Source = string | URL | ArrayBuffer | SharedArrayBuffer | ArrayBufferView | ByteSource

export interface OpenOptions {
	maxQueuedBytes?: number
}

export type Feed = SharedArrayBuffer
export type VideoFeed = SharedArrayBuffer

export interface FeedPosition {
	readonly file: number
	readonly generation: number
	readonly segment: number
	readonly time: number
	readonly ended: boolean
}

export interface FeedReaderOptions {
	sampleRate: number
	channels?: number
	maxChannels?: number
	buffer?: number
}

export interface FeedReadOptions {
	rate?: number
}

export interface FeedError extends Error {
	readonly fatal: true
	readonly errno: number
}

export interface FeedReader extends EventEmitter {
	on (event: 'close', listener: (event: CloseEvent) => void): this
	on (event: '*', listener: (type: 'close', event: CloseEvent) => void): this
	on (event: 'error', listener: (error: Error) => void): this
	readonly sampleRate: number
	readonly channels: number
	readonly ended: boolean
	readonly error: FeedError | null
	readonly closed: boolean
	readInto (channels: Float32Array[], options?: FeedReadOptions): number
	wait (frames?: number, options?: FeedReadOptions): Promise<void>
	close (): void
}

export interface VideoFeedReaderOptions {
	format: FrameFormat
	width: number
	height: number
	frames?: number
}

export interface VideoFeedPosition {
	file?: number
	segment?: number
	time: number
}

export interface VideoFeedAt {
	readonly frame: VideoFrame | null
	readonly ended: boolean
}

export interface VideoFeedReader extends EventEmitter {
	on (event: 'close', listener: (event: CloseEvent) => void): this
	on (event: '*', listener: (type: 'close', event: CloseEvent) => void): this
	on (event: 'error', listener: (error: Error) => void): this
	readonly format: FrameFormat
	readonly width: number
	readonly height: number
	readonly ended: boolean
	readonly error: FeedError | null
	readonly closed: boolean
	next (): VideoFrame | null
	at (position: VideoFeedPosition): VideoFeedAt
	release (frame: VideoFrame): void
	wait (position?: VideoFeedPosition): Promise<void>
	close (): void
}

export function open (source: Source, options?: OpenOptions): Promise<MediaFile>
export function createFeed (): Feed
export function createVideoFeed (): VideoFeed
export function getFeedUserData (feed: Feed | VideoFeed): Uint8Array
export function getPosition (feed: Feed, lagFrames?: number): FeedPosition
export function createFeedReader (feed: Feed, options: FeedReaderOptions): FeedReader
export function createVideoFeedReader (feed: VideoFeed, options: VideoFeedReaderOptions): VideoFeedReader
export function createByteSource (options?: ByteSourceOptions): ByteSource
export interface DecodeAudioOptions {
	track?: number
	sampleRate?: number
	maxLength?: number
	start?: number
	end?: number
	signal?: AbortSignal
}

export interface DecodedAudio {
	sampleRate: number
	channels: Float32Array[]
}

export interface DecodedInterleavedAudio {
	sampleRate: number
	channels: number
	data: Float32Array
}

export function decodeAudio (source: Source, options?: DecodeAudioOptions): Promise<DecodedAudio>
export function decodeAudioInterleaved (source: Source, options?: DecodeAudioOptions): Promise<DecodedInterleavedAudio>

export interface DecodeFrameOptions extends VideoReaderOptions {
	track?: number
}

export interface DecodeVideoOptions extends DecodeFrameOptions {
	start?: number
	end?: number
}

export function decodeFrame (source: Source, time?: number, options?: DecodeFrameOptions): Promise<VideoFrame | null>
export function decodeVideo (source: Source, options?: DecodeVideoOptions): AsyncGenerator<VideoFrame, void, undefined>

export const decoders: readonly string[]
export const versions: {
	readonly ffmpeg: string
	readonly avcodec: number
	readonly avformat: number
	readonly avutil: number
	readonly swscale: number
	readonly swresample: number
}
