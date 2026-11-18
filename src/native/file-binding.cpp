#include "file.h"
#include "byte-source.h"
#include "feed-reader.h"
#include "video-feed-reader.h"
#include <map>
#include <set>
#include <mutex>


static std::mutex all_files_mutex;
static std::map<napi_env, std::set<File *>> all_files;

namespace {

class References : public KeepAlive {
public:
	std::vector<Napi::Reference<Napi::Uint8Array>> refs;
};

}

static const char *
_typeName (AVMediaType type)
{
	switch (type) {
		case AVMEDIA_TYPE_VIDEO: return "video";
		case AVMEDIA_TYPE_AUDIO: return "audio";
		default: return "other";
	}
}



Napi::Function
File::init (Napi::Env env)
{
	return DefineClass(env, "File", {
		InstanceAccessor<&File::getId>("id"),
		InstanceMethod<&File::takeEvents>("takeEvents"),
		InstanceMethod<&File::info>("info"),
		InstanceMethod<&File::disableTrack>("disableTrack"),
		InstanceMethod<&File::seek>("seek"),
		InstanceMethod<&File::lastSegment>("lastSegment"),
		InstanceMethod<&File::setLoop>("setLoop"),
		InstanceMethod<&File::attach>("attach"),
		InstanceMethod<&File::detach>("detach"),
		InstanceMethod<&File::ref>("ref"),
		InstanceMethod<&File::unref>("unref"),
		InstanceMethod<&File::close>("close"),
	});
}

void
File::closeAll (Napi::Env env)
{
	std::set<File *> files;
	{
		std::unique_lock<std::mutex> lock(all_files_mutex);
		auto it = all_files.find(env);
		if (it == all_files.end()) { return; }
		files = it->second;
		all_files.erase(it);
	}
	for (File *file : files) { file->_close(); }
}

File::File (const Napi::CallbackInfo &info)
	: Napi::ObjectWrap<File>(info)
	, _env(info.Env())
{
	Napi::Env env = info.Env();

	InputSource source = inputSourceFrom(info[0]);
	const double max_queued_bytes = info[2].As<Napi::Number>().DoubleValue();

	_tsfn = Napi::ThreadSafeFunction::New(env, info[1].As<Napi::Function>(), "media-decoders:file", 0, 1);
	_tsfn.Unref(env);

	{
		std::unique_lock<std::mutex> lock(all_files_mutex);
		all_files[env].insert(this);
	}

	Napi::ThreadSafeFunction tsfn = _tsfn;
	_core = std::make_unique<FileCore>(std::move(source), max_queued_bytes, [tsfn] () { tsfn.NonBlockingCall(); });
}

File::~File ()
{
	_close();
	std::unique_lock<std::mutex> lock(all_files_mutex);
	auto it = all_files.find(_env);
	if (it != all_files.end()) { it->second.erase(this); }
}

void
File::_close ()
{
	if (_closed) { return; }
	_closed = true;
	_core->close();
	_tsfn.Release();
}

Napi::Value
File::getId (const Napi::CallbackInfo &info)
{
	return Napi::Number::New(info.Env(), static_cast<double>(_core->id()));
}

Napi::Value
File::takeEvents (const Napi::CallbackInfo &info)
{
	Napi::Env env = info.Env();
	const FileEvents events = _core->takeEvents();

	Napi::Object result = Napi::Object::New(env);
	result.Set("open", env.Null());
	if (events.opened) {
		result.Set("open", events.open_error.empty() ? Napi::Value(env.Null()) : Napi::String::New(env, events.open_error));
		result.Set("opened", Napi::Boolean::New(env, true));
	}
	Napi::Array errors = Napi::Array::New(env, events.errors.size());
	for (size_t i = 0; i < events.errors.size(); i++) {
		const ErrorEvent &event = events.errors[i];
		Napi::Object error = Napi::Object::New(env);
		error.Set("message", Napi::String::New(env, event.message));
		error.Set("fatal", Napi::Boolean::New(env, event.fatal));
		error.Set("track", Napi::Number::New(env, event.track));
		errors.Set(static_cast<uint32_t>(i), error);
	}
	result.Set("errors", errors);
	return result;
}

Napi::Value
File::info (const Napi::CallbackInfo &info)
{
	Napi::Env env = info.Env();
	const FileInfo file = _core->info();

	Napi::Object result = Napi::Object::New(env);
	result.Set("duration", Napi::Number::New(env, file.duration));
	result.Set("startTime", Napi::Number::New(env, file.start_time));
	result.Set("format", Napi::String::New(env, file.format));

	Napi::Array tracks = Napi::Array::New(env, file.tracks.size());
	for (size_t i = 0; i < file.tracks.size(); i++) {
		const TrackInfo &track = file.tracks[i];
		Napi::Object object = Napi::Object::New(env);
		object.Set("index", Napi::Number::New(env, static_cast<double>(i)));
		object.Set("type", Napi::String::New(env, _typeName(track.type)));
		object.Set("codec", Napi::String::New(env, track.codec));
		object.Set("decodable", Napi::Boolean::New(env, track.decodable));
		object.Set("startTime", Napi::Number::New(env, track.start_time));
		object.Set("duration", track.duration >= 0 ? Napi::Value(Napi::Number::New(env, track.duration)) : env.Null());

		if (track.type == AVMEDIA_TYPE_VIDEO) {
			object.Set("width", Napi::Number::New(env, track.width));
			object.Set("height", Napi::Number::New(env, track.height));
			object.Set("displayWidth", Napi::Number::New(env, track.display_width));
			object.Set("displayHeight", Napi::Number::New(env, track.display_height));
			object.Set("rotation", Napi::Number::New(env, track.rotation));
			object.Set("flip", Napi::Boolean::New(env, track.flip));
			object.Set("frameRate", track.frame_rate > 0 ? Napi::Value(Napi::Number::New(env, track.frame_rate)) : env.Null());
			object.Set("matrix", Napi::String::New(env, track.matrix));
			object.Set("fullRange", Napi::Boolean::New(env, track.full_range));
			object.Set("transfer", Napi::String::New(env, track.transfer));
		}
		else if (track.type == AVMEDIA_TYPE_AUDIO) {
			object.Set("sampleRate", Napi::Number::New(env, track.sample_rate));
			object.Set("channels", Napi::Number::New(env, track.channels));
			object.Set("seekPreroll", track.seek_preroll >= 0 ? Napi::Value(Napi::Number::New(env, track.seek_preroll)) : env.Null());
		}

		tracks.Set(static_cast<uint32_t>(i), object);
	}
	result.Set("tracks", tracks);
	return result;
}

Napi::Value
File::disableTrack (const Napi::CallbackInfo &info)
{
	_core->disableTrack(info[0].As<Napi::Number>().Uint32Value());
	return info.Env().Undefined();
}

Napi::Value
File::seek (const Napi::CallbackInfo &info)
{
	const int64_t segment = _core->seek(info[0].As<Napi::Number>().DoubleValue());
	return Napi::Number::New(info.Env(), static_cast<double>(segment));
}

Napi::Value
File::lastSegment (const Napi::CallbackInfo &info)
{
	return Napi::Number::New(info.Env(), static_cast<double>(_core->lastSegment()));
}

Napi::Value
File::setLoop (const Napi::CallbackInfo &info)
{
	_core->setLoop(info[0].ToBoolean());
	return info.Env().Undefined();
}

Napi::Value
File::attach (const Napi::CallbackInfo &info)
{
	Napi::Env env = info.Env();
	const int index = info[0].As<Napi::Number>().Int32Value();
	FeedView view;
	VideoFeedView video;
	const bool audio = feedFromValue(info[1], &view);
	if (!audio && !videoFeedFromValue(info[1], &video)) {
		NAPI_THROW(Napi::TypeError::New(env, "not a feed"), Napi::Value());
	}

	auto references = std::make_unique<References>();
	references->refs.push_back(Napi::Persistent(info[1].As<Napi::Uint8Array>()));
	int64_t generation = -1;
	const int threads = info[2].IsNumber() ? info[2].As<Napi::Number>().Int32Value() : 0;
	const std::string error = audio
		? _core->attach(index, view, std::move(references), &generation)
		: _core->attachVideo(index, video, std::move(references), threads, &generation);
	if (!error.empty()) {
		NAPI_THROW(Napi::Error::New(env, error), Napi::Value());
	}
	return Napi::Number::New(env, static_cast<double>(generation));
}

Napi::Value
File::detach (const Napi::CallbackInfo &info)
{
	FeedView view;
	VideoFeedView video;
	if (feedFromValue(info[0], &view)) { _core->detach(view.header->id); }
	else if (videoFeedFromValue(info[0], &video)) { _core->detach(video.header->id); }
	else { NAPI_THROW(Napi::TypeError::New(info.Env(), "not a feed"), Napi::Value()); }
	return info.Env().Undefined();
}

Napi::Value
File::ref (const Napi::CallbackInfo &info)
{
	if (!_closed) { _tsfn.Ref(info.Env()); }
	return info.Env().Undefined();
}

Napi::Value
File::unref (const Napi::CallbackInfo &info)
{
	if (!_closed) { _tsfn.Unref(info.Env()); }
	return info.Env().Undefined();
}

Napi::Value
File::close (const Napi::CallbackInfo &info)
{
	_close();
	return info.Env().Undefined();
}
