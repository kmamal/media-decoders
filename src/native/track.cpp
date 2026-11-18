#include "track.h"
#include "feed-writer.h"


Track::Track (TrackHost &host, int index, AVStream *stream)
	: index(index)
	, stream(stream)
	, type(stream->codecpar->codec_type)
	, _host(host)
{
	_stash = av_frame_alloc();
	stream->discard = AVDISCARD_ALL;
}

Track::Track (TrackHost &host)
	: index(-1)
	, stream(nullptr)
	, type(AVMEDIA_TYPE_UNKNOWN)
	, _host(host)
{}

Track::~Track ()
{
	for (AVPacket *packet : _packets) { av_packet_free(&packet); }
	av_frame_free(&_stash);
}

FeedWriter *
Track::attachedFeed ()
{
	FeedWriter *writer = feed();
	return writer && writer->attached() ? writer : nullptr;
}

FeedLink *
Track::attachedLink ()
{
	FeedLink *writer = link();
	return writer && writer->attached() ? writer : nullptr;
}

bool
Track::enable (double segment_start)
{
	_packets_sent = 0;
	_segment_start = segment_start;
	_failure = TrackFailure();

	const int error = _codec.open(stream->codecpar, stream->time_base, _threads, [this] (AVCodecContext *ctx) { _configure(ctx); });
	if (error < 0) {
		fail(error, averror(error));
		return false;
	}

	_enabled = true;
	_opened();
	stream->discard = AVDISCARD_DEFAULT;
	state = TrackState::Decoding;
	_first_in_segment = true;
	return true;
}

void
Track::disable ()
{
	clear(false);
	_codec.close();
	_enabled = false;
	stream->discard = AVDISCARD_ALL;
	state = TrackState::Idle;
	_packets_sent = 0;
}

void
Track::clear (bool)
{
	if (_stash) { av_frame_unref(_stash); }
	_has_stash = false;
	for (AVPacket *packet : _packets) { av_packet_free(&packet); }
	_packets.clear();
	_queued_bytes = 0;
	_codec.flush();
	if (state == TrackState::Flushing || state == TrackState::Drained || state == TrackState::Ended) { state = TrackState::Decoding; }
	_first_in_segment = true;
}

void
Track::restart (double time, bool keep_ready)
{
	clear(keep_ready);
	_segment_start = time;
}

void
Track::queue (AVPacket *packet)
{
	_queued_bytes += packet->size;
	_packets.push_back(packet);
}

void
Track::cutAfter (int64_t)
{
	clear(true);
	if (state != TrackState::Failed) { state = TrackState::Ended; }
}

void
Track::finish ()
{
	state = _host.fileFailed() ? TrackState::Failed : TrackState::Ended;
	_host.notify();
}

void
Track::fail (int code, const std::string &message)
{
	state = TrackState::Failed;
	_failure = { code, message };
	_host.reportError(message, true, index);
}

StepResult
Track::_sendPacket (std::unique_lock<std::mutex> &lock)
{
	if (!_packets.empty()) {
		AVPacket *packet = _packets.front();
		_packets.pop_front();
		_queued_bytes -= packet->size;
		_packets_sent += 1;
		lock.unlock();
		const int error = _codec.send(packet);
		av_packet_free(&packet);
		lock.lock();
		// Non-fatal: skip the packet and keep decoding, as the ffmpeg command does.
		if (error < 0) { _host.reportError(averror(error), false, index); }
		return StepResult::Progress;
	}
	if (_host.demuxEnded() && state == TrackState::Decoding) {
		lock.unlock();
		_codec.drain();
		lock.lock();
		state = TrackState::Flushing;
		return StepResult::Progress;
	}
	return StepResult::NeedPackets;
}

void
Track::_setDrained ()
{
	state = TrackState::Drained;
	if (_packets_sent == 0 && !_host.fileFailed()) { fail(AVERROR_INVALIDDATA, "the track has no data"); }
}
