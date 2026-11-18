#ifndef _MEDIA_DECODERS_AUDIO_PIPELINE_H_
#define _MEDIA_DECODERS_AUDIO_PIPELINE_H_

#include "audio-trim.h"
#include "resampler.h"
#include <functional>
#include <vector>

class AudioPipeline {
public:
	static double preroll (const AVStream *stream);

	void open (AVCodecContext *ctx, const AVStream *stream, double start_time);
	void notePacket (const AVPacket *packet) { _trim.notePacket(packet); }
	void clear ();
	void restart (double time);

	bool push (const AVFrame *frame, int out_rate, int out_channels);
	int flush ();
	bool needsFlush () const { return _resampler.swr && !_flushed; }

	int channels () const { return _channels; }
	int64_t pending () const { return _count; }
	const float *plane (int channel) const { return _planes[channel].data() + _offset; }
	void consume (int64_t count);

	double nextTime () const { return _next_time; }
	int64_t inputSamples () const { return _input_samples; }

	std::function<void (int)> onError;

private:
	void _resetOutput ();
	int _setup (const AVFrame *frame, int out_rate, int out_channels);
	int _convert (const uint8_t **input, int count);
	void _report (int error) { if (onError) { onError(error); } }

	AudioTrim _trim;
	Resampler _resampler;
	bool _flushed = false;
	int _channels = 0;
	double _next_time = 0;
	double _from = 0;
	bool _first = true;
	int64_t _input_samples = 0;
	std::vector<std::vector<float>> _planes;
	int64_t _offset = 0;
	int64_t _count = 0;
};

#endif // _MEDIA_DECODERS_AUDIO_PIPELINE_H_
