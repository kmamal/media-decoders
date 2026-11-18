#include "silent-track.h"
#include <algorithm>


bool
SilentTrack::enable (double segment_start)
{
	_segment_start = segment_start;
	_enabled = true;
	state = TrackState::Decoding;
	return true;
}

void
SilentTrack::disable ()
{
	_enabled = false;
	state = TrackState::Idle;
}

bool
SilentTrack::hasRoom ()
{
	const int64_t remaining = _writer.silenceRemaining();
	return _writer.active() && _writer.freeFrames() >= std::min<int64_t>(remaining, _writer.capacity() / 4);
}

StepResult
SilentTrack::step (std::unique_lock<std::mutex> &)
{
	return _writer.writeSilence() > 0 ? StepResult::Progress : StepResult::Blocked;
}
