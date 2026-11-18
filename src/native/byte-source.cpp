#include "byte-source.h"
#include "ffmpeg.h"
#include <map>
#include <set>
#include <algorithm>
#include <cstring>


static constexpr int64_t REQUEST_SLACK = 256 * 1024;

static std::mutex all_sources_mutex;
static std::map<napi_env, std::set<ByteSource *>> all_sources;


bool
ByteSourceState::_find (int64_t offset, const uint8_t **data, int64_t *length)
{
	auto it = chunks.upper_bound(offset);
	while (it != chunks.begin()) {
		--it;
		const int64_t start = it->first;
		const int64_t end = start + static_cast<int64_t>(it->second.size());
		if (offset < end) {
			*data = it->second.data() + (offset - start);
			*length = end - offset;
			return true;
		}
		if (start + max_chunk <= offset) { break; }
	}
	return false;
}

void
ByteSourceState::evict ()
{
	if (!random_access) { return; }
	const int64_t low = position - behind_limit;
	const int64_t high = std::max(position, stream_end) + ahead_limit;
	for (auto it = chunks.begin(); it != chunks.end();) {
		const int64_t start = it->first;
		const int64_t end = start + static_cast<int64_t>(it->second.size());
		if (end < low || start > high) {
			it = chunks.erase(it);
		}
		else {
			++it;
		}
	}
}

void
ByteSourceState::_notify ()
{
	if (closed) { return; }
	notify();
}

void
ByteSourceState::_checkSpace ()
{
	if (full && stream_end - position < ahead_limit / 2) {
		full = false;
		space_pending = true;
		_notify();
	}
}

int
ByteSourceState::read (uint8_t *buffer, int length)
{
	std::unique_lock<std::mutex> lock(mutex);
	for (;;) {
		if (closed) { return AVERROR_EXIT; }
		if (!error.empty()) { return AVERROR(EIO); }

		const uint8_t *data;
		int64_t available;
		if (_find(position, &data, &available)) {
			const int count = static_cast<int>(std::min<int64_t>(available, length));
			memcpy(buffer, data, count);
			position += count;
			evict();
			_checkSpace();
			return count;
		}

		_checkSpace();
		if (size >= 0 && position >= size) { return AVERROR_EOF; }

		const bool coming = stream_end <= position && position <= stream_end + REQUEST_SLACK;
		if (!coming && requested != position) {
			requested = position;
			request_pending = true;
			_notify();
		}

		cond.wait(lock);
	}
}

int64_t
ByteSourceState::seek (int64_t offset, int whence)
{
	std::unique_lock<std::mutex> lock(mutex);
	switch (whence & ~AVSEEK_FORCE) {
		case AVSEEK_SIZE: return size >= 0 ? size : AVERROR(ENOSYS);
		case SEEK_SET: position = offset; break;
		case SEEK_CUR: position += offset; break;
		case SEEK_END: {
			if (size < 0) { return AVERROR(ENOSYS); }
			position = size + offset;
			break;
		}
		default: return AVERROR(EINVAL);
	}
	return position;
}

void
ByteSourceState::close ()
{
	std::unique_lock<std::mutex> lock(mutex);
	if (closed) { return; }
	closed = true;
	chunks.clear();
	on_close();
	cond.notify_all();
}


Napi::Function
ByteSource::init (Napi::Env env)
{
	return DefineClass(env, "ByteSource", {
		InstanceMethod<&ByteSource::push>("push"),
		InstanceMethod<&ByteSource::end>("end"),
		InstanceMethod<&ByteSource::fail>("fail"),
		InstanceMethod<&ByteSource::setSize>("setSize"),
		InstanceMethod<&ByteSource::size>("size"),
		InstanceMethod<&ByteSource::restart>("restart"),
		InstanceMethod<&ByteSource::takeEvents>("takeEvents"),
		InstanceMethod<&ByteSource::bufferedRanges>("bufferedRanges"),
		InstanceMethod<&ByteSource::close>("close"),
	});
}

void
ByteSource::closeAll (Napi::Env env)
{
	std::set<ByteSource *> sources;
	{
		std::unique_lock<std::mutex> lock(all_sources_mutex);
		auto it = all_sources.find(env);
		if (it == all_sources.end()) { return; }
		sources = it->second;
		all_sources.erase(it);
	}
	for (ByteSource *source : sources) { source->state->close(); }
}

ByteSource::ByteSource (const Napi::CallbackInfo &info)
	: Napi::ObjectWrap<ByteSource>(info)
	, state(std::make_shared<ByteSourceState>())
	, _env(info.Env())
{
	Napi::Env env = info.Env();
	Napi::Object options = info[0].As<Napi::Object>();
	Napi::Function callback = info[1].As<Napi::Function>();

	state->random_access = options.Get("randomAccess").ToBoolean();
	Napi::Value size = options.Get("size");
	state->size = size.IsNumber() ? size.As<Napi::Number>().Int64Value() : -1;
	state->ahead_limit = options.Get("aheadLimit").As<Napi::Number>().Int64Value();
	state->behind_limit = options.Get("behindLimit").As<Napi::Number>().Int64Value();

	Napi::ThreadSafeFunction tsfn = Napi::ThreadSafeFunction::New(env, callback, "media-decoders:byte-source", 0, 1);
	tsfn.Unref(env);
	state->notify = [tsfn] () mutable { tsfn.NonBlockingCall(); };
	state->on_close = [tsfn] () mutable { tsfn.Release(); };

	std::unique_lock<std::mutex> lock(all_sources_mutex);
	all_sources[env].insert(this);
}

ByteSource::~ByteSource ()
{
	state->close();
	std::unique_lock<std::mutex> lock(all_sources_mutex);
	auto it = all_sources.find(_env);
	if (it != all_sources.end()) { it->second.erase(this); }
}

Napi::Value
ByteSource::push (const Napi::CallbackInfo &info)
{
	const int64_t offset = info[0].As<Napi::Number>().Int64Value();
	Napi::Uint8Array array = info[1].As<Napi::Uint8Array>();
	const uint8_t *data = array.Data();
	const size_t length = array.ByteLength();

	std::unique_lock<std::mutex> lock(state->mutex);
	if (state->closed) { return Napi::Boolean::New(info.Env(), false); }

	if (length > 0) {
		auto &chunk = state->chunks[offset];
		if (chunk.size() < length) { chunk.assign(data, data + length); }
		state->max_chunk = std::max(state->max_chunk, static_cast<int64_t>(length));
	}
	state->stream_end = std::max(state->stream_end, offset + static_cast<int64_t>(length));
	state->cond.notify_all();

	const bool want_more = !state->random_access
		|| state->stream_end - state->position < state->ahead_limit;
	if (!want_more) { state->full = true; }
	return Napi::Boolean::New(info.Env(), want_more);
}

Napi::Value
ByteSource::end (const Napi::CallbackInfo &info)
{
	std::unique_lock<std::mutex> lock(state->mutex);
	if (state->size < 0) { state->size = state->stream_end; }
	state->cond.notify_all();
	return info.Env().Undefined();
}

Napi::Value
ByteSource::fail (const Napi::CallbackInfo &info)
{
	std::string message = info[0].As<Napi::String>().Utf8Value();
	std::unique_lock<std::mutex> lock(state->mutex);
	state->error = message.empty() ? "error" : message;
	state->cond.notify_all();
	return info.Env().Undefined();
}

Napi::Value
ByteSource::setSize (const Napi::CallbackInfo &info)
{
	std::unique_lock<std::mutex> lock(state->mutex);
	state->size = info[0].As<Napi::Number>().Int64Value();
	state->cond.notify_all();
	return info.Env().Undefined();
}

Napi::Value
ByteSource::size (const Napi::CallbackInfo &info)
{
	std::unique_lock<std::mutex> lock(state->mutex);
	return Napi::Number::New(info.Env(), static_cast<double>(state->size));
}

Napi::Value
ByteSource::restart (const Napi::CallbackInfo &info)
{
	const int64_t offset = info[0].As<Napi::Number>().Int64Value();
	std::unique_lock<std::mutex> lock(state->mutex);
	state->stream_end = offset;
	state->requested = -1;
	state->full = false;
	state->error.clear();
	state->evict();
	state->cond.notify_all();
	return info.Env().Undefined();
}

Napi::Value
ByteSource::takeEvents (const Napi::CallbackInfo &info)
{
	Napi::Env env = info.Env();
	Napi::Object result = Napi::Object::New(env);
	std::unique_lock<std::mutex> lock(state->mutex);
	result.Set("request", state->request_pending
		? Napi::Number::New(env, static_cast<double>(state->requested))
		: env.Null());
	result.Set("space", Napi::Boolean::New(env, state->space_pending));
	result.Set("position", Napi::Number::New(env, static_cast<double>(state->position)));
	state->request_pending = false;
	state->space_pending = false;
	return result;
}

Napi::Value
ByteSource::bufferedRanges (const Napi::CallbackInfo &info)
{
	Napi::Env env = info.Env();
	Napi::Array result = Napi::Array::New(env);
	std::unique_lock<std::mutex> lock(state->mutex);
	int64_t start = -1;
	int64_t end = -1;
	uint32_t index = 0;
	const auto flush = [&] () {
		if (start < 0) { return; }
		Napi::Array range = Napi::Array::New(env, 2);
		range.Set(0u, Napi::Number::New(env, static_cast<double>(start)));
		range.Set(1u, Napi::Number::New(env, static_cast<double>(end)));
		result.Set(index++, range);
	};
	for (const auto &[ chunk_start, chunk ] : state->chunks) {
		const int64_t chunk_end = chunk_start + static_cast<int64_t>(chunk.size());
		if (start >= 0 && chunk_start <= end) {
			end = std::max(end, chunk_end);
			continue;
		}
		flush();
		start = chunk_start;
		end = chunk_end;
	}
	flush();
	return result;
}

Napi::Value
ByteSource::close (const Napi::CallbackInfo &info)
{
	state->close();
	return info.Env().Undefined();
}

InputSource
inputSourceFrom (Napi::Value value)
{
	InputSource input;
	if (value.IsString()) {
		input.path = value.As<Napi::String>().Utf8Value();
	}
	else if (value.IsTypedArray()) {
		Napi::Uint8Array array = value.As<Napi::Uint8Array>();
		const uint8_t *data = array.Data();
		input.bytes.assign(data, data + array.ByteLength());
	}
	else {
		input.source = ByteSource::Unwrap(value.As<Napi::Object>())->state;
	}
	return input;
}
