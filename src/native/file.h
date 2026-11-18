#ifndef _MEDIA_DECODERS_FILE_H_
#define _MEDIA_DECODERS_FILE_H_

#include <napi.h>
#include "file-core.h"
#include <memory>

class File : public Napi::ObjectWrap<File> {
public:
	static Napi::Function init (Napi::Env env);
	static void closeAll (Napi::Env env);
	static void captureLogs () { FileCore::captureLogs(); }

	File (const Napi::CallbackInfo &info);
	~File ();

private:
	Napi::Value getId (const Napi::CallbackInfo &info);
	Napi::Value takeEvents (const Napi::CallbackInfo &info);
	Napi::Value info (const Napi::CallbackInfo &info);
	Napi::Value disableTrack (const Napi::CallbackInfo &info);
	Napi::Value seek (const Napi::CallbackInfo &info);
	Napi::Value lastSegment (const Napi::CallbackInfo &info);
	Napi::Value setLoop (const Napi::CallbackInfo &info);
	Napi::Value attach (const Napi::CallbackInfo &info);
	Napi::Value detach (const Napi::CallbackInfo &info);
	Napi::Value ref (const Napi::CallbackInfo &info);
	Napi::Value unref (const Napi::CallbackInfo &info);
	Napi::Value close (const Napi::CallbackInfo &info);

	void _close ();

	Napi::Env _env;
	Napi::ThreadSafeFunction _tsfn;
	std::unique_ptr<FileCore> _core;
	bool _closed = false;
};

#endif // _MEDIA_DECODERS_FILE_H_
