#ifndef _MEDIA_DECODERS_MEDIA_INPUT_H_
#define _MEDIA_DECODERS_MEDIA_INPUT_H_

#include "ffmpeg.h"
#include "byte-source-state.h"
#include <vector>
#include <string>
#include <memory>

struct InputSource {
	std::string path;
	std::vector<uint8_t> bytes;
	std::shared_ptr<ByteSourceState> source;
};

class MediaInput {
public:
	~MediaInput () { close(); }

	int open (InputSource *input, const AVIOInterruptCB *interrupt);
	void close ();
	double startTime () const;
	int seek (double time);

	AVFormatContext *format = nullptr;

private:
	static int _read (void *opaque, uint8_t *buffer, int length);
	static int64_t _seek (void *opaque, int64_t offset, int whence);

	InputSource *_input = nullptr;
	AVIOContext *_avio = nullptr;
	int64_t _position = 0;
};

#endif // _MEDIA_DECODERS_MEDIA_INPUT_H_
