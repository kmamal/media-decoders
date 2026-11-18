#ifndef _MEDIA_DECODERS_FEED_WRITER_H_
#define _MEDIA_DECODERS_FEED_WRITER_H_

#include "feed.h"
#include "feed-link.h"
#include "keep-alive.h"
#include <string>

// Every method is called with the file's mutex held.
class FeedWriter : public FeedLink {
public:
	void attach (const FeedView &view, KeepAliveToken keep_alive, uint64_t file, bool silent, double time, int64_t segment, double duration);
	bool detach (bool owned) override;
	void reset (double time, int64_t segment, bool drop, double duration) override;
	bool cutAtLoop (int64_t *segment);
	void resumeLoop ();
	void reopen () override;
	void request (int64_t serial, int64_t seek_serial) override;
	void applied (int64_t serial) override;
	void finish () override;
	bool finishFailed (int code, const std::string &message) override;
	bool takeReaderChange ();
	bool takeReaderNotify () override;
	void armWaiting () override;

	bool attached () const override { return _attached; }
	bool finished () const override { return _finished; }
	bool hasEntry () const { return _has_entry; }
	uint64_t id () const override { return _id; }
	int64_t generation () const { return _generation; }
	int rate () const { return _ring_rate; }
	int64_t capacity () const { return _block ? _block->capacity : 0; }
	int outputChannels (int source) const;
	int channels () const { return _channels; }

	bool active ();
	int64_t freeFrames ();
	double consumedTime (double fallback);
	void setChannels (int count, int64_t segment);
	int64_t write (const float *const *source, int64_t count);
	void silenceUntil (double time) { _silence_until = time; }
	int64_t silenceRemaining ();
	int64_t writeSilence ();

private:
	double _writtenTime ();
	int _silentChannels () const { return _block && _block->fixed ? _block->channels : 1; }
	void _publishEnd (int64_t index);
	void _storeEntry (int64_t write);
	void _entryStored (int64_t write);
	bool _logFull ();

	FeedView _feed;
	KeepAliveToken _keep_alive;
	FeedBlockRef _block;
	uint64_t _epoch = 0;
	uint64_t _id = 0;
	uint64_t _file = 0;
	int64_t _generation = -1;
	bool _attached = false;
	bool _silent = false;
	bool _finished = false;
	bool _failure_written = false;
	bool _loop_ended = false;
	int64_t _loop_boundary = -1;
	int _ring_rate = 0;
	int _channels = 0;
	bool _notify_reader = false;

	bool _has_entry = false;
	bool _entry_pending = false;
	double _entry_pending_time = 0;
	int64_t _entry_segment = 0;
	int64_t _entry_index = 0;
	double _entry_time = 0;
	double _silence_until = -1;
};

#endif // _MEDIA_DECODERS_FEED_WRITER_H_
