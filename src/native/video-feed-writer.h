#ifndef _MEDIA_DECODERS_VIDEO_FEED_WRITER_H_
#define _MEDIA_DECODERS_VIDEO_FEED_WRITER_H_

#include "video-feed.h"
#include "feed-link.h"
#include "keep-alive.h"

class VideoFeedWriter : public FeedLink {
public:
	void attach (const VideoFeedView &view, KeepAliveToken keep_alive, uint64_t file, int64_t segment, int display_width, int display_height);
	bool detach (bool owned) override;
	void reset (double time, int64_t segment, bool drop, double duration) override;
	void reopen () override;
	void request (int64_t serial, int64_t seek_serial) override;
	void applied (int64_t serial) override;
	void finish () override;
	bool finishFailed (int code, const std::string &message) override;
	bool takeReaderNotify () override;
	void armWaiting () override;

	bool attached () const override { return _attached; }
	bool finished () const override { return _finished; }
	uint64_t id () const override { return _id; }
	int64_t generation () const { return _generation; }
	const VideoBlockRef &block () const { return _block; }

	bool readerChanged ();
	bool takeReaderChange ();
	bool hasFree ();
	int acquire ();
	void publish (int slot, OutFrame &frame);
	bool isReady (const OutFrame &frame) const;
	void takeBack (const OutFrame &frame);
	bool relabel (const OutFrame &frame, int64_t segment);
	bool behindReader (int64_t segment, double end);
	void noteEnd (int64_t segment, double end);
	void cutAfter (int64_t segment);

private:
	bool _active ();
	uint64_t _readerEpoch ();
	void _wakeReader ();

	VideoFeedView _feed;
	KeepAliveToken _keep_alive;
	VideoBlockRef _block;
	uint64_t _epoch = 0;
	uint64_t _id = 0;
	uint64_t _file = 0;
	int64_t _generation = -1;
	int _display_width = 0;
	int _display_height = 0;
	bool _attached = false;
	bool _finished = false;
	bool _failure_written = false;
	bool _notify_reader = false;
	int64_t _number = 0;
	int64_t _end_segment = -1;
	double _end_time = 0;
	int64_t _previous_end_segment = -1;
	double _previous_end_time = 0;
};

#endif // _MEDIA_DECODERS_VIDEO_FEED_WRITER_H_
