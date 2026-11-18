#ifndef _MEDIA_DECODERS_AUDIO_TRACK_H_
#define _MEDIA_DECODERS_AUDIO_TRACK_H_

#include "track.h"
#include "audio-pipeline.h"
#include "feed-writer.h"
#include <vector>

class AudioTrack : public Track {
public:
	AudioTrack (TrackHost &host, int index, AVStream *stream);

	FeedWriter *feed () override { return &_writer; }
	FeedLink *link () override { return &_writer; }
	void clear (bool keep_ready) override;
	void restart (double time, bool keep_ready) override;
	void queue (AVPacket *packet) override;
	bool complete () override;
	bool hasRoom () override;
	StepResult step (std::unique_lock<std::mutex> &lock) override;
	bool canSeekForward (double time, int64_t segment) override;
	void seekForward (double time, int64_t segment) override;

private:
	void _configure (AVCodecContext *ctx) override;
	void _handleFrame ();
	int64_t _writePending ();

	FeedWriter _writer;
	AudioPipeline _pipeline;
	std::vector<const float *> _sources;
	double _audio_end = -1;
};

#endif // _MEDIA_DECODERS_AUDIO_TRACK_H_
