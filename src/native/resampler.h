#ifndef _MEDIA_DECODERS_RESAMPLER_H_
#define _MEDIA_DECODERS_RESAMPLER_H_

#include "ffmpeg.h"

struct ResampleOptions {
	int filter_size = 192;
	int phase_shift = 16;
	double cutoff = 0.9;
	bool linear_interp = true;
};

class Resampler {
public:
	~Resampler () { reset(); }

	bool matches (const AVFrame *frame) const;
	int configure (const AVFrame *frame, int out_rate, int out_channels);
	void reset ();

	SwrContext *swr = nullptr;

private:
	int _in_rate = 0;
	int _in_format = -1;
	AVChannelLayout _in_layout = {};
};

#endif // _MEDIA_DECODERS_RESAMPLER_H_
