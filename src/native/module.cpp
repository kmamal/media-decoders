#include <napi.h>
#include "ffmpeg.h"
#include "file.h"
#include "byte-source.h"
#include "feed-reader.h"
#include "video-feed-reader.h"
#include <set>
#include <string>


// Read from the loaded libraries, so that it is right for whichever FFmpeg variant is in place.
static Napi::Value
_decoders (const Napi::CallbackInfo &info)
{
	Napi::Env env = info.Env();
	std::set<std::string> names;
	void *opaque = nullptr;
	const AVCodec *codec;
	while ((codec = av_codec_iterate(&opaque))) {
		if (!av_codec_is_decoder(codec)) { continue; }
		names.insert(avcodec_get_name(codec->id));
	}
	Napi::Array result = Napi::Array::New(env, names.size());
	uint32_t index = 0;
	for (const std::string &name : names) {
		result.Set(index++, Napi::String::New(env, name));
	}
	return result;
}

static Napi::Value
_frameLayout (const Napi::CallbackInfo &info)
{
	Napi::Env env = info.Env();
	const std::string format = info[0].As<Napi::String>().Utf8Value();
	const int width = info[1].As<Napi::Number>().Int32Value();
	const int height = info[2].As<Napi::Number>().Int32Value();

	FrameLayout layout;
	if (!FrameLayout::make(format, width, height, &layout)) {
		NAPI_THROW(Napi::Error::New(env, "invalid frame format"), Napi::Value());
	}

	Napi::Object result = Napi::Object::New(env);
	result.Set("size", Napi::Number::New(env, layout.size));
	Napi::Array planes = Napi::Array::New(env, layout.count);
	for (int i = 0; i < layout.count; i++) {
		const PlaneLayout &plane = layout.planes[i];
		Napi::Object object = Napi::Object::New(env);
		object.Set("offset", Napi::Number::New(env, plane.offset));
		object.Set("stride", Napi::Number::New(env, plane.stride));
		object.Set("width", Napi::Number::New(env, plane.width));
		object.Set("height", Napi::Number::New(env, plane.height));
		planes.Set(static_cast<uint32_t>(i), object);
	}
	result.Set("planes", planes);
	return result;
}

static Napi::Value
_versions (const Napi::CallbackInfo &info)
{
	Napi::Env env = info.Env();
	Napi::Object result = Napi::Object::New(env);
	result.Set("ffmpeg", Napi::String::New(env, av_version_info()));
	result.Set("avcodec", Napi::Number::New(env, avcodec_version()));
	result.Set("avformat", Napi::Number::New(env, avformat_version()));
	result.Set("avutil", Napi::Number::New(env, avutil_version()));
	result.Set("swscale", Napi::Number::New(env, swscale_version()));
	result.Set("swresample", Napi::Number::New(env, swresample_version()));
	return result;
}

static void
_cleanup (napi_env env)
{
	File::closeAll(Napi::Env(env));
	FeedReader::closeAll(Napi::Env(env));
	VideoFeedReader::closeAll(Napi::Env(env));
	ByteSource::closeAll(Napi::Env(env));
}

Napi::Object
init (Napi::Env env, Napi::Object exports)
{
	av_log_set_level(AV_LOG_FATAL);
	File::captureLogs();

	exports.Set("File", File::init(env));
	exports.Set("ByteSource", ByteSource::init(env));
	exports.Set("decoders", Napi::Function::New(env, _decoders));
	exports.Set("FeedReader", FeedReader::init(env));
	exports.Set("feedHeaderSize", Napi::Number::New(env, static_cast<double>(FEED_HEADER_SIZE)));
	exports.Set("feedUserSize", Napi::Number::New(env, static_cast<double>(FEED_USER_SIZE)));
	exports.Set("initFeed", Napi::Function::New(env, initFeed));
	exports.Set("position", Napi::Function::New(env, position));
	exports.Set("VideoFeedReader", VideoFeedReader::init(env));
	exports.Set("videoFeedHeaderSize", Napi::Number::New(env, static_cast<double>(VIDEO_FEED_HEADER_SIZE)));
	exports.Set("initVideoFeed", Napi::Function::New(env, initVideoFeed));
	exports.Set("frameLayout", Napi::Function::New(env, _frameLayout));
	exports.Set("versions", Napi::Function::New(env, _versions));

	napi_add_env_cleanup_hook(env, reinterpret_cast<void (*)(void *)>(_cleanup), env);

	return exports;
}

NODE_API_MODULE(NODE_GYP_MODULE_NAME, init)
