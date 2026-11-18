#include "video-feed-reader.h"
#include "time-epsilon.h"
#include <map>
#include <set>
#include <mutex>
#include <cmath>


static std::mutex readers_mutex;
static std::map<napi_env, std::set<VideoFeedReader *>> all_readers;

bool
videoFeedFromValue (const Napi::Value &value, VideoFeedView *view)
{
	if (!value.IsTypedArray()) { return false; }
	Napi::TypedArray typed = value.As<Napi::TypedArray>();
	if (typed.TypedArrayType() != napi_uint8_array) { return false; }
	Napi::Uint8Array array = value.As<Napi::Uint8Array>();
	if (array.ByteLength() < VIDEO_FEED_HEADER_SIZE) { return false; }
	uint8_t *data = array.Data();
	if (reinterpret_cast<uintptr_t>(data) % alignof(VideoFeedHeader) != 0) { return false; }
	VideoFeedHeader *header = reinterpret_cast<VideoFeedHeader *>(data);
	if (header->magic != VIDEO_FEED_MAGIC) { return false; }
	view->header = header;
	return true;
}

Napi::Value
initVideoFeed (const Napi::CallbackInfo &info)
{
	Napi::Env env = info.Env();
	Napi::Uint8Array array = info[0].As<Napi::Uint8Array>();
	if (array.ByteLength() < VIDEO_FEED_HEADER_SIZE) {
		NAPI_THROW(Napi::Error::New(env, "feed buffer too small"), Napi::Value());
	}
	initVideoFeedHeader(reinterpret_cast<VideoFeedHeader *>(array.Data()));
	return env.Undefined();
}


Napi::Function
VideoFeedReader::init (Napi::Env env)
{
	return DefineClass(env, "VideoFeedReader", {
		InstanceMethod<&VideoFeedReader::next>("next"),
		InstanceMethod<&VideoFeedReader::at>("at"),
		InstanceMethod<&VideoFeedReader::release>("release"),
		InstanceMethod<&VideoFeedReader::ready>("ready"),
		InstanceMethod<&VideoFeedReader::wait>("wait"),
		InstanceMethod<&VideoFeedReader::close>("close"),
		InstanceAccessor<&VideoFeedReader::getEnded>("ended"),
		InstanceAccessor<&VideoFeedReader::getAttached>("attached"),
		InstanceAccessor<&VideoFeedReader::getSeeking>("seeking"),
		InstanceAccessor<&VideoFeedReader::getError>("error"),
	});
}

void
VideoFeedReader::closeAll (Napi::Env env)
{
	std::set<VideoFeedReader *> readers;
	{
		std::unique_lock<std::mutex> lock(readers_mutex);
		auto it = all_readers.find(env);
		if (it == all_readers.end()) { return; }
		readers = it->second;
		all_readers.erase(it);
	}
	for (VideoFeedReader *reader : readers) { reader->_close(); }
}

VideoFeedReader::VideoFeedReader (const Napi::CallbackInfo &info)
	: Napi::ObjectWrap<VideoFeedReader>(info)
	, _env(info.Env())
{
	Napi::Env env = info.Env();
	if (!videoFeedFromValue(info[0], &_feed)) {
		NAPI_THROW_VOID(Napi::TypeError::New(env, "not a video feed"));
	}
	const std::string format = info[1].As<Napi::String>().Utf8Value();
	const int width = info[2].As<Napi::Number>().Int32Value();
	const int height = info[3].As<Napi::Number>().Int32Value();
	FrameLayout layout;
	if (!FrameLayout::make(format, width, height, &layout)) {
		NAPI_THROW_VOID(Napi::RangeError::New(env, "invalid frame format"));
	}
	Napi::Array array = info[4].As<Napi::Array>();
	if (array.Length() < 2 || array.Length() > static_cast<uint32_t>(VIDEO_FEED_MAX_FRAMES)) {
		NAPI_THROW_VOID(Napi::RangeError::New(env, "frames is out of range"));
	}
	std::vector<uint8_t *> data;
	for (uint32_t i = 0; i < array.Length(); i++) {
		Napi::Uint8Array buffer = array.Get(i).As<Napi::Uint8Array>();
		if (buffer.ByteLength() < static_cast<size_t>(layout.size)) {
			NAPI_THROW_VOID(Napi::RangeError::New(env, "buffer too small"));
		}
		data.push_back(buffer.Data());
		_buffers.push_back(Napi::Persistent(buffer));
	}

	VideoFeedHeader *header = _feed.header;
	int32_t expected = 0;
	if (!header->reader_open.compare_exchange_strong(expected, 1)) {
		_buffers.clear();
		NAPI_THROW_VOID(Napi::Error::New(env, "the feed already has a reader"));
	}
	_open = true;
	_block = std::make_shared<VideoBlock>(layout, data);
	_leased.assign(data.size(), false);

	_ref = Napi::Persistent(info[0].As<Napi::Uint8Array>());
	_tsfn = Napi::ThreadSafeFunction::New(env, info[5].As<Napi::Function>(), "media-decoders:video-feed-reader", 0, 1);
	_tsfn.Unref(env);

	{
		std::unique_lock<std::mutex> lock(readers_mutex);
		all_readers[env].insert(this);
	}

	Napi::ThreadSafeFunction tsfn = _tsfn;
	const uint64_t epoch = FeedHub::setReader(header->id, this, [tsfn] () mutable { tsfn.NonBlockingCall(); }, _block);
	seqWrite(header->reader_seq, [&] () {
		header->epoch.store(epoch, std::memory_order_relaxed);
		header->mode.store(static_cast<int32_t>(ReadMode::None), std::memory_order_relaxed);
		header->has_position.store(0, std::memory_order_relaxed);
	});
	FeedHub::wakeWriter(header->id);
}

VideoFeedReader::~VideoFeedReader ()
{
	_close();
	std::unique_lock<std::mutex> lock(readers_mutex);
	auto it = all_readers.find(_env);
	if (it != all_readers.end()) { it->second.erase(this); }
}

void
VideoFeedReader::_close ()
{
	if (!_open) { return; }
	_open = false;
	VideoFeedHeader *header = _feed.header;
	FeedHub::clearReader(header->id, this);
	{
		std::unique_lock<std::mutex> pixels(_block->mutex);
		_block->alive = false;
	}
	header->reader_waiting.store(0);
	header->reader_open.store(0);
	_tsfn.Release();
	_ref.Reset();
	_buffers.clear();
	_block.reset();
	_current = -1;
}

bool
VideoFeedReader::_setMode (Napi::Env env, ReadMode mode)
{
	if (_mode == mode) { return true; }
	if (_mode != ReadMode::None) {
		Napi::Error::New(env, mode == ReadMode::Next ? "the reader is in at() mode" : "the reader is in next() mode").ThrowAsJavaScriptException();
		return false;
	}
	_mode = mode;
	VideoFeedHeader *header = _feed.header;
	seqWrite(header->reader_seq, [&] () {
		header->mode.store(static_cast<int32_t>(mode), std::memory_order_relaxed);
	});
	return true;
}

VideoFeedState
VideoFeedReader::_state ()
{
	VideoFeedHeader *header = _feed.header;
	VideoFeedState state;
	seqRead(header->writer_seq, [&] () {
		state.attached = header->attached.load(std::memory_order_relaxed) != 0;
		state.file = header->file.load(std::memory_order_relaxed);
		state.segment = header->segment.load(std::memory_order_relaxed);
		state.ended = header->ended.load(std::memory_order_relaxed) != 0;
		state.end_segment = header->end_segment.load(std::memory_order_relaxed);
		state.end_time = header->end_time.load(std::memory_order_relaxed);
	});
	if (feedPending(header)) { state.ended = false; }
	return state;
}

bool
VideoFeedReader::_ended (const VideoFeedState &state)
{
	return state.attached && state.ended && !_block->hasReady();
}

void
VideoFeedReader::_wakeWriter ()
{
	VideoFeedHeader *header = _feed.header;
	if (header->writer_waiting.exchange(0)) { FeedHub::wakeWriter(header->id); }
}

Napi::Object
VideoFeedReader::_frame (Napi::Env env, int slot)
{
	const OutFrame &frame = _block->slots[slot].frame;
	Napi::Object result = Napi::Object::New(env);
	result.Set("slot", Napi::Number::New(env, slot));
	result.Set("timestamp", Napi::Number::New(env, frame.timestamp));
	result.Set("duration", Napi::Number::New(env, frame.duration));
	result.Set("segment", Napi::Number::New(env, static_cast<double>(frame.segment)));
	result.Set("file", Napi::Number::New(env, static_cast<double>(frame.file)));
	result.Set("displayWidth", Napi::Number::New(env, frame.display_width));
	result.Set("displayHeight", Napi::Number::New(env, frame.display_height));
	result.Set("matrix", Napi::String::New(env, matrixName(frame.colorspace)));
	result.Set("fullRange", Napi::Boolean::New(env, frame.range == AVCOL_RANGE_JPEG));
	result.Set("transfer", Napi::String::New(env, transferName(frame.transfer)));
	return result;
}

Napi::Value
VideoFeedReader::next (const Napi::CallbackInfo &info)
{
	Napi::Env env = info.Env();
	if (!_open) { return env.Null(); }
	if (!_setMode(env, ReadMode::Next)) { return Napi::Value(); }
	if (!_state().attached) { return env.Null(); }
	const int slot = _block->leaseNext();
	if (slot < 0) { return env.Null(); }
	_leased[slot] = true;
	return _frame(env, slot);
}

Napi::Value
VideoFeedReader::at (const Napi::CallbackInfo &info)
{
	Napi::Env env = info.Env();
	Napi::Object result = Napi::Object::New(env);
	result.Set("frame", env.Null());
	result.Set("ended", Napi::Boolean::New(env, false));
	result.Set("settled", Napi::Boolean::New(env, false));
	if (!_open) { return result; }
	if (!_setMode(env, ReadMode::At)) { return Napi::Value(); }

	const double time = info[2].As<Napi::Number>().DoubleValue();
	const VideoFeedState state = _state();
	const bool same_file = info[0].IsUndefined() || info[0].As<Napi::Number>().DoubleValue() == static_cast<double>(state.file);
	if (!state.attached || !same_file) {
		if (_current >= 0) { result.Set("frame", _frame(env, _current)); }
		return result;
	}
	const int64_t segment = info[1].IsUndefined() ? state.segment : info[1].As<Napi::Number>().Int64Value();

	VideoFeedHeader *header = _feed.header;
	seqWrite(header->reader_seq, [&] () {
		header->has_position.store(1, std::memory_order_relaxed);
		header->position_file.store(state.file, std::memory_order_relaxed);
		header->position_segment.store(segment, std::memory_order_relaxed);
		header->position_time.store(time, std::memory_order_relaxed);
	});

	bool freed = false;
	VideoSlot *slots = _block->slots.get();
	for (;;) {
		int best = -1;
		double best_time = 0;
		for (int i = 0; i < _block->count; i++) {
			if (slots[i].state.load(std::memory_order_acquire) != SLOT_READY) { continue; }
			const double timestamp = slots[i].timestamp.load(std::memory_order_relaxed);
			if (slots[i].segment.load(std::memory_order_relaxed) != segment || timestamp > time + TIME_EPSILON) { continue; }
			if (best < 0 || timestamp > best_time) {
				best = i;
				best_time = timestamp;
			}
		}
		for (int i = 0; i < _block->count; i++) {
			if (i == best || slots[i].state.load(std::memory_order_acquire) != SLOT_READY) { continue; }
			const int64_t candidate = slots[i].segment.load(std::memory_order_relaxed);
			const bool stale = candidate < segment
				|| (candidate == segment && best >= 0 && slots[i].timestamp.load(std::memory_order_relaxed) < best_time);
			if (!stale) { continue; }
			int32_t expected = SLOT_READY;
			if (slots[i].state.compare_exchange_strong(expected, SLOT_FREE, std::memory_order_acq_rel)) { freed = true; }
		}
		if (best < 0) { break; }
		int32_t expected = SLOT_READY;
		if (!slots[best].state.compare_exchange_strong(expected, SLOT_LEASED, std::memory_order_acq_rel)) { continue; }
		if (_current >= 0 && _block->release(_current)) {
			_leased[_current] = false;
			freed = true;
		}
		_current = best;
		_leased[best] = true;
		break;
	}
	if (freed) { _wakeWriter(); }

	bool settled = false;
	for (int i = 0; i < _block->count && !settled; i++) {
		if (slots[i].state.load(std::memory_order_acquire) != SLOT_READY) { continue; }
		const int64_t candidate = slots[i].segment.load(std::memory_order_relaxed);
		settled = candidate > segment || (candidate == segment && slots[i].timestamp.load(std::memory_order_relaxed) > time + TIME_EPSILON);
	}
	if (_current >= 0) {
		const OutFrame &frame = slots[_current].frame;
		if (frame.segment == segment && frame.timestamp <= time + TIME_EPSILON && time < frame.timestamp + frame.duration) { settled = true; }
	}

	const bool ended = state.ended && (segment > state.end_segment || (segment == state.end_segment && time >= state.end_time - TIME_EPSILON));
	if (_current >= 0) { result.Set("frame", _frame(env, _current)); }
	result.Set("ended", Napi::Boolean::New(env, ended));
	result.Set("settled", Napi::Boolean::New(env, settled));
	return result;
}

Napi::Value
VideoFeedReader::release (const Napi::CallbackInfo &info)
{
	Napi::Env env = info.Env();
	if (!_open) { return env.Undefined(); }
	const int slot = info[0].As<Napi::Number>().Int32Value();
	if (slot < 0 || slot >= _block->count || !_leased[slot]) { return env.Undefined(); }
	_leased[slot] = false;
	if (slot == _current) { _current = -1; }
	if (_block->release(slot)) { _wakeWriter(); }
	return env.Undefined();
}

Napi::Value
VideoFeedReader::ready (const Napi::CallbackInfo &info)
{
	Napi::Env env = info.Env();
	if (!_open) { return Napi::Boolean::New(env, true); }
	const VideoFeedState state = _state();
	if (!state.attached || state.ended || _block->hasReady()) { return Napi::Boolean::New(env, true); }
	std::string message;
	return Napi::Boolean::New(env, readFeedError(_feed.header, &message) != 0);
}

Napi::Value
VideoFeedReader::wait (const Napi::CallbackInfo &info)
{
	Napi::Env env = info.Env();
	const bool waiting = info[0].ToBoolean();
	if (!_open) { return env.Undefined(); }
	_feed.header->reader_waiting.store(waiting ? 1 : 0);
	if (waiting != _waiting) {
		_waiting = waiting;
		if (waiting) { _tsfn.Ref(env); }
		else { _tsfn.Unref(env); }
	}
	return env.Undefined();
}

Napi::Value
VideoFeedReader::getEnded (const Napi::CallbackInfo &info)
{
	Napi::Env env = info.Env();
	if (!_open) { return Napi::Boolean::New(env, false); }
	return Napi::Boolean::New(env, _ended(_state()));
}

Napi::Value
VideoFeedReader::getAttached (const Napi::CallbackInfo &info)
{
	Napi::Env env = info.Env();
	return Napi::Boolean::New(env, _open && _state().attached);
}

Napi::Value
VideoFeedReader::getSeeking (const Napi::CallbackInfo &info)
{
	Napi::Env env = info.Env();
	return Napi::Boolean::New(env, _open && feedSeeking(_feed.header));
}

Napi::Value
VideoFeedReader::getError (const Napi::CallbackInfo &info)
{
	Napi::Env env = info.Env();
	if (!_open) { return env.Null(); }
	std::string message;
	const int code = readFeedError(_feed.header, &message);
	if (code == 0) { return env.Null(); }
	Napi::Object result = Napi::Object::New(env);
	result.Set("code", Napi::Number::New(env, code));
	result.Set("message", Napi::String::New(env, message));
	return result;
}

Napi::Value
VideoFeedReader::close (const Napi::CallbackInfo &info)
{
	_close();
	return info.Env().Undefined();
}
