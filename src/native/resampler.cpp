#include "resampler.h"


bool
Resampler::matches (const AVFrame *frame) const
{
	return swr
		&& frame->sample_rate == _in_rate
		&& frame->format == _in_format
		&& av_channel_layout_compare(&frame->ch_layout, &_in_layout) == 0;
}

int
Resampler::configure (const AVFrame *frame, int out_rate, int out_channels)
{
	reset();

	AVChannelLayout out_layout = {};
	av_channel_layout_default(&out_layout, out_channels);
	AVChannelLayout in_layout = {};
	av_channel_layout_copy(&in_layout, &frame->ch_layout);
	if (in_layout.order == AV_CHANNEL_ORDER_UNSPEC) { av_channel_layout_default(&in_layout, in_layout.nb_channels); }

	int result = swr_alloc_set_opts2(&swr,
		&out_layout, AV_SAMPLE_FMT_FLTP, out_rate,
		&in_layout, static_cast<AVSampleFormat>(frame->format), frame->sample_rate,
		0, nullptr);
	av_channel_layout_uninit(&out_layout);
	av_channel_layout_uninit(&in_layout);
	if (result >= 0) {
		const ResampleOptions options;
		av_opt_set_int(swr, "filter_size", options.filter_size, 0);
		av_opt_set_int(swr, "phase_shift", options.phase_shift, 0);
		av_opt_set_double(swr, "cutoff", options.cutoff, 0);
		av_opt_set_int(swr, "linear_interp", options.linear_interp ? 1 : 0, 0);
		av_opt_set_int(swr, "exact_rational", 1, 0);
		result = swr_init(swr);
	}
	if (result < 0) {
		swr_free(&swr);
		return result;
	}

	_in_rate = frame->sample_rate;
	_in_format = frame->format;
	av_channel_layout_copy(&_in_layout, &frame->ch_layout);
	return 0;
}

void
Resampler::reset ()
{
	swr_free(&swr);
	_in_rate = 0;
	_in_format = -1;
	av_channel_layout_uninit(&_in_layout);
}
