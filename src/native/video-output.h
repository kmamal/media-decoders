#ifndef _MEDIA_DECODERS_VIDEO_OUTPUT_H_
#define _MEDIA_DECODERS_VIDEO_OUTPUT_H_

#include "ffmpeg.h"
#include <deque>
#include <vector>
#include <string>

struct OutFrame {
	int buffer = -1;
	int64_t number = 0;
	double timestamp = 0;
	double duration = 0;
	int64_t segment = 0;
	uint64_t file = 0;
	int display_width = 0;
	int display_height = 0;
	AVColorSpace colorspace = AVCOL_SPC_UNSPECIFIED;
	AVColorRange range = AVCOL_RANGE_UNSPECIFIED;
	AVColorTransferCharacteristic transfer = AVCOL_TRC_UNSPECIFIED;
};

struct PlaneLayout {
	int offset;
	int stride;
	int width;
	int height;
};

struct FrameLayout {
	AVPixelFormat format = AV_PIX_FMT_NONE;
	int width = 0;
	int height = 0;
	int size = 0;
	int count = 0;
	PlaneLayout planes[3];

	static bool make (const std::string &name, int width, int height, FrameLayout *layout);
};

struct Orientation {
	bool swap = false;
	bool flip_x = false;
	bool flip_y = false;

	bool identity () const { return !swap && !flip_x && !flip_y; }
	int rotation () const;
	bool mirrored () const;

	static Orientation of (const AVCodecParameters *params);
};

AVColorSpace defaultColorspace (AVColorSpace colorspace, int height);
AVColorRange defaultRange (AVColorRange range);
const char *matrixName (AVColorSpace colorspace);
const char *transferName (AVColorTransferCharacteristic transfer);

class VideoOutput {
public:
	int convert (AVFrame *frame, const FrameLayout &layout, uint8_t *data, bool full_range, OutFrame *out);
	static void fillBlack (const FrameLayout &layout, uint8_t *data, bool full_range);

	Orientation orientation;
	SwsContext *sws = nullptr;
	AVFrame *scaled = nullptr;
};

#endif // _MEDIA_DECODERS_VIDEO_OUTPUT_H_
