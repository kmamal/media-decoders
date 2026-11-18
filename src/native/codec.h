#ifndef _MEDIA_DECODERS_CODEC_H_
#define _MEDIA_DECODERS_CODEC_H_

#include "ffmpeg.h"
#include <functional>

enum class Received {
	Frame,
	NeedPacket,
	Drained,
	Error,
};

class Codec {
public:
	Codec () = default;
	Codec (const Codec &) = delete;
	Codec &operator= (const Codec &) = delete;
	~Codec () { close(); }

	int open (const AVCodecParameters *params, AVRational time_base, int threads, const std::function<void (AVCodecContext *)> &configure);
	void close ();
	bool opened () const { return _ctx != nullptr; }
	AVCodecContext *context () const { return _ctx; }

	int send (const AVPacket *packet);
	int drain () { return send(nullptr); }
	Received receive (AVFrame *frame, int *error);
	void flush ();

private:
	AVCodecContext *_ctx = nullptr;
};

#endif // _MEDIA_DECODERS_CODEC_H_
