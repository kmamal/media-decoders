#include "video-track.h"
#include "time-epsilon.h"
#include <cmath>
#include <algorithm>


VideoTrack::VideoTrack (TrackHost &host, int index, AVStream *stream, AVFormatContext *format)
	: Track(host, index, stream)
	, _format(format)
{
	_output.orientation = Orientation::of(stream->codecpar);
	_pending_frame = av_frame_alloc();
}

VideoTrack::~VideoTrack ()
{
	av_frame_free(&_pending_frame);
	sws_free_context(&_output.sws);
	av_frame_free(&_output.scaled);
}

void
VideoTrack::_opened ()
{
	_output.sws = sws_alloc_context();
	_output.sws->flags = SWS_BICUBIC;
	_output.sws->threads = _threads;
}

void
VideoTrack::disable ()
{
	Track::disable();
	sws_free_context(&_output.sws);
	av_frame_free(&_output.scaled);
	_ready.clear();
}

void
VideoTrack::clear (bool keep_ready)
{
	if (!keep_ready) {
		for (const OutFrame &frame : _ready) { _writer.takeBack(frame); }
		_ready.clear();
	}
	if (_pending_frame) { av_frame_unref(_pending_frame); }
	_has_pending = false;
	Track::clear(keep_ready);
	_last_decoded = -1;
}

void
VideoTrack::_prune ()
{
	if (!_writer.block()) { return; }
	_ready.erase(
		std::remove_if(_ready.begin(), _ready.end(), [this] (const OutFrame &frame) { return !_writer.isReady(frame); }),
		_ready.end());
}

double
VideoTrack::nextTime ()
{
	_prune();
	if (!_ready.empty()) { return _ready.front().timestamp; }
	if (_converting >= 0) { return _converting; }
	if (_has_pending) { return _pending.timestamp; }
	if (_last_decoded >= 0) { return _last_decoded + _last_duration; }
	return _segment_start;
}

bool
VideoTrack::takeReaderChange (double *time)
{
	if (!_writer.readerChanged()) { return false; }
	const double next = nextTime();
	const bool changed = _writer.takeReaderChange();
	_ready.clear();
	if (!changed || !enabled()) { return false; }
	*time = next;
	return true;
}

StepResult
VideoTrack::step (std::unique_lock<std::mutex> &lock)
{
	if (_has_pending && drained()) {
		return _finishLast(lock) ? StepResult::Progress : StepResult::Blocked;
	}
	if (_has_stash) { return _handleFrame(lock); }

	int error = 0;
	lock.unlock();
	const Received received = _codec.receive(_stash, &error);
	lock.lock();

	if (received == Received::Frame) {
		_has_stash = true;
		return _handleFrame(lock);
	}

	if (received == Received::NeedPacket) { return _sendPacket(lock); }
	if (received == Received::Error) {
		_host.reportError(averror(error), false, index);
		return StepResult::Progress;
	}

	_setDrained();
	if (_has_pending) { _finishLast(lock); }
	return StepResult::Progress;
}

bool
VideoTrack::_finishLast (std::unique_lock<std::mutex> &lock)
{
	const double end = std::max(
		_host.duration(),
		_pending.timestamp + _pending_fallback_duration);
	return _finishPending(end, lock);
}

StepResult
VideoTrack::_handleFrame (std::unique_lock<std::mutex> &lock)
{
	AVFrame *frame = _stash;
	const AVRational time_base = stream->time_base;

	double timestamp;
	if (frame->best_effort_timestamp != AV_NOPTS_VALUE) {
		timestamp = toSeconds(frame->best_effort_timestamp, time_base) - _host.startTime();
	}
	else if (_last_decoded >= 0) {
		timestamp = _last_decoded + _last_duration;
	}
	else {
		timestamp = _segment_start;
	}

	double fallback_duration = frame->duration > 0 ? toSeconds(frame->duration, time_base) : 0;
	if (fallback_duration <= 0) {
		const AVRational rate = av_guess_frame_rate(_format, stream, nullptr);
		fallback_duration = rate.num > 0 ? av_q2d(av_inv_q(rate)) : 1.0 / 25;
	}

	if (_first_in_segment) {
		if (!_has_pending && timestamp > _segment_start + TIME_EPSILON) {
			const int slot = _writer.acquire();
			if (slot < 0) { return StepResult::Blocked; }
			_first_in_segment = false;
			const AVCodecParameters *params = stream->codecpar;
			const VideoBlockRef &block = _writer.block();
			{
				std::unique_lock<std::mutex> pixels(block->mutex);
				if (block->alive) { VideoOutput::fillBlack(block->layout, block->slots[slot].data, params->color_range == AVCOL_RANGE_JPEG); }
			}
			OutFrame black;
			black.timestamp = _segment_start;
			black.duration = timestamp - _segment_start;
			black.colorspace = defaultColorspace(params->color_space, params->height);
			black.range = defaultRange(params->color_range);
			black.transfer = params->color_trc;
			_pushReady(slot, black);
			return StepResult::Progress;
		}
		_first_in_segment = false;
	}

	if (_has_pending && !_finishPending(timestamp, lock)) { return StepResult::Blocked; }

	av_frame_move_ref(_pending_frame, frame);
	_has_stash = false;
	_has_pending = true;
	_pending.timestamp = timestamp;
	_pending_fallback_duration = fallback_duration;
	_last_decoded = timestamp;
	_last_duration = fallback_duration;
	return StepResult::Progress;
}

bool
VideoTrack::_finishPending (double next_timestamp, std::unique_lock<std::mutex> &lock)
{
	const double timestamp = _pending.timestamp;
	const bool before_target = next_timestamp <= _segment_start + TIME_EPSILON;
	if (before_target && !drained()) {
		_has_pending = false;
		av_frame_unref(_pending_frame);
		return true;
	}

	double duration = next_timestamp - timestamp;
	if (duration <= 0) { duration = _pending_fallback_duration; }

	const int64_t segment = _host.currentSegment();
	if (!drained() && _writer.behindReader(segment, timestamp + duration)) {
		_has_pending = false;
		av_frame_unref(_pending_frame);
		_writer.noteEnd(segment, timestamp + duration);
		return true;
	}

	const int slot = _writer.acquire();
	if (slot < 0) { return false; }
	_has_pending = false;
	const VideoBlockRef block = _writer.block();

	OutFrame out;
	out.timestamp = timestamp;
	out.duration = duration;

	AVFrame *frame = av_frame_alloc();
	av_frame_move_ref(frame, _pending_frame);
	const bool full_range = stream->codecpar->color_range == AVCOL_RANGE_JPEG;
	_converting = timestamp;
	lock.unlock();
	int error = 0;
	{
		std::unique_lock<std::mutex> pixels(block->mutex);
		if (block->alive) { error = _output.convert(frame, block->layout, block->slots[slot].data, full_range, &out); }
	}
	lock.lock();
	_converting = -1;
	av_frame_free(&frame);
	if (error < 0) { _host.reportError(averror(error), false, index); }

	if (_writer.block() != block) {
		block->slots[slot].state.store(SLOT_FREE, std::memory_order_release);
		return true;
	}
	_pushReady(slot, out);
	return true;
}

void
VideoTrack::_pushReady (int slot, const OutFrame &frame)
{
	OutFrame out = frame;
	out.segment = _host.currentSegment();
	_writer.publish(slot, out);
	_ready.push_back(out);
	_host.notify();
}

bool
VideoTrack::canSeekForward (double time, int64_t segment)
{
	if (drained() || _last_decoded < 0) { return false; }

	_prune();
	if (!_ready.empty() && _ready.front().segment != segment) { return false; }
	double earliest = _last_decoded;
	if (!_ready.empty()) { earliest = _ready.front().timestamp; }
	else if (_has_pending) { earliest = _pending.timestamp; }
	if (time < earliest - TIME_EPSILON) { return false; }

	const double start_time = _host.startTime();
	const AVRational time_base = stream->time_base;
	const int64_t target = static_cast<int64_t>(std::llround((time + start_time) / av_q2d(time_base)));
	const int entry_index = av_index_search_timestamp(stream, target, AVSEEK_FLAG_BACKWARD);
	const AVIndexEntry *entry = entry_index >= 0 ? avformat_index_get_entry(stream, entry_index) : nullptr;
	if (entry) {
		const double keyframe = toSeconds(entry->timestamp, time_base) - start_time;
		if (keyframe > _last_decoded + TIME_EPSILON) { return false; }
	}
	else if (time - _last_decoded > 1.0) {
		return false;
	}
	return true;
}

void
VideoTrack::seekForward (double time, int64_t segment)
{
	std::deque<OutFrame> kept;
	for (OutFrame &frame : _ready) {
		if (frame.timestamp + frame.duration <= time + TIME_EPSILON) {
			_writer.takeBack(frame);
			continue;
		}
		if (!_writer.relabel(frame, segment)) { continue; }
		frame.segment = segment;
		kept.push_back(frame);
	}
	_ready = std::move(kept);
	_segment_start = time;
	_first_in_segment = false;
}

void
VideoTrack::cutAfter (int64_t segment)
{
	Track::cutAfter(segment);
	std::deque<OutFrame> kept;
	for (const OutFrame &frame : _ready) {
		if (frame.segment > segment) { _writer.takeBack(frame); }
		else { kept.push_back(frame); }
	}
	_ready = std::move(kept);
	_writer.cutAfter(segment);
}
