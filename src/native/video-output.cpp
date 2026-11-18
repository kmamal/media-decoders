#include "video-output.h"
#include <cmath>
#include <cstring>
#include <algorithm>

// Follows the ffmpeg command's autorotate rules: 90° steps and flips.
Orientation
Orientation::of (const AVCodecParameters *params)
{
	Orientation result;
	const AVPacketSideData *side = av_packet_side_data_get(params->coded_side_data, params->nb_coded_side_data, AV_PKT_DATA_DISPLAYMATRIX);
	if (!side || side->size < 9 * sizeof(int32_t)) { return result; }
	const int32_t *matrix = reinterpret_cast<const int32_t *>(side->data);
	double theta = -std::round(av_display_rotation_get(matrix));
	if (std::isnan(theta)) { return result; }
	theta -= 360 * std::floor(theta / 360 + 0.9 / 360);
	if (std::fabs(theta - 90) < 1) {
		result.swap = true;
		result.flip_y = matrix[3] <= 0;
	}
	else if (std::fabs(theta - 180) < 1) {
		result.flip_x = matrix[0] < 0;
		result.flip_y = matrix[4] < 0;
	}
	else if (std::fabs(theta - 270) < 1) {
		result.swap = true;
		result.flip_x = true;
		result.flip_y = matrix[3] < 0;
	}
	else if (std::fabs(theta) < 1) {
		result.flip_y = matrix[4] < 0;
	}
	return result;
}

int
Orientation::rotation () const
{
	if (!swap) { return flip_y ? 180 : 0; }
	return flip_y ? 90 : 270;
}

bool
Orientation::mirrored () const
{
	return swap != (flip_x != flip_y);
}

template <int bytes>
static void
_orientPlane (const uint8_t *src, int src_stride, int src_width, int src_height, uint8_t *dst, int dst_stride, int dst_width, int dst_height, const Orientation &o)
{
	const ptrdiff_t step_x = o.swap
		? (o.flip_y ? -src_stride : src_stride)
		: (o.flip_x ? -bytes : bytes);
	const ptrdiff_t step_y = o.swap
		? (o.flip_x ? -bytes : bytes)
		: (o.flip_y ? -src_stride : src_stride);
	const int x0 = o.flip_x ? src_width - 1 : 0;
	const int y0 = o.flip_y ? src_height - 1 : 0;
	const uint8_t *origin = src + static_cast<ptrdiff_t>(y0) * src_stride + static_cast<ptrdiff_t>(x0) * bytes;

	constexpr int TILE = 32;
	for (int ty = 0; ty < dst_height; ty += TILE) {
		const int ey = std::min(ty + TILE, dst_height);
		for (int tx = 0; tx < dst_width; tx += TILE) {
			const int ex = std::min(tx + TILE, dst_width);
			for (int y = ty; y < ey; y++) {
				const uint8_t *from = origin + y * step_y + tx * step_x;
				uint8_t *to = dst + static_cast<ptrdiff_t>(y) * dst_stride + static_cast<ptrdiff_t>(tx) * bytes;
				for (int x = tx; x < ex; x++) {
					memcpy(to, from, bytes);
					to += bytes;
					from += step_x;
				}
			}
		}
	}
}

// Untagged video counts as limited range, BT.601 below 720 lines and BT.709 from there.
AVColorSpace
defaultColorspace (AVColorSpace colorspace, int height)
{
	if (colorspace != AVCOL_SPC_UNSPECIFIED && colorspace != AVCOL_SPC_RESERVED) { return colorspace; }
	return height < 720 ? AVCOL_SPC_SMPTE170M : AVCOL_SPC_BT709;
}

AVColorRange
defaultRange (AVColorRange range)
{
	return range == AVCOL_RANGE_JPEG ? AVCOL_RANGE_JPEG : AVCOL_RANGE_MPEG;
}

const char *
matrixName (AVColorSpace colorspace)
{
	switch (colorspace) {
		case AVCOL_SPC_BT709: return "bt709";
		case AVCOL_SPC_BT2020_NCL:
		case AVCOL_SPC_BT2020_CL: return "bt2020";
		default: return "bt601";
	}
}

const char *
transferName (AVColorTransferCharacteristic transfer)
{
	switch (transfer) {
		case AVCOL_TRC_SMPTE2084: return "pq";
		case AVCOL_TRC_ARIB_STD_B67: return "hlg";
		default: return "sdr";
	}
}


bool
FrameLayout::make (const std::string &name, int width, int height, FrameLayout *layout)
{
	if (width <= 0 || height <= 0) { return false; }
	layout->width = width;
	layout->height = height;
	if (name == "rgba") {
		layout->format = AV_PIX_FMT_RGBA;
		layout->count = 1;
		layout->planes[0] = { 0, width * 4, width, height };
	}
	else if (name == "gray") {
		layout->format = AV_PIX_FMT_GRAY8;
		layout->count = 1;
		layout->planes[0] = { 0, width, width, height };
	}
	else if (name == "yuv420p") {
		layout->format = AV_PIX_FMT_YUV420P;
		layout->count = 3;
		const int chroma_width = (width + 1) / 2;
		const int chroma_height = (height + 1) / 2;
		const int luma_size = width * height;
		const int chroma_size = chroma_width * chroma_height;
		layout->planes[0] = { 0, width, width, height };
		layout->planes[1] = { luma_size, chroma_width, chroma_width, chroma_height };
		layout->planes[2] = { luma_size + chroma_size, chroma_width, chroma_width, chroma_height };
	}
	else {
		return false;
	}
	const PlaneLayout &last = layout->planes[layout->count - 1];
	layout->size = last.offset + last.stride * last.height;
	return true;
}

int
VideoOutput::convert (AVFrame *frame, const FrameLayout &layout, uint8_t *data, bool full_range, OutFrame *out)
{
	frame->colorspace = defaultColorspace(frame->colorspace, frame->height);
	frame->color_range = defaultRange(frame->color_range);

	const int format = layout.format == AV_PIX_FMT_GRAY8 ? AV_PIX_FMT_YUV420P : layout.format;
	const int width = orientation.swap ? layout.height : layout.width;
	const int height = orientation.swap ? layout.width : layout.height;
	if (scaled && (scaled->format != format || scaled->width != width || scaled->height != height)) { av_frame_free(&scaled); }
	if (!scaled) {
		scaled = av_frame_alloc();
		scaled->format = format;
		scaled->width = width;
		scaled->height = height;
		const int error = av_frame_get_buffer(scaled, 0);
		if (error < 0) {
			av_frame_free(&scaled);
			fillBlack(layout, data, full_range);
			return error;
		}
	}
	AVFrame *dst = scaled;
	if (layout.format == AV_PIX_FMT_RGBA) {
		dst->colorspace = AVCOL_SPC_RGB;
		dst->color_range = AVCOL_RANGE_JPEG;
	}
	else {
		dst->colorspace = frame->colorspace;
		dst->color_range = frame->color_range;
	}
	dst->color_primaries = frame->color_primaries;
	dst->color_trc = frame->color_trc;

	// libswscale scales into a frame that FFmpeg allocated and we copy out of it, because libswscale 9.0.2 skips the last columns or writes past the end of rgba buffers whose stride is not a multiple of 64 bytes.
	const int error = sws_scale_frame(sws, dst, frame);
	if (error < 0) { fillBlack(layout, data, full_range); }
	else {
		const int bytes = layout.format == AV_PIX_FMT_RGBA ? 4 : 1;
		for (int i = 0; i < layout.count; i++) {
			const PlaneLayout &to = layout.planes[i];
			if (orientation.identity()) {
				av_image_copy_plane(data + to.offset, to.stride, dst->data[i], dst->linesize[i], to.width * bytes, to.height);
				continue;
			}
			const int from_width = orientation.swap ? to.height : to.width;
			const int from_height = orientation.swap ? to.width : to.height;
			if (bytes == 4) {
				_orientPlane<4>(dst->data[i], dst->linesize[i], from_width, from_height, data + to.offset, to.stride, to.width, to.height, orientation);
			}
			else {
				_orientPlane<1>(dst->data[i], dst->linesize[i], from_width, from_height, data + to.offset, to.stride, to.width, to.height, orientation);
			}
		}
	}

	out->colorspace = frame->colorspace;
	out->range = frame->color_range;
	out->transfer = frame->color_trc;
	return error;
}

void
VideoOutput::fillBlack (const FrameLayout &layout, uint8_t *data, bool full_range)
{
	const uint8_t luma = full_range ? 0 : 16;

	if (layout.format == AV_PIX_FMT_RGBA) {
		for (int i = 0; i < layout.size; i += 4) {
			data[i] = 0;
			data[i + 1] = 0;
			data[i + 2] = 0;
			data[i + 3] = 255;
		}
		return;
	}

	const PlaneLayout &y = layout.planes[0];
	memset(data + y.offset, luma, static_cast<size_t>(y.stride) * y.height);
	for (int i = 1; i < layout.count; i++) {
		const PlaneLayout &plane = layout.planes[i];
		memset(data + plane.offset, 128, static_cast<size_t>(plane.stride) * plane.height);
	}
}

