#ifndef _MEDIA_DECODERS_FFMPEG_H_
#define _MEDIA_DECODERS_FFMPEG_H_

extern "C" {
#include <libavformat/avformat.h>
#include <libavformat/avio.h>
#include <libavcodec/avcodec.h>
#include <libavutil/avutil.h>
#include <libavutil/imgutils.h>
#include <libavutil/pixdesc.h>
#include <libavutil/time.h>
#include <libavutil/opt.h>
#include <libavutil/channel_layout.h>
#include <libavutil/display.h>
#include <libswscale/swscale.h>
#include <libswresample/swresample.h>
}

#include <string>

inline std::string
averror (int code)
{
	char buffer[AV_ERROR_MAX_STRING_SIZE] = { 0 };
	av_strerror(code, buffer, sizeof(buffer));
	return std::string(buffer);
}

inline double
toSeconds (int64_t value, AVRational time_base)
{
	return static_cast<double>(value) * av_q2d(time_base);
}

#endif // _MEDIA_DECODERS_FFMPEG_H_
