#ifndef _MEDIA_DECODERS_SILENT_TRACK_H_
#define _MEDIA_DECODERS_SILENT_TRACK_H_

#include "track.h"
#include "feed-writer.h"

class SilentTrack : public Track {
public:
	explicit SilentTrack (TrackHost &host) : Track(host) {}

	FeedWriter *feed () override { return &_writer; }
	FeedLink *link () override { return &_writer; }
	bool demuxes () const override { return false; }
	bool enable (double segment_start) override;
	void disable () override;
	void cutAfter (int64_t) override {}
	bool failed () const override { return _host.fileFailed(); }
	bool ended () const override { return _writer.finished() || failed(); }
	bool complete () override { return _writer.silenceRemaining() == 0; }
	bool hasRoom () override;
	StepResult step (std::unique_lock<std::mutex> &lock) override;

private:
	FeedWriter _writer;
};

#endif // _MEDIA_DECODERS_SILENT_TRACK_H_
