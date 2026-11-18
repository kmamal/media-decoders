#include "audio-track.h"
#include "time-epsilon.h"
#include <algorithm>


AudioTrack::AudioTrack (TrackHost &host, int index, AVStream *stream)
	: Track(host, index, stream)
{
	_pipeline.onError = [this] (int error) { _host.reportError(averror(error), false, this->index); };
}

void
AudioTrack::_configure (AVCodecContext *ctx)
{
	_pipeline.open(ctx, stream, _host.startTime());
	_pipeline.restart(_segment_start);
}

void
AudioTrack::clear (bool keep_ready)
{
	Track::clear(keep_ready);
	_pipeline.clear();
	_audio_end = -1;
}

void
AudioTrack::restart (double time, bool keep_ready)
{
	Track::restart(time, keep_ready);
	_pipeline.restart(time);
}

void
AudioTrack::queue (AVPacket *packet)
{
	_pipeline.notePacket(packet);
	Track::queue(packet);
}

bool
AudioTrack::canSeekForward (double time, int64_t)
{
	if (drained() || _audio_end < 0) { return false; }
	return time >= _audio_end - TIME_EPSILON;
}

void
AudioTrack::seekForward (double time, int64_t)
{
	_pipeline.restart(time);
	_segment_start = time;
	_first_in_segment = true;
}

bool
AudioTrack::complete ()
{
	if (!drained() || _has_stash) { return false; }
	if (_pipeline.needsFlush()) { return false; }
	return _pipeline.pending() == 0 && _writer.silenceRemaining() == 0;
}

bool
AudioTrack::hasRoom ()
{
	if (!_writer.active()) { return false; }
	const int64_t free = _writer.freeFrames();
	if (free >= _writer.capacity() / 4) { return true; }
	if (_pipeline.pending() > 0) { return free > 0; }
	if (drained() && !_pipeline.needsFlush()) {
		const int64_t remaining = _writer.silenceRemaining();
		return remaining > 0 && free >= remaining;
	}
	return false;
}

StepResult
AudioTrack::step (std::unique_lock<std::mutex> &lock)
{
	if (_pipeline.pending() > 0) { return _writePending() > 0 ? StepResult::Progress : StepResult::Blocked; }
	if (_has_stash) {
		_handleFrame();
		return StepResult::Progress;
	}
	if (drained()) {
		if (_pipeline.needsFlush()) {
			const int error = _pipeline.flush();
			if (error < 0) { _host.reportError(averror(error), false, index); }
			return StepResult::Progress;
		}
		if (_writer.silenceRemaining() > 0) { return _writer.writeSilence() > 0 ? StepResult::Progress : StepResult::Blocked; }
		return StepResult::Blocked;
	}

	int error = 0;
	lock.unlock();
	const Received received = _codec.receive(_stash, &error);
	lock.lock();

	if (received == Received::Frame) {
		_has_stash = true;
		if (_host.requestsPending()) { return StepResult::Progress; }
		_handleFrame();
		return StepResult::Progress;
	}

	if (received == Received::NeedPacket) { return _sendPacket(lock); }
	if (received == Received::Error) {
		_host.reportError(averror(error), false, index);
		return StepResult::Progress;
	}

	_setDrained();
	if (state == TrackState::Failed) { return StepResult::Progress; }
	if (_host.videoEnabled()) { _writer.silenceUntil(_host.duration()); }
	return StepResult::Progress;
}

void
AudioTrack::_handleFrame ()
{
	const int64_t before = _pipeline.inputSamples();
	const int channels = _writer.outputChannels(_stash->ch_layout.nb_channels);
	const bool consumed = _pipeline.push(_stash, _writer.rate(), channels);
	if (_pipeline.channels() > 0) { _writer.setChannels(_pipeline.channels(), _host.currentSegment()); }
	if (consumed) {
		if (_pipeline.inputSamples() != before) { _audio_end = _pipeline.nextTime(); }
		av_frame_unref(_stash);
		_has_stash = false;
	}
	if (_pipeline.pending() > 0) { _writePending(); }
}

int64_t
AudioTrack::_writePending ()
{
	_sources.resize(static_cast<size_t>(_pipeline.channels()));
	for (int c = 0; c < _pipeline.channels(); c++) { _sources[c] = _pipeline.plane(c); }
	const int64_t written = _writer.write(_sources.data(), _pipeline.pending());
	_pipeline.consume(written);
	return written;
}
