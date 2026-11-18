#include "file-core.h"
#include "time-epsilon.h"
#include <cmath>
#include <cctype>
#include <cstring>
#include <algorithm>


static constexpr size_t MAX_QUEUED_ERRORS = 64;

// Demuxers hide most damage behind a resync or a clean AVERROR_EOF and only log it,
// so the av_log callback reports the errors logged for the file this thread belongs to.
static thread_local FileCore *log_target = nullptr;


static std::atomic<uint64_t> next_file_id { 1 };

FileCore::FileCore (InputSource &&source, double max_queued_bytes, std::function<void ()> notify)
	: _id(next_file_id.fetch_add(1))
	, _notify(std::move(notify))
	, _source(std::move(source))
	, _max_queued_bytes(max_queued_bytes)
	, _silent(*this)
{
	_thread = std::thread([this] () { _run(); });
}

FileCore::~FileCore ()
{
	close();
}

void
FileCore::close ()
{
	std::vector<FeedLink *> writers;
	{
		std::unique_lock<std::mutex> lock(_mutex);
		if (_closed) { return; }
		_closed = true;
		_closing = true;
		_wake();
		if (_opened) {
			for (Track *track : _all) {
				if (FeedLink *writer = track->attachedLink()) { writers.push_back(writer); }
			}
		}
	}
	std::vector<bool> owned;
	for (FeedLink *writer : writers) { owned.push_back(FeedHub::clearWriter(writer->id(), this)); }
	if (_source.source) { _source.source->close(); }
	if (_thread.joinable()) { _thread.join(); }

	for (size_t i = 0; i < writers.size(); i++) {
		if (writers[i]->detach(owned[i])) { FeedHub::wakeReader(writers[i]->id()); }
	}
	_dead.clear();
	_tracks.clear();

	av_packet_free(&_packet);
	_input.close();
	_source.source.reset();
}

void
FileCore::notify ()
{
	if (_notify_pending || _closed) { return; }
	_notify_pending = true;
	_notify();
}

void
FileCore::reportError (const std::string &message, bool fatal, int track)
{
	if (!fatal && _errors.size() >= MAX_QUEUED_ERRORS) { return; }
	_errors.push_back({ message, fatal, track });
	notify();
}

void
FileCore::retire (KeepAliveToken token)
{
	if (token) { _dead.push_back(std::move(token)); }
}

bool
FileCore::videoEnabled () const
{
	for (const auto &track : _tracks) {
		if (track->enabled() && track->type == AVMEDIA_TYPE_VIDEO) { return true; }
	}
	return false;
}

void
FileCore::captureLogs ()
{
	av_log_set_callback(_log);
}

void
FileCore::_log (void *avcl, int level, const char *fmt, va_list args)
{
	FileCore *file = log_target;
	if (file && avcl && avcl == file->_input.format && level <= AV_LOG_ERROR && file->_log_errors.size() < MAX_QUEUED_ERRORS) {
		char buffer[1024];
		va_list copy;
		va_copy(copy, args);
		vsnprintf(buffer, sizeof(buffer), fmt, copy);
		va_end(copy);
		std::string message(buffer);
		while (!message.empty() && std::isspace(static_cast<unsigned char>(message.back()))) { message.pop_back(); }
		file->_log_errors.push_back(message);
	}
	av_log_default_callback(avcl, level, fmt, args);
}

std::string
FileCore::_readError (int error)
{
	if (_source.source && error == AVERROR(EIO)) {
		std::unique_lock<std::mutex> lock(_source.source->mutex);
		if (!_source.source->error.empty()) { return _source.source->error; }
	}
	return averror(error);
}

void
FileCore::_collectLogErrors ()
{
	for (const std::string &message : _log_errors) { reportError(message, false, -1); }
	_log_errors.clear();
}

int
FileCore::_interrupt (void *opaque)
{
	FileCore *file = static_cast<FileCore *>(opaque);
	return file->_closing ? 1 : 0;
}

bool
FileCore::_open ()
{
	const AVIOInterruptCB interrupt = { _interrupt, this };
	const int error = _input.open(&_source, &interrupt);
	if (error < 0) {
		_open_error = _readError(error);
		return false;
	}

	const double format_start = _input.format->start_time != AV_NOPTS_VALUE
		? static_cast<double>(_input.format->start_time) / AV_TIME_BASE
		: 0;
	const double format_duration = _input.format->duration != AV_NOPTS_VALUE
		? static_cast<double>(_input.format->duration) / AV_TIME_BASE
		: 0;
	_start_time = _input.startTime();
	_duration = std::max(0.0, format_start + format_duration - _start_time);

	_packet = av_packet_alloc();

	_tracks.reserve(_input.format->nb_streams);
	for (unsigned int i = 0; i < _input.format->nb_streams; i++) {
		AVStream *stream = _input.format->streams[i];
		const int index = static_cast<int>(i);
		TrackHost &host = *this;
		switch (stream->codecpar->codec_type) {
			case AVMEDIA_TYPE_VIDEO: _tracks.push_back(std::make_unique<VideoTrack>(host, index, stream, _input.format)); break;
			case AVMEDIA_TYPE_AUDIO: _tracks.push_back(std::make_unique<AudioTrack>(host, index, stream)); break;
			default: _tracks.push_back(std::make_unique<Track>(host, index, stream)); break;
		}
		_all.push_back(_tracks.back().get());
	}
	_all.push_back(&_silent);
	_requested.tracks.resize(_all.size());
	_info = _readInfo();

	return true;
}

Track &
FileCore::_track (int index)
{
	if (index < 0) { return _silent; }
	return *_tracks[index];
}

VideoTrack *
FileCore::_video (uint32_t index)
{
	if (index >= _tracks.size() || _tracks[index]->type != AVMEDIA_TYPE_VIDEO) { return nullptr; }
	return static_cast<VideoTrack *>(_tracks[index].get());
}

TrackRequest &
FileCore::_request (int index)
{
	if (index < 0) { return _requested.tracks.back(); }
	return _requested.tracks[index];
}

void
FileCore::_requestChanged ()
{
	_requested.changed = true;
	_wake();
}

void
FileCore::_reconcile (std::unique_lock<std::mutex> &lock)
{
	_requested.changed = false;
	const int64_t serial = _request_serial;

	for (size_t i = 0; i < _all.size(); i++) {
		Track &track = *_all[i];
		TrackRequest &request = _requested.tracks[i];
		if (!track.enabled() || (request.reader && request.applied == request.generation)) { continue; }
		const double time = track.type == AVMEDIA_TYPE_VIDEO && request.resume_time < 0 ? static_cast<VideoTrack &>(track).nextTime() : request.resume_time;
		request.resume_time = -1;
		if (time >= 0 && (_resume_time < 0 || time < _resume_time)) { _resume_time = time; }
		track.disable();
		notify();
	}

	if (_requested.loop) {
		_loop = *_requested.loop;
		_requested.loop.reset();
		if (_loop) {
			for (auto &track : _tracks) {
				if (track->state != TrackState::Ended) { continue; }
				track->state = TrackState::Drained;
				if (FeedLink *writer = track->attachedLink()) { writer->reopen(); }
			}
		}
		_applyLoopChange();
	}

	for (size_t i = 0; i < _all.size() && !_closing; i++) {
		Track &track = *_all[i];
		TrackRequest &request = _requested.tracks[i];
		if (!request.reader || track.enabled()) { continue; }
		request.applied = request.generation;
		const double time = _currentTime();
		if (track.type == AVMEDIA_TYPE_VIDEO) { static_cast<VideoTrack &>(track).setThreads(request.threads); }
		if (!track.enable(_segment_start)) {
			request.reader = false;
		}
		else if (!_requested.seek) {
			const bool moved = time > _segment_start + TIME_EPSILON;
			if (moved || (track.demuxes() && _demuxed)) {
				if (moved) { _next_segment += 1; }
				_applySeek({ time, moved ? _next_segment : _segment }, lock);
			}
		}
		notify();
	}

	if (_requested.seek && !_closing) {
		const SeekRequest seek = *_requested.seek;
		_requested.seek.reset();
		_applySeek(seek, lock);
	}

	_applied_serial = serial;
	for (Track *track : _all) {
		if (FeedLink *writer = track->attachedLink()) { writer->applied(serial); }
	}
}

double
FileCore::_currentTime ()
{
	double time = -1;
	for (uint32_t i = 0; i < _tracks.size(); i++) {
		VideoTrack *video = _video(i);
		if (!video || !video->enabled()) { continue; }
		const double next = video->nextTime();
		if (time < 0 || next < time) { time = next; }
	}
	for (Track *track : _all) {
		FeedWriter *writer = track->attachedFeed();
		if (!writer || !writer->hasEntry()) { continue; }
		const double consumed = writer->consumedTime(_segment_start);
		if (time < 0 || consumed < time) { time = consumed; }
	}
	if (time < 0) { time = _resume_time; }
	return time < 0 ? _segment_start : time;
}

void
FileCore::_run ()
{
	log_target = this;
	const bool ok = _open();

	std::unique_lock<std::mutex> lock(_mutex);
	_opened = ok;
	notify();
	if (!ok) { return; }

	bool armed = false;
	while (!_closing) {
		_collectLogErrors();
		_flushReaderNotify(lock);
		if (_closing) { break; }

		// Seeks and loops are handled here rather than from JS, so a stalled JS thread never starves the reader.
		if (_requested.changed) {
			_reconcile(lock);
			continue;
		}

		if (_checkReader(lock)) { continue; }

		bool progress = false;
		bool need_packets = false;
		int active = 0;
		bool all_drained = true;
		for (Track *track : _all) {
			FeedLink *writer = track->attachedLink();
			if (writer && !writer->finished() && track->failed()) {
				if (writer->finishFailed(track->failure().code, track->failure().message)) { progress = true; }
				continue;
			}
			if (!track->enabled() || track->ended()) { continue; }
			active += 1;
			if (track->complete()) { continue; }
			all_drained = false;
			if (!track->hasRoom()) { continue; }
			switch (track->step(lock)) {
				case StepResult::Progress: progress = true; break;
				case StepResult::NeedPackets: need_packets = true; break;
				case StepResult::Blocked: break;
			}
			if (_closing || _requested.changed) { break; }
		}

		if (progress || _closing || _requested.changed) {
			armed = false;
			continue;
		}

		if (active > 0 && all_drained) {
			if (_loop && (_duration > 0 || _demuxed) && !_failed) {
				_wrap(lock);
			}
			else {
				for (auto &track : _tracks) {
					if (track->enabled() && !track->ended()) { track->finish(); }
				}
				for (Track *track : _all) {
					FeedLink *writer = track->attachedLink();
					if (!writer || writer->finished()) { continue; }
					if (track->failed()) { writer->finishFailed(track->failure().code, track->failure().message); }
					else { writer->finish(); }
				}
			}
			continue;
		}

		if (need_packets && !_demux_eof && !_queuesFull()) {
			lock.unlock();
			const int error = av_read_frame(_input.format, _packet);
			lock.lock();
			_collectLogErrors();
			if (error >= 0) {
				_demuxed = true;
				Track &track = *_tracks[_packet->stream_index];
				if (track.enabled() && !track.drained()) {
					if (_packet->pts != AV_NOPTS_VALUE) {
						_demuxed_time = std::max(_demuxed_time, toSeconds(_packet->pts, track.stream->time_base) - _start_time);
					}
					AVPacket *packet = av_packet_alloc();
					av_packet_move_ref(packet, _packet);
					track.queue(packet);
				}
				else {
					av_packet_unref(_packet);
				}
			}
			else {
				_demux_eof = true;
				if (error != AVERROR_EOF && error != AVERROR_EXIT && !_closing) {
					_failed = true;
					_failure = { error, _readError(error) };
					reportError(_failure.message, true, -1);
				}
			}
			continue;
		}

		if (!armed) {
			bool waiting = false;
			for (Track *track : _all) {
				FeedLink *writer = track->attachedLink();
				if (!writer) { continue; }
				writer->armWaiting();
				waiting = true;
			}
			if (waiting) {
				armed = true;
				continue;
			}
		}
		armed = false;
		lock.unlock();
		{
			std::unique_lock<std::mutex> wake_lock(_wake_mutex);
			_wake_cond.wait(wake_lock, [this] () { return _woken; });
			_woken = false;
		}
		lock.lock();
	}
}

bool
FileCore::_queuesFull ()
{
	for (const auto &track : _tracks) {
		if (track->enabled() && !track->ended() && static_cast<double>(track->queuedBytes()) >= _max_queued_bytes) { return true; }
	}
	return false;
}

// A seek decodes forward instead of flushing when the target is ahead and before the next keyframe, so stepping one frame at a time stays cheap.
bool
FileCore::_canSeekForward (double time)
{
	bool any = false;
	for (auto &track : _tracks) {
		if (!track->enabled()) { continue; }
		any = true;
		if (!track->canSeekForward(time, _segment)) { return false; }
	}
	return any;
}

void
FileCore::_applySeek (const SeekRequest &request, std::unique_lock<std::mutex> &lock)
{
	const bool forward = _canSeekForward(request.time);
	_segment = request.segment;
	_segment_start = request.time;
	_resume_time = -1;
	_resetFeeds(request.time, true);

	if (!forward) {
		_realSeek(request.time, lock);
		notify();
		return;
	}

	for (auto &track : _tracks) {
		if (track->enabled()) { track->seekForward(request.time, _segment); }
	}
	notify();
}

void
FileCore::_realSeek (double time, std::unique_lock<std::mutex> &lock)
{
	double preroll = 0;
	for (auto &track : _tracks) {
		track->restart(time, false);
		if (track->enabled() && track->type == AVMEDIA_TYPE_AUDIO) { preroll = std::max(preroll, AudioPipeline::preroll(track->stream)); }
	}

	lock.unlock();
	_input.seek(std::max(0.0, time - preroll));
	lock.lock();

	_demux_eof = _failed;
	_demuxed = false;
}

void
FileCore::_resetFeeds (double time, bool drop)
{
	for (Track *track : _all) {
		if (FeedLink *writer = track->attachedLink()) { writer->reset(time, _segment, drop, _duration); }
	}
}

// Writes the start of the file right after the end, so looping is gapless.
void
FileCore::_wrap (std::unique_lock<std::mutex> &lock)
{
	_segment = ++_next_segment;
	_segment_start = 0;
	_resume_time = -1;
	for (auto &track : _tracks) { track->restart(0, true); }
	_resetFeeds(0, false);
	notify();

	lock.unlock();
	_input.seek(0);
	lock.lock();

	_demux_eof = _failed;
	_demuxed = false;
}


void
FileCore::_wake ()
{
	std::unique_lock<std::mutex> lock(_wake_mutex);
	_woken = true;
	_wake_cond.notify_one();
}

void
FileCore::_flushReaderNotify (std::unique_lock<std::mutex> &lock)
{
	std::vector<uint64_t> ids;
	for (Track *track : _all) {
		FeedLink *writer = track->link();
		if (writer && writer->takeReaderNotify()) { ids.push_back(writer->id()); }
	}
	if (ids.empty()) { return; }
	lock.unlock();
	for (const uint64_t id : ids) { FeedHub::wakeReader(id); }
	lock.lock();
}

bool
FileCore::_checkReader (std::unique_lock<std::mutex> &lock)
{
	double time = -1;
	for (Track *track : _all) {
		FeedWriter *writer = track->attachedFeed();
		if (!writer || !writer->takeReaderChange()) { continue; }
		const double consumed = writer->consumedTime(_segment_start);
		if (time < 0 || consumed < time) { time = consumed; }
	}
	for (uint32_t i = 0; i < _tracks.size(); i++) {
		VideoTrack *video = _video(i);
		double next = 0;
		if (video && video->videoFeed()->attached() && video->takeReaderChange(&next) && (time < 0 || next < time)) { time = next; }
	}
	if (time < 0) { return false; }
	_next_segment += 1;
	_applySeek({ time, _next_segment }, lock);
	return true;
}


void
FileCore::_applyLoopChange ()
{
	std::vector<Track *> attached;
	for (Track *track : _all) {
		if (track->attachedFeed()) { attached.push_back(track); }
	}
	if (attached.empty()) { return; }
	if (_loop) {
		for (Track *track : attached) { track->feed()->resumeLoop(); }
		return;
	}
	bool all = true;
	int64_t last = 0;
	for (Track *track : attached) {
		int64_t segment = 0;
		if (!track->feed()->cutAtLoop(&segment)) {
			all = false;
			continue;
		}
		last = std::max(last, segment);
		if (track->enabled()) { track->cutAfter(segment); }
	}
	if (all) {
		for (auto &track : _tracks) {
			if (track->enabled() && track->type != AVMEDIA_TYPE_AUDIO) { track->cutAfter(last); }
		}
	}
	notify();
}


FileEvents
FileCore::takeEvents ()
{
	FileEvents events;
	std::unique_lock<std::mutex> lock(_mutex);
	_notify_pending = false;
	_dead.clear();
	if (!_open_reported && (_opened || !_open_error.empty())) {
		_open_reported = true;
		events.opened = true;
		if (!_opened) { events.open_error = _open_error; }
	}
	events.errors.assign(_errors.begin(), _errors.end());
	_errors.clear();
	return events;
}

FileInfo
FileCore::info ()
{
	std::unique_lock<std::mutex> lock(_mutex);
	return _info;
}

FileInfo
FileCore::_readInfo ()
{
	FileInfo result;
	result.duration = _duration;
	result.start_time = _start_time;
	result.format = _input.format->iformat->name;

	for (size_t i = 0; i < _tracks.size(); i++) {
		const Track &track = *_tracks[i];
		const AVStream *stream = track.stream;
		const AVCodecParameters *params = stream->codecpar;

		TrackInfo info;
		info.type = track.type;
		info.codec = avcodec_get_name(params->codec_id);
		info.decodable = avcodec_find_decoder(params->codec_id) != nullptr;
		info.start_time = stream->start_time != AV_NOPTS_VALUE
			? toSeconds(stream->start_time, stream->time_base) - _start_time
			: 0;
		info.duration = stream->duration != AV_NOPTS_VALUE ? toSeconds(stream->duration, stream->time_base) : -1;

		if (const VideoTrack *video = _video(static_cast<uint32_t>(i))) {
			const int width = params->width;
			const int height = params->height;
			int display_width = width;
			int display_height = height;
			const AVRational sar = av_guess_sample_aspect_ratio(_input.format, const_cast<AVStream *>(stream), nullptr);
			if (sar.num > 0 && sar.den > 0 && av_cmp_q(sar, av_make_q(1, 1)) != 0) {
				if (av_cmp_q(sar, av_make_q(1, 1)) > 0) {
					display_width = static_cast<int>(std::lround(width * av_q2d(sar)));
				}
				else {
					display_height = static_cast<int>(std::lround(height / av_q2d(sar)));
				}
			}
			if (video->orientation().swap) { std::swap(display_width, display_height); }
			const AVRational rate = av_guess_frame_rate(_input.format, const_cast<AVStream *>(stream), nullptr);
			info.width = width;
			info.height = height;
			info.display_width = display_width;
			info.display_height = display_height;
			info.rotation = video->orientation().rotation();
			info.flip = video->orientation().mirrored();
			info.frame_rate = rate.num > 0 ? av_q2d(rate) : -1;
			info.matrix = matrixName(defaultColorspace(params->color_space, height));
			info.full_range = params->color_range == AVCOL_RANGE_JPEG;
			info.transfer = transferName(params->color_trc);
		}
		else if (track.type == AVMEDIA_TYPE_AUDIO) {
			info.sample_rate = params->sample_rate;
			info.channels = params->ch_layout.nb_channels;
			if (av_q2d(stream->time_base) * params->sample_rate <= 1) { info.seek_preroll = AudioPipeline::preroll(stream); }
		}

		result.tracks.push_back(std::move(info));
	}
	return result;
}

std::string
FileCore::_checkVideo (int index)
{
	if (index < 0 || index >= static_cast<int>(_tracks.size())) { return "invalid track"; }
	if (_tracks[index]->type != AVMEDIA_TYPE_VIDEO) { return "not a video track"; }
	if (_request(index).reader) { return "track already has a reader"; }
	if (!_info.tracks[index].decodable) { return "no decoder for " + _info.tracks[index].codec; }
	return std::string();
}

void
FileCore::_attachVideo (int index, const VideoFeedView &view, KeepAliveToken keep_alive, int threads)
{
	const TrackInfo &info = _info.tracks[index];
	VideoFeedWriter &writer = *_video(static_cast<uint32_t>(index))->videoFeed();
	writer.attach(view, std::move(keep_alive), _id, _segment, info.display_width, info.display_height);
	writer.request(_request_serial, _seek_serial);
	writer.applied(_applied_serial);
	TrackRequest &request = _request(index);
	request.reader = true;
	request.generation += 1;
	request.threads = threads;
	_requestChanged();
}

void
FileCore::disableTrack (uint32_t index)
{
	FeedLink *writer = nullptr;
	{
		std::unique_lock<std::mutex> lock(_mutex);
		if (_closed || index >= _tracks.size()) { return; }
		writer = _tracks[index]->attachedLink();
	}
	_disable(static_cast<int>(index), writer);
}

void
FileCore::_disable (int index, FeedLink *writer)
{
	const bool owned = writer && FeedHub::clearWriter(writer->id(), this);

	bool wake = false;
	{
		std::unique_lock<std::mutex> lock(_mutex);
		if (_closed) { return; }
		double time = -1;
		if (writer && writer->attached()) {
			FeedWriter *audio = _track(index).feed();
			if (audio && audio == writer && audio->hasEntry()) { time = audio->consumedTime(_segment_start); }
			if (VideoTrack *video = index >= 0 ? _video(static_cast<uint32_t>(index)) : nullptr) { time = video->nextTime(); }
			wake = writer->detach(owned);
		}
		TrackRequest &request = _request(index);
		if (_track(index).enabled() && time >= 0) { request.resume_time = time; }
		request.reader = false;
		_requestChanged();
	}
	if (wake) { FeedHub::wakeReader(writer->id()); }
}


int64_t
FileCore::seek (double time)
{
	std::unique_lock<std::mutex> lock(_mutex);
	_next_segment += 1;
	_requested.seek = SeekRequest { std::max(0.0, time), _next_segment };
	_seek_serial = ++_request_serial;
	_publishRequest();
	_requestChanged();
	return _next_segment;
}

int64_t
FileCore::lastSegment ()
{
	std::unique_lock<std::mutex> lock(_mutex);
	return _next_segment;
}

void
FileCore::setLoop (bool loop)
{
	std::unique_lock<std::mutex> lock(_mutex);
	_requested.loop = loop;
	_request_serial += 1;
	_publishRequest();
	_requestChanged();
}

void
FileCore::_publishRequest ()
{
	for (Track *track : _all) {
		if (FeedLink *writer = track->attachedLink()) { writer->request(_request_serial, _seek_serial); }
	}
}

std::string
FileCore::attach (int index, const FeedView &view, KeepAliveToken keep_alive, int64_t *generation)
{
	{
		std::unique_lock<std::mutex> lock(_mutex);
		if (!_opened || _closed) { return "the file is not open"; }
		for (Track *track : _all) {
			FeedLink *writer = track->attachedLink();
			if (writer && writer->id() == view.header->id) { return "the feed is already attached to this file"; }
		}
		if (index >= static_cast<int>(_tracks.size())) { return "invalid track"; }
		Track &track = _track(index);
		const bool has_reader = _request(index).reader;
		if (index < 0) {
			if (has_reader) { return "the file is already attached to a feed without a track"; }
		}
		else {
			if (track.type != AVMEDIA_TYPE_AUDIO) { return "not an audio track"; }
			if (has_reader) { return "track already has a reader"; }
			if (!_info.tracks[index].decodable) { return "no decoder for " + _info.tracks[index].codec; }
		}
	}

	if (!FeedHub::setWriter(view.header->id, this, [this] () { _wake(); })) {
		return "the feed is already attached to another file";
	}

	std::unique_lock<std::mutex> lock(_mutex);
	FeedWriter &writer = *_track(index).feed();
	writer.attach(view, std::move(keep_alive), _id, index < 0, _segment_start, _segment, _duration);
	writer.request(_request_serial, _seek_serial);
	writer.applied(_applied_serial);
	TrackRequest &request = _request(index);
	request.reader = true;
	request.generation += 1;
	_requestChanged();
	*generation = writer.generation();
	return std::string();
}

std::string
FileCore::attachVideo (int index, const VideoFeedView &view, KeepAliveToken keep_alive, int threads, int64_t *generation)
{
	{
		std::unique_lock<std::mutex> lock(_mutex);
		if (!_opened || _closed) { return "the file is not open"; }
		for (Track *track : _all) {
			FeedLink *writer = track->attachedLink();
			if (writer && writer->id() == view.header->id) { return "the feed is already attached to this file"; }
		}
		if (index < 0) { return "a video feed needs a video track"; }
		const std::string error = _checkVideo(index);
		if (!error.empty()) { return error; }
	}

	if (!FeedHub::setWriter(view.header->id, this, [this] () { _wake(); })) {
		return "the feed is already attached to another file";
	}

	std::unique_lock<std::mutex> lock(_mutex);
	_attachVideo(index, view, std::move(keep_alive), threads);
	*generation = _video(static_cast<uint32_t>(index))->videoFeed()->generation();
	return std::string();
}

void
FileCore::detach (uint64_t id)
{
	FeedLink *writer = nullptr;
	int index = -1;
	{
		std::unique_lock<std::mutex> lock(_mutex);
		if (!_opened || _closed) { return; }
		for (Track *track : _all) {
			FeedLink *attached = track->attachedLink();
			if (!attached || attached->id() != id) { continue; }
			writer = attached;
			index = track->index;
		}
	}
	if (writer) { _disable(index, writer); }
}
