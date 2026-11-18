#include "audio-trim.h"
#include "time-epsilon.h"
#include <libavutil/intreadwrite.h>
#include <cmath>
#include <algorithm>


void
AudioTrim::open (AVCodecContext *ctx, const AVStream *stream, double start_time)
{
	_manual_skip = stream->codecpar->codec_id == AV_CODEC_ID_VORBIS;
	if (_manual_skip) { ctx->flags2 |= AV_CODEC_FLAG2_SKIP_MANUAL; }
	_time_base = stream->time_base;
	_start_time = start_time;
	reset();
}

void
AudioTrim::reset ()
{
	_end_pts = AV_NOPTS_VALUE;
}

void
AudioTrim::notePacket (const AVPacket *packet)
{
	if (!_manual_skip || packet->pts == AV_NOPTS_VALUE) { return; }
	const int64_t end = packet->pts + packet->duration;
	if (_end_pts == AV_NOPTS_VALUE || end > _end_pts) { _end_pts = end; }
}

TrimmedFrame
AudioTrim::trim (const AVFrame *frame, double fallback_time, double from)
{
	const double rate = frame->sample_rate;
	const bool timed = frame->best_effort_timestamp != AV_NOPTS_VALUE;
	TrimmedFrame result;
	if (_manual_skip) {
		const AVFrameSideData *side = av_frame_get_side_data(frame, AV_FRAME_DATA_SKIP_SAMPLES);
		if (side && side->size >= 4) { result.skip = std::min(static_cast<int>(AV_RL32(side->data)), frame->nb_samples); }
	}
	result.time = timed ? toSeconds(frame->best_effort_timestamp, _time_base) - _start_time : fallback_time;
	result.count = frame->nb_samples - result.skip;
	if (timed) { result.time += result.skip / rate; }

	if (_manual_skip && _end_pts != AV_NOPTS_VALUE) {
		const double end = toSeconds(_end_pts, _time_base) - _start_time;
		const int64_t limit = std::llround((end - result.time) * rate);
		result.count = static_cast<int>(std::clamp<int64_t>(limit, 0, result.count));
	}
	if (result.count > 0 && result.time < from - TIME_EPSILON) {
		const int drop = static_cast<int>(std::min<int64_t>(result.count, std::llround((from - result.time) * rate)));
		result.skip += drop;
		result.count -= drop;
		result.time += drop / rate;
	}
	return result;
}

int
AudioTrim::silenceBefore (double time, double next_time, bool first, int rate)
{
	const double gap = time - next_time;
	const double threshold = first ? 0.5 / rate : 0.02;
	if (gap <= threshold) { return 0; }
	return static_cast<int>(std::llround(gap * rate));
}

std::vector<const uint8_t *>
AudioTrim::planes (const AVFrame *frame, int skip)
{
	const AVSampleFormat format = static_cast<AVSampleFormat>(frame->format);
	const int bytes = av_get_bytes_per_sample(format);
	const int channel_count = frame->ch_layout.nb_channels;
	const bool planar = av_sample_fmt_is_planar(format);
	std::vector<const uint8_t *> result(planar ? channel_count : 1);
	for (size_t i = 0; i < result.size(); i++) {
		result[i] = frame->extended_data[i] + static_cast<size_t>(skip) * bytes * (planar ? 1 : channel_count);
	}
	return result;
}
