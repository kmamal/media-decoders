#ifndef _MEDIA_DECODERS_VIDEO_FEED_READER_H_
#define _MEDIA_DECODERS_VIDEO_FEED_READER_H_

#include <napi.h>
#include "video-feed.h"
#include <vector>

bool videoFeedFromValue (const Napi::Value &value, VideoFeedView *view);
Napi::Value initVideoFeed (const Napi::CallbackInfo &info);

struct VideoFeedState {
	bool attached = false;
	uint64_t file = 0;
	int64_t segment = -1;
	bool ended = false;
	int64_t end_segment = -1;
	double end_time = 0;
};

class VideoFeedReader : public Napi::ObjectWrap<VideoFeedReader> {
public:
	static Napi::Function init (Napi::Env env);
	static void closeAll (Napi::Env env);

	VideoFeedReader (const Napi::CallbackInfo &info);
	~VideoFeedReader ();

private:
	Napi::Value next (const Napi::CallbackInfo &info);
	Napi::Value at (const Napi::CallbackInfo &info);
	Napi::Value release (const Napi::CallbackInfo &info);
	Napi::Value ready (const Napi::CallbackInfo &info);
	Napi::Value wait (const Napi::CallbackInfo &info);
	Napi::Value getEnded (const Napi::CallbackInfo &info);
	Napi::Value getAttached (const Napi::CallbackInfo &info);
	Napi::Value getSeeking (const Napi::CallbackInfo &info);
	Napi::Value getError (const Napi::CallbackInfo &info);
	Napi::Value close (const Napi::CallbackInfo &info);

	void _close ();
	bool _setMode (Napi::Env env, ReadMode mode);
	VideoFeedState _state ();
	bool _ended (const VideoFeedState &state);
	void _wakeWriter ();
	Napi::Object _frame (Napi::Env env, int slot);

	Napi::Env _env;
	VideoFeedView _feed;
	VideoBlockRef _block;
	Napi::Reference<Napi::Uint8Array> _ref;
	std::vector<Napi::Reference<Napi::Uint8Array>> _buffers;
	std::vector<bool> _leased;
	Napi::ThreadSafeFunction _tsfn;
	bool _open = false;
	bool _waiting = false;
	ReadMode _mode = ReadMode::None;
	int _current = -1;
};

#endif // _MEDIA_DECODERS_VIDEO_FEED_READER_H_
