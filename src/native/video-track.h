#ifndef _MEDIA_DECODERS_VIDEO_TRACK_H_
#define _MEDIA_DECODERS_VIDEO_TRACK_H_

#include "track.h"
#include "video-output.h"
#include "video-feed-writer.h"

class VideoTrack : public Track {
public:
	VideoTrack (TrackHost &host, int index, AVStream *stream, AVFormatContext *format);
	~VideoTrack () override;

	FeedLink *link () override { return &_writer; }
	VideoFeedWriter *videoFeed () { return &_writer; }
	void setThreads (int threads) { _threads = threads; }
	void disable () override;
	void clear (bool keep_ready) override;
	bool complete () override { return drained() && !_has_pending; }
	bool hasRoom () override { return _writer.hasFree(); }
	StepResult step (std::unique_lock<std::mutex> &lock) override;
	bool canSeekForward (double time, int64_t segment) override;
	void seekForward (double time, int64_t segment) override;
	void cutAfter (int64_t segment) override;

	const Orientation &orientation () const { return _output.orientation; }
	double nextTime ();
	bool takeReaderChange (double *time);

private:
	void _opened () override;
	void _prune ();
	StepResult _handleFrame (std::unique_lock<std::mutex> &lock);
	bool _finishPending (double next_timestamp, std::unique_lock<std::mutex> &lock);
	bool _finishLast (std::unique_lock<std::mutex> &lock);
	void _pushReady (int slot, const OutFrame &frame);

	AVFormatContext *_format;
	VideoOutput _output;
	VideoFeedWriter _writer;
	std::deque<OutFrame> _ready;
	AVFrame *_pending_frame = nullptr;
	bool _has_pending = false;
	OutFrame _pending;
	double _converting = -1;
	double _pending_fallback_duration = 0;
	double _last_decoded = -1;
	double _last_duration = 0;
};

#endif // _MEDIA_DECODERS_VIDEO_TRACK_H_
