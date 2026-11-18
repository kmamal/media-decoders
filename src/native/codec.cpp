#include "codec.h"


int
Codec::open (const AVCodecParameters *params, AVRational time_base, int threads, const std::function<void (AVCodecContext *)> &configure)
{
	close();
	const AVCodec *codec = avcodec_find_decoder(params->codec_id);
	if (!codec) { return AVERROR_DECODER_NOT_FOUND; }
	AVCodecContext *ctx = avcodec_alloc_context3(codec);
	if (!ctx) { return AVERROR(ENOMEM); }
	int error = avcodec_parameters_to_context(ctx, params);
	if (error >= 0) {
		ctx->pkt_timebase = time_base;
		ctx->thread_count = threads;
		ctx->thread_type = FF_THREAD_FRAME | FF_THREAD_SLICE;
		if (configure) { configure(ctx); }
		error = avcodec_open2(ctx, codec, nullptr);
	}
	if (error < 0) {
		avcodec_free_context(&ctx);
		return error;
	}
	_ctx = ctx;
	return 0;
}

void
Codec::close ()
{
	avcodec_free_context(&_ctx);
}

int
Codec::send (const AVPacket *packet)
{
	return avcodec_send_packet(_ctx, packet);
}

Received
Codec::receive (AVFrame *frame, int *error)
{
	const int result = avcodec_receive_frame(_ctx, frame);
	if (result >= 0) { return Received::Frame; }
	if (result == AVERROR(EAGAIN)) { return Received::NeedPacket; }
	if (result == AVERROR_EOF) { return Received::Drained; }
	if (error) { *error = result; }
	return Received::Error;
}

void
Codec::flush ()
{
	if (_ctx) { avcodec_flush_buffers(_ctx); }
}
