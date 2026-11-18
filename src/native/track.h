#ifndef _MEDIA_DECODERS_TRACK_H_
#define _MEDIA_DECODERS_TRACK_H_

#include "ffmpeg.h"
#include "keep-alive.h"
#include "codec.h"
#include <deque>
#include <mutex>
#include <string>

enum class TrackState {
	Idle,
	Decoding,
	Flushing,
	Drained,
	Ended,
	Failed,
};

enum class StepResult {
	Progress,
	NeedPackets,
	Blocked,
};

class FeedWriter;
class FeedLink;

struct TrackFailure {
	int code = 0;
	std::string message;
};

class TrackHost {
public:
	virtual void reportError (const std::string &message, bool fatal, int track) = 0;
	virtual void notify () = 0;
	virtual void retire (KeepAliveToken token) = 0;
	virtual bool videoEnabled () const = 0;
	virtual bool demuxEnded () const = 0;
	virtual bool fileFailed () const = 0;
	virtual const TrackFailure &fileFailure () const = 0;
	virtual int64_t currentSegment () const = 0;
	virtual double startTime () const = 0;
	virtual double duration () const = 0;
	virtual bool requestsPending () const = 0;

protected:
	~TrackHost () = default;
};

// Every method is called with the file's mutex held.
class Track {
public:
	Track (TrackHost &host, int index, AVStream *stream);
	virtual ~Track ();

	virtual FeedWriter *feed () { return nullptr; }
	virtual FeedLink *link () { return nullptr; }
	FeedWriter *attachedFeed ();
	FeedLink *attachedLink ();
	virtual bool demuxes () const { return true; }
	virtual bool enable (double segment_start);
	virtual void disable ();
	virtual void clear (bool keep_ready);
	virtual void restart (double time, bool keep_ready);
	virtual void queue (AVPacket *packet);
	virtual bool complete () { return drained(); }
	virtual bool hasRoom () { return false; }
	virtual StepResult step (std::unique_lock<std::mutex> &) { return StepResult::Blocked; }
	virtual bool canSeekForward (double, int64_t) { return false; }
	virtual void seekForward (double, int64_t) {}
	virtual void cutAfter (int64_t segment);
	void finish ();
	void fail (int code, const std::string &message);
	const TrackFailure &failure () const { return _failure.code != 0 ? _failure : _host.fileFailure(); }

	bool enabled () const { return _enabled; }
	bool drained () const { return state == TrackState::Drained || state == TrackState::Ended || state == TrackState::Failed; }
	virtual bool failed () const { return state == TrackState::Failed; }
	virtual bool ended () const { return state == TrackState::Ended || state == TrackState::Failed; }
	int64_t queuedBytes () const { return _queued_bytes; }

	const int index;
	AVStream *const stream;
	const AVMediaType type;
	TrackState state = TrackState::Idle;

protected:
	explicit Track (TrackHost &host);

	virtual void _configure (AVCodecContext *) {}
	virtual void _opened () {}
	StepResult _sendPacket (std::unique_lock<std::mutex> &lock);
	void _setDrained ();

	TrackHost &_host;
	bool _enabled = false;
	Codec _codec;
	int _threads = 0;
	int64_t _packets_sent = 0;
	std::deque<AVPacket *> _packets;
	int64_t _queued_bytes = 0;
	AVFrame *_stash = nullptr;
	bool _has_stash = false;

	double _segment_start = 0;
	bool _first_in_segment = true;
	TrackFailure _failure;
};

#endif // _MEDIA_DECODERS_TRACK_H_
