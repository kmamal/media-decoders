#ifndef _MEDIA_DECODERS_FILE_CORE_H_
#define _MEDIA_DECODERS_FILE_CORE_H_

#include "ffmpeg.h"
#include "keep-alive.h"
#include "media-input.h"
#include "feed.h"
#include "feed-writer.h"
#include "video-track.h"
#include "video-feed.h"
#include "audio-track.h"
#include "silent-track.h"
#include <deque>
#include <map>
#include <optional>
#include <vector>
#include <mutex>
#include <thread>
#include <memory>
#include <string>
#include <functional>
#include <condition_variable>
#include <cstdarg>

struct ErrorEvent {
	std::string message;
	bool fatal;
	int track;
};

struct FileEvents {
	bool opened = false;
	std::string open_error;
	std::vector<ErrorEvent> errors;
};

struct TrackInfo {
	AVMediaType type = AVMEDIA_TYPE_UNKNOWN;
	std::string codec;
	bool decodable = false;
	double start_time = 0;
	double duration = -1;

	int width = 0;
	int height = 0;
	int display_width = 0;
	int display_height = 0;
	int rotation = 0;
	bool flip = false;
	double frame_rate = -1;
	const char *matrix = nullptr;
	bool full_range = false;
	const char *transfer = nullptr;

	int sample_rate = 0;
	int channels = 0;
	double seek_preroll = -1;
};

struct FileInfo {
	double duration = 0;
	double start_time = 0;
	std::string format;
	std::vector<TrackInfo> tracks;
};

struct SeekRequest {
	double time;
	int64_t segment;
};

struct TrackRequest {
	bool reader = false;
	uint64_t generation = 0;
	uint64_t applied = 0;
	double resume_time = -1;
	int threads = 0;
};

struct Requested {
	std::vector<TrackRequest> tracks;
	std::optional<SeekRequest> seek;
	std::optional<bool> loop;
	bool changed = false;
};

class FileCore : private TrackHost {
public:
	static void captureLogs ();

	FileCore (InputSource &&source, double max_queued_bytes, std::function<void ()> notify);
	~FileCore ();

	uint64_t id () const { return _id; }
	FileEvents takeEvents ();
	FileInfo info ();
	void disableTrack (uint32_t index);
	int64_t seek (double time);
	int64_t lastSegment ();
	void setLoop (bool loop);
	std::string attach (int index, const FeedView &view, KeepAliveToken keep_alive, int64_t *generation);
	std::string attachVideo (int index, const VideoFeedView &view, KeepAliveToken keep_alive, int threads, int64_t *generation);
	void detach (uint64_t id);
	void close ();

private:
	void reportError (const std::string &message, bool fatal, int track) override;
	void notify () override;
	void retire (KeepAliveToken token) override;
	bool videoEnabled () const override;
	bool demuxEnded () const override { return _demux_eof; }
	bool fileFailed () const override { return _failed; }
	const TrackFailure &fileFailure () const override { return _failure; }
	int64_t currentSegment () const override { return _segment; }
	double startTime () const override { return _start_time; }
	double duration () const override { return _duration; }
	bool requestsPending () const override { return _requested.changed; }

	void _collectLogErrors ();
	std::string _readError (int error);
	static int _interrupt (void *opaque);
	static void _log (void *avcl, int level, const char *fmt, va_list args);

	void _run ();
	bool _open ();
	FileInfo _readInfo ();
	Track &_track (int index);
	VideoTrack *_video (uint32_t index);
	void _disable (int index, FeedLink *writer);
	std::string _checkVideo (int index);
	void _attachVideo (int index, const VideoFeedView &view, KeepAliveToken keep_alive, int threads);
	TrackRequest &_request (int index);
	void _requestChanged ();
	void _reconcile (std::unique_lock<std::mutex> &lock);
	double _currentTime ();
	void _applySeek (const SeekRequest &request, std::unique_lock<std::mutex> &lock);
	bool _canSeekForward (double time);
	void _realSeek (double time, std::unique_lock<std::mutex> &lock);
	void _resetFeeds (double time, bool drop);
	void _wrap (std::unique_lock<std::mutex> &lock);
	bool _queuesFull ();

	void _wake ();
	void _flushReaderNotify (std::unique_lock<std::mutex> &lock);
	bool _checkReader (std::unique_lock<std::mutex> &lock);
	void _applyLoopChange ();
	void _publishRequest ();

	const uint64_t _id;
	std::mutex _mutex;
	std::mutex _wake_mutex;
	std::condition_variable _wake_cond;
	bool _woken = false;
	std::thread _thread;
	std::function<void ()> _notify;

	InputSource _source;
	MediaInput _input;
	FileInfo _info;
	AVPacket *_packet = nullptr;

	std::vector<std::unique_ptr<Track>> _tracks;
	std::vector<Track *> _all;
	double _start_time = 0;
	double _duration = 0;
	double _max_queued_bytes;

	bool _closing = false;
	bool _closed = false;
	bool _opened = false;
	bool _open_reported = false;
	std::string _open_error;
	std::deque<ErrorEvent> _errors;
	std::vector<std::string> _log_errors;
	bool _failed = false;
	TrackFailure _failure;
	int64_t _request_serial = 0;
	int64_t _seek_serial = 0;
	int64_t _applied_serial = 0;
	bool _notify_pending = false;
	bool _demux_eof = false;
	bool _loop = false;
	Requested _requested;
	int64_t _segment = 0;
	int64_t _next_segment = 0;
	double _segment_start = 0;
	double _demuxed_time = 0;
	bool _demuxed = false;
	double _resume_time = -1;
	std::vector<KeepAliveToken> _dead;

	SilentTrack _silent;
};

#endif // _MEDIA_DECODERS_FILE_CORE_H_
