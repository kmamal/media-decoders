#include "media-input.h"
#include <algorithm>
#include <cstring>
#include <cmath>


static constexpr int AVIO_BUFFER_SIZE = 64 * 1024;


int
MediaInput::_read (void *opaque, uint8_t *buffer, int length)
{
	MediaInput *self = static_cast<MediaInput *>(opaque);
	InputSource *input = self->_input;
	if (input->source) { return input->source->read(buffer, length); }
	const int64_t left = static_cast<int64_t>(input->bytes.size()) - self->_position;
	if (left <= 0) { return AVERROR_EOF; }
	const int count = static_cast<int>(std::min<int64_t>(left, length));
	memcpy(buffer, input->bytes.data() + self->_position, count);
	self->_position += count;
	return count;
}

int64_t
MediaInput::_seek (void *opaque, int64_t offset, int whence)
{
	MediaInput *self = static_cast<MediaInput *>(opaque);
	InputSource *input = self->_input;
	if (input->source) { return input->source->seek(offset, whence); }
	const int64_t size = static_cast<int64_t>(input->bytes.size());
	switch (whence & ~AVSEEK_FORCE) {
		case AVSEEK_SIZE: return size;
		case SEEK_SET: self->_position = offset; break;
		case SEEK_CUR: self->_position += offset; break;
		case SEEK_END: self->_position = size + offset; break;
		default: return AVERROR(EINVAL);
	}
	return self->_position;
}

int
MediaInput::open (InputSource *input, const AVIOInterruptCB *interrupt)
{
	_input = input;
	_position = 0;
	format = avformat_alloc_context();
	if (interrupt) { format->interrupt_callback = *interrupt; }

	std::string url;
	if (input->path.empty()) {
		uint8_t *buffer = static_cast<uint8_t *>(av_malloc(AVIO_BUFFER_SIZE));
		_avio = avio_alloc_context(buffer, AVIO_BUFFER_SIZE, 0, this, _read, nullptr, _seek);
		format->pb = _avio;
		format->flags |= AVFMT_FLAG_CUSTOM_IO;
	}
	else {
		url = "file:" + input->path;
	}

	const int error = avformat_open_input(&format, url.empty() ? nullptr : url.c_str(), nullptr, nullptr);
	if (error < 0) { return error; }
	return avformat_find_stream_info(format, nullptr);
}

void
MediaInput::close ()
{
	avformat_close_input(&format);
	if (_avio) {
		av_freep(&_avio->buffer);
		avio_context_free(&_avio);
	}
}

double
MediaInput::startTime () const
{
	if (format->start_time == AV_NOPTS_VALUE) { return 0; }
	return std::max(0.0, static_cast<double>(format->start_time) / AV_TIME_BASE);
}

int
MediaInput::seek (double time)
{
	const int64_t target = static_cast<int64_t>(std::llround((time + startTime()) * AV_TIME_BASE));
	const int error = avformat_seek_file(format, -1, INT64_MIN, target, target, 0);
	if (error >= 0) { return error; }
	return av_seek_frame(format, -1, target, AVSEEK_FLAG_BACKWARD);
}
