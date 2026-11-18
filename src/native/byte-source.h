#ifndef _MEDIA_DECODERS_BYTE_SOURCE_H_
#define _MEDIA_DECODERS_BYTE_SOURCE_H_

#include <napi.h>
#include "media-input.h"
#include <memory>

class ByteSource : public Napi::ObjectWrap<ByteSource> {
public:
	static Napi::Function init (Napi::Env env);
	static void closeAll (Napi::Env env);

	ByteSource (const Napi::CallbackInfo &info);
	~ByteSource ();

	std::shared_ptr<ByteSourceState> state;

private:
	Napi::Env _env;

	Napi::Value push (const Napi::CallbackInfo &info);
	Napi::Value end (const Napi::CallbackInfo &info);
	Napi::Value fail (const Napi::CallbackInfo &info);
	Napi::Value setSize (const Napi::CallbackInfo &info);
	Napi::Value size (const Napi::CallbackInfo &info);
	Napi::Value restart (const Napi::CallbackInfo &info);
	Napi::Value takeEvents (const Napi::CallbackInfo &info);
	Napi::Value bufferedRanges (const Napi::CallbackInfo &info);
	Napi::Value close (const Napi::CallbackInfo &info);
};

InputSource inputSourceFrom (Napi::Value value);

#endif // _MEDIA_DECODERS_BYTE_SOURCE_H_
