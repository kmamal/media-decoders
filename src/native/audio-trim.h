#ifndef _MEDIA_DECODERS_AUDIO_TRIM_H_
#define _MEDIA_DECODERS_AUDIO_TRIM_H_

#include "ffmpeg.h"
#include <vector>

struct TrimmedFrame {
	int skip = 0;
	int count = 0;
	double time = 0;
};

class AudioTrim {
public:
	void open (AVCodecContext *ctx, const AVStream *stream, double start_time);
	void reset ();
	void notePacket (const AVPacket *packet);
	TrimmedFrame trim (const AVFrame *frame, double fallback_time, double from);

	static int silenceBefore (double time, double next_time, bool first, int rate);
	static std::vector<const uint8_t *> planes (const AVFrame *frame, int skip);

private:
	bool _manual_skip = false;
	AVRational _time_base = { 0, 1 };
	double _start_time = 0;
	int64_t _end_pts = AV_NOPTS_VALUE;
};

#endif // _MEDIA_DECODERS_AUDIO_TRIM_H_
