#include "audio-pipeline.h"
#include <algorithm>


static constexpr double MIN_PREROLL = 0.1;


double
AudioPipeline::preroll (const AVStream *stream)
{
	const AVCodecParameters *params = stream->codecpar;
	if (params->sample_rate <= 0) { return MIN_PREROLL; }
	return std::max(MIN_PREROLL, static_cast<double>(params->seek_preroll) / params->sample_rate);
}

void
AudioPipeline::open (AVCodecContext *ctx, const AVStream *stream, double start_time)
{
	_trim.open(ctx, stream, start_time);
	restart(0);
}

void
AudioPipeline::_resetOutput ()
{
	_offset = 0;
	_count = 0;
	_resampler.reset();
	_flushed = false;
	_channels = 0;
}

void
AudioPipeline::clear ()
{
	_trim.reset();
	_resetOutput();
	_first = true;
}

void
AudioPipeline::restart (double time)
{
	_resetOutput();
	_next_time = time;
	_from = time;
	_first = true;
	_input_samples = 0;
}

bool
AudioPipeline::push (const AVFrame *frame, int out_rate, int out_channels)
{
	if (_resampler.swr && !_resampler.matches(frame)) {
		if (!_flushed) {
			const int error = flush();
			if (error < 0) { _report(error); }
		}
		if (_count > 0) { return false; }
		_resampler.reset();
		_channels = 0;
	}
	if (!_resampler.swr) {
		const int error = _setup(frame, out_rate, out_channels);
		if (error < 0) {
			_report(error);
			return true;
		}
	}

	const double in_rate = frame->sample_rate;
	const TrimmedFrame part = _trim.trim(frame, _next_time, _from);
	if (part.count > 0) {
		const int silence = AudioTrim::silenceBefore(part.time, _next_time, _first, frame->sample_rate);
		if (silence > 0) {
			swr_inject_silence(_resampler.swr, silence);
			_input_samples += silence;
		}
		_first = false;

		std::vector<const uint8_t *> planes = AudioTrim::planes(frame, part.skip);
		const int produced = _convert(planes.data(), part.count);
		if (produced < 0) { _report(produced); }
		_input_samples += part.count;
		_next_time = std::max(_next_time, part.time + part.count / in_rate);
	}
	return true;
}

int
AudioPipeline::_setup (const AVFrame *frame, int out_rate, int out_channels)
{
	if (out_channels <= 0) { return AVERROR(EINVAL); }
	const int result = _resampler.configure(frame, out_rate, out_channels);
	if (result < 0) { return result; }
	_flushed = false;
	_channels = out_channels;
	if (_planes.size() < static_cast<size_t>(out_channels)) { _planes.resize(static_cast<size_t>(out_channels)); }
	return 0;
}

int
AudioPipeline::_convert (const uint8_t **input, int count)
{
	const int capacity = swr_get_out_samples(_resampler.swr, count);
	if (capacity <= 0) { return capacity; }
	const int64_t end = _offset + _count;
	std::vector<uint8_t *> out(static_cast<size_t>(_channels));
	for (int c = 0; c < _channels; c++) {
		std::vector<float> &plane = _planes[c];
		if (plane.size() < static_cast<size_t>(end + capacity)) { plane.resize(static_cast<size_t>(end + capacity)); }
		out[c] = reinterpret_cast<uint8_t *>(plane.data() + end);
	}
	const int produced = swr_convert(_resampler.swr, out.data(), capacity, input, count);
	if (produced > 0) { _count += produced; }
	return produced;
}

int
AudioPipeline::flush ()
{
	_flushed = true;
	if (!_resampler.swr) { return 0; }
	for (;;) {
		const int produced = _convert(nullptr, 0);
		if (produced <= 0) { return produced; }
	}
}

void
AudioPipeline::consume (int64_t count)
{
	_offset += count;
	_count -= count;
	if (_count == 0) { _offset = 0; }
}
