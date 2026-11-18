#ifndef _MEDIA_DECODERS_FEED_READER_H_
#define _MEDIA_DECODERS_FEED_READER_H_

#include <napi.h>
#include "feed.h"

bool feedFromValue (const Napi::Value &value, FeedView *view);

struct BlockInfo {
	double timestamp = 0;
	int64_t segment = -1;
	int64_t entry = -1;
};

class FeedReader : public Napi::ObjectWrap<FeedReader> {
public:
	static Napi::Function init (Napi::Env env);
	static void closeAll (Napi::Env env);

	FeedReader (const Napi::CallbackInfo &info);
	~FeedReader ();

private:
	Napi::Value read (const Napi::CallbackInfo &info);
	Napi::Value readBlock (const Napi::CallbackInfo &info);
	Napi::Value ready (const Napi::CallbackInfo &info);
	Napi::Value wait (const Napi::CallbackInfo &info);
	Napi::Value getChannels (const Napi::CallbackInfo &info);
	Napi::Value getEnded (const Napi::CallbackInfo &info);
	Napi::Value getSeeking (const Napi::CallbackInfo &info);
	Napi::Value getError (const Napi::CallbackInfo &info);
	Napi::Value close (const Napi::CallbackInfo &info);

	void _close ();
	double _skipToStart ();
	size_t _read (float **out, uint32_t plane_count, size_t stride, size_t frames, double rate, int64_t expected, bool span, BlockInfo *block);

	Napi::Env _env;
	FeedView _feed;
	FeedBlockRef _block;
	uint64_t _epoch = 0;
	Napi::Reference<Napi::Uint8Array> _ref;
	Napi::ThreadSafeFunction _tsfn;
	bool _open = false;
	bool _waiting = false;
	int _rate = 0;
	int _channels = 0;
};

Napi::Value initFeed (const Napi::CallbackInfo &info);
Napi::Value position (const Napi::CallbackInfo &info);

#endif // _MEDIA_DECODERS_FEED_READER_H_
