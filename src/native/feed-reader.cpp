#include "feed-reader.h"
#include <map>
#include <vector>
#include <set>
#include <mutex>
#include <cmath>
#include <cstring>
#include <limits>
#include <algorithm>


static std::mutex readers_mutex;
static std::map<napi_env, std::set<FeedReader *>> all_readers;

bool
feedFromValue (const Napi::Value &value, FeedView *view)
{
	if (!value.IsTypedArray()) { return false; }
	Napi::TypedArray typed = value.As<Napi::TypedArray>();
	if (typed.TypedArrayType() != napi_uint8_array) { return false; }
	Napi::Uint8Array array = value.As<Napi::Uint8Array>();
	if (array.ByteLength() < FEED_HEADER_SIZE) { return false; }
	uint8_t *data = array.Data();
	if (reinterpret_cast<uintptr_t>(data) % alignof(FeedHeader) != 0) { return false; }
	FeedHeader *header = reinterpret_cast<FeedHeader *>(data);
	if (header->magic != FEED_MAGIC) { return false; }
	view->header = header;
	return true;
}


Napi::Value
initFeed (const Napi::CallbackInfo &info)
{
	Napi::Env env = info.Env();
	Napi::Uint8Array array = info[0].As<Napi::Uint8Array>();
	if (array.ByteLength() < FEED_HEADER_SIZE) {
		NAPI_THROW(Napi::Error::New(env, "feed buffer too small"), Napi::Value());
	}
	FeedHeader *header = new (array.Data()) FeedHeader();
	header->id = nextFeedId();
	header->end_index.store(-1);
	header->magic = FEED_MAGIC;
	return env.Undefined();
}

static FeedHeader *
_headerArg (const Napi::CallbackInfo &info)
{
	FeedView view;
	if (!feedFromValue(info[0], &view)) {
		NAPI_THROW(Napi::TypeError::New(info.Env(), "not a feed"), nullptr);
	}
	return view.header;
}

Napi::Value
position (const Napi::CallbackInfo &info)
{
	Napi::Env env = info.Env();
	FeedHeader *header = _headerArg(info);
	if (!header) { return env.Undefined(); }

	const double lag = info[1].IsUndefined() ? 0.0 : info[1].ToNumber().DoubleValue();
	if (!std::isfinite(lag)) {
		NAPI_THROW(Napi::RangeError::New(env, "lagFrames must be a finite number"), Napi::Value());
	}

	double consumed = 0;
	seqRead(header->reader_seq, [&] () {
		consumed = header->consumed.load(std::memory_order_relaxed);
	});

	bool has = false;
	FeedEntry entry;
	int64_t end = -1;
	double heard = consumed - lag;
	seqRead(header->writer_seq, [&] () {
		end = header->end_index.load(std::memory_order_relaxed);
		const int64_t write = header->write_index.load(std::memory_order_relaxed);
		heard = consumed - lag;
		if (lag < 0) {
			const double start = static_cast<double>(header->start_index.load(std::memory_order_relaxed));
			heard = std::min(std::max(consumed, start) - lag, static_cast<double>(write));
		}
		int64_t next = 0;
		FeedEntry current;
		has = findEntry(header, consumed, &current, &next);
		if (has) {
			double lookup = heard;
			if (end >= 0 && heard >= static_cast<double>(end)) {
				const bool empty = write == end && current.index == end;
				lookup = empty ? static_cast<double>(end) : static_cast<double>(end) - 0.5;
			}
			has = findEntry(header, lookup, &entry, &next);
		}
	});

	Napi::Object result = Napi::Object::New(env);
	if (!has) {
		result.Set("file", Napi::Number::New(env, -1));
		result.Set("generation", Napi::Number::New(env, -1));
		result.Set("segment", Napi::Number::New(env, -1));
		result.Set("time", Napi::Number::New(env, 0));
		result.Set("ended", Napi::Boolean::New(env, false));
		return result;
	}

	double time = entry.time;
	if (heard > static_cast<double>(entry.index) && entry.rate > 0) {
		time += (heard - static_cast<double>(entry.index)) / entry.rate;
	}
	const bool ended = end >= 0 && heard >= static_cast<double>(end) - 1e-6;

	result.Set("file", Napi::Number::New(env, static_cast<double>(entry.file)));
	result.Set("generation", Napi::Number::New(env, static_cast<double>(entry.generation)));
	result.Set("segment", Napi::Number::New(env, static_cast<double>(entry.segment)));
	result.Set("time", Napi::Number::New(env, time));
	result.Set("ended", Napi::Boolean::New(env, ended));
	return result;
}


Napi::Function
FeedReader::init (Napi::Env env)
{
	return DefineClass(env, "FeedReader", {
		InstanceMethod<&FeedReader::read>("read"),
		InstanceMethod<&FeedReader::readBlock>("readBlock"),
		InstanceMethod<&FeedReader::ready>("ready"),
		InstanceMethod<&FeedReader::wait>("wait"),
		InstanceMethod<&FeedReader::close>("close"),
		InstanceAccessor<&FeedReader::getChannels>("channels"),
		InstanceAccessor<&FeedReader::getEnded>("ended"),
		InstanceAccessor<&FeedReader::getSeeking>("seeking"),
		InstanceAccessor<&FeedReader::getError>("error"),
	});
}

void
FeedReader::closeAll (Napi::Env env)
{
	std::set<FeedReader *> readers;
	{
		std::unique_lock<std::mutex> lock(readers_mutex);
		auto it = all_readers.find(env);
		if (it == all_readers.end()) { return; }
		readers = it->second;
		all_readers.erase(it);
	}
	for (FeedReader *reader : readers) { reader->_close(); }
}

FeedReader::FeedReader (const Napi::CallbackInfo &info)
	: Napi::ObjectWrap<FeedReader>(info)
	, _env(info.Env())
{
	Napi::Env env = info.Env();
	if (!feedFromValue(info[0], &_feed)) {
		NAPI_THROW_VOID(Napi::TypeError::New(env, "not a feed"));
	}
	const int rate = info[1].As<Napi::Number>().Int32Value();
	if (rate < 3000 || rate > 768000) {
		NAPI_THROW_VOID(Napi::RangeError::New(env, "sampleRate is out of range"));
	}
	const int channels = info[2].As<Napi::Number>().Int32Value();
	if (channels < 1 || channels > static_cast<int>(FEED_MAX_CHANNELS)) {
		NAPI_THROW_VOID(Napi::RangeError::New(env, "channels is out of range"));
	}
	const bool fixed = info[3].ToBoolean();
	const double buffer = info[4].As<Napi::Number>().DoubleValue();
	if (!std::isfinite(buffer) || buffer <= 0) {
		NAPI_THROW_VOID(Napi::RangeError::New(env, "buffer must be a positive number"));
	}
	const double frames = std::max(static_cast<double>(FEED_MIN_FRAMES), std::ceil(buffer * rate));
	if (frames * channels > static_cast<double>(FEED_MAX_SAMPLES)) {
		NAPI_THROW_VOID(Napi::RangeError::New(env, "buffer is too large"));
	}

	FeedHeader *header = _feed.header;
	int32_t expected = 0;
	if (!header->reader_open.compare_exchange_strong(expected, 1)) {
		NAPI_THROW_VOID(Napi::Error::New(env, "the feed already has a reader"));
	}
	_open = true;
	_rate = rate;
	_block = std::make_shared<FeedBlock>(channels, fixed, rate, static_cast<int64_t>(frames));

	_ref = Napi::Persistent(info[0].As<Napi::Uint8Array>());
	_tsfn = Napi::ThreadSafeFunction::New(env, info[5].As<Napi::Function>(), "media-decoders:feed-reader", 0, 1);
	_tsfn.Unref(env);

	{
		std::unique_lock<std::mutex> lock(readers_mutex);
		all_readers[env].insert(this);
	}

	Napi::ThreadSafeFunction tsfn = _tsfn;
	_epoch = FeedHub::setReader(header->id, this, [tsfn] () mutable { tsfn.NonBlockingCall(); }, _block);
	seqWrite(header->reader_seq, [&] () {
		header->epoch.store(_epoch, std::memory_order_relaxed);
	});
	FeedHub::wakeWriter(header->id);
}

FeedReader::~FeedReader ()
{
	_close();
	std::unique_lock<std::mutex> lock(readers_mutex);
	auto it = all_readers.find(_env);
	if (it != all_readers.end()) { it->second.erase(this); }
}

void
FeedReader::_close ()
{
	if (!_open) { return; }
	_open = false;
	FeedHeader *header = _feed.header;
	FeedHub::clearReader(header->id, this);
	header->reader_waiting.store(0);
	header->reader_open.store(0);
	_tsfn.Release();
	_ref.Reset();
	_block.reset();
}

double
FeedReader::_skipToStart ()
{
	FeedHeader *header = _feed.header;
	const double consumed = header->consumed.load(std::memory_order_relaxed);
	int64_t start = 0;
	int64_t write = 0;
	seqRead(header->writer_seq, [&] () {
		start = header->start_index.load(std::memory_order_relaxed);
		write = header->write_index.load(std::memory_order_relaxed);
	});
	if (consumed >= static_cast<double>(start)) { return consumed; }
	const double position = static_cast<double>(start);
	seqWrite(header->reader_seq, [&] () {
		header->consumed.store(position, std::memory_order_relaxed);
	});
	if (header->writer_waiting.exchange(0)) { FeedHub::wakeWriter(header->id); }
	return position;
}

struct ReadState {
	bool attached = false;
	bool has = false;
	FeedEntry entry;
	int64_t next = 0;
	int64_t write = 0;
	int64_t end = -1;
	double limit = 0;
	bool hard = false;
	bool at_entry = false;
};

static void
_readState (FeedHeader *header, double position, uint64_t epoch, ReadState *state)
{
	const bool pending = feedPending(header);
	seqRead(header->writer_seq, [&] () {
		state->attached = header->attached.load(std::memory_order_relaxed) != 0;
		state->write = header->write_index.load(std::memory_order_relaxed);
		state->end = header->end_index.load(std::memory_order_relaxed);
		state->has = findEntry(header, position, &state->entry, &state->next);
	});
	if (state->has && state->entry.epoch != epoch) { state->has = false; }
	double limit = static_cast<double>(state->write);
	state->hard = false;
	state->at_entry = false;
	if (pending) { state->end = -1; }
	if (state->end >= 0 && static_cast<double>(state->end) <= limit) {
		limit = static_cast<double>(state->end);
		state->hard = true;
	}
	if (state->has && static_cast<double>(state->next) <= limit) {
		state->at_entry = state->end < 0 || state->next < state->end;
		limit = static_cast<double>(state->next);
		state->hard = true;
	}
	state->limit = limit;
}

Napi::Value
FeedReader::read (const Napi::CallbackInfo &info)
{
	Napi::Env env = info.Env();
	Napi::Array planes = info[0].As<Napi::Array>();
	const double rate = info[1].IsUndefined() ? 1.0 : info[1].ToNumber().DoubleValue();
	if (!std::isfinite(rate) || rate <= 0) {
		NAPI_THROW(Napi::RangeError::New(env, "rate must be a positive number"), Napi::Value());
	}

	const uint32_t plane_count = std::min<uint32_t>(planes.Length(), static_cast<uint32_t>(_block ? _block->channels : 0));
	std::vector<float *> out(plane_count);
	size_t frames = plane_count > 0 ? std::numeric_limits<size_t>::max() : 0;
	for (uint32_t i = 0; i < plane_count; i++) {
		Napi::Float32Array array = planes.Get(i).As<Napi::Float32Array>();
		out[i] = array.Data();
		frames = std::min(frames, array.ElementLength());
	}
	for (uint32_t i = plane_count; i < planes.Length(); i++) {
		Napi::Float32Array array = planes.Get(i).As<Napi::Float32Array>();
		std::fill_n(array.Data(), array.ElementLength(), 0.0f);
	}

	BlockInfo block;
	const size_t written = _read(out.data(), plane_count, 1, frames, rate, -1, true, &block);
	return Napi::Number::New(env, static_cast<double>(written));
}

Napi::Value
FeedReader::readBlock (const Napi::CallbackInfo &info)
{
	Napi::Env env = info.Env();
	std::vector<float *> out;
	uint32_t plane_count = 0;
	size_t stride = 1;
	size_t frames = 0;
	if (info[0].IsTypedArray()) {
		Napi::Float32Array array = info[0].As<Napi::Float32Array>();
		const uint32_t channels = std::max<uint32_t>(1, info[1].ToNumber().Uint32Value());
		plane_count = std::min<uint32_t>(channels, static_cast<uint32_t>(_block ? _block->channels : 0));
		stride = channels;
		frames = array.ElementLength() / channels;
		std::fill_n(array.Data(), array.ElementLength(), 0.0f);
		out.resize(plane_count);
		for (uint32_t c = 0; c < plane_count; c++) { out[c] = array.Data() + c; }
	}
	else {
		Napi::Array planes = info[0].As<Napi::Array>();
		plane_count = std::min<uint32_t>(planes.Length(), static_cast<uint32_t>(_block ? _block->channels : 0));
		frames = plane_count > 0 ? std::numeric_limits<size_t>::max() : 0;
		out.resize(plane_count);
		for (uint32_t i = 0; i < plane_count; i++) {
			Napi::Float32Array array = planes.Get(i).As<Napi::Float32Array>();
			out[i] = array.Data();
			frames = std::min(frames, array.ElementLength());
		}
		for (uint32_t i = plane_count; i < planes.Length(); i++) {
			Napi::Float32Array array = planes.Get(i).As<Napi::Float32Array>();
			std::fill_n(array.Data(), array.ElementLength(), 0.0f);
		}
	}

	const int64_t expected = info[2].IsNumber() ? info[2].As<Napi::Number>().Int64Value() : -1;
	BlockInfo block;
	const size_t written = _read(out.data(), plane_count, stride, frames, 1, expected, false, &block);
	Napi::Object result = Napi::Object::New(env);
	result.Set("frames", Napi::Number::New(env, static_cast<double>(written)));
	result.Set("timestamp", Napi::Number::New(env, block.timestamp));
	result.Set("segment", Napi::Number::New(env, static_cast<double>(block.segment)));
	result.Set("entry", Napi::Number::New(env, static_cast<double>(block.entry)));
	return result;
}

size_t
FeedReader::_read (float **out, uint32_t plane_count, size_t stride, size_t frames, double rate, int64_t expected, bool span, BlockInfo *block)
{
	const auto fill = [&] (uint32_t c, size_t from) {
		if (stride == 1) {
			std::fill(out[c] + from, out[c] + frames, 0.0f);
			return;
		}
		for (size_t i = from; i < frames; i++) { out[c][i * stride] = 0.0f; }
	};

	if (!_open) {
		for (uint32_t c = 0; c < plane_count; c++) { fill(c, 0); }
		return 0;
	}

	FeedHeader *header = _feed.header;
	const double start_position = _skipToStart();
	double position = start_position;

	ReadState state;
	_readState(header, position, _epoch, &state);

	size_t written = 0;
	const int channels = state.has ? state.entry.channels : 0;
	_channels = channels;
	const uint32_t used = std::min<uint32_t>(plane_count, static_cast<uint32_t>(std::max(0, channels)));
	if (state.has) {
		block->timestamp = state.entry.time + (position - static_cast<double>(state.entry.index)) / _rate;
		block->segment = state.entry.segment;
		block->entry = state.entry.slot;
	}
	const bool blocked = expected >= 0 && state.has && state.entry.slot != expected;

	const bool readable = !blocked && state.attached && state.has;
	const int64_t capacity = _block->capacity;
	while (readable && written < frames && state.limit > position) {
		if (rate == 1 && position == std::floor(position)) {
			const int64_t first = static_cast<int64_t>(position);
			const int64_t count = std::min<int64_t>(static_cast<int64_t>(frames - written), static_cast<int64_t>(state.limit) - first);
			for (uint32_t c = 0; c < used; c++) {
				const float *source = _block->plane(static_cast<int>(c));
				int64_t done = 0;
				while (done < count) {
					const int64_t at = (first + done) % capacity;
					const int64_t run = std::min(count - done, capacity - at);
					const size_t offset = written + static_cast<size_t>(done);
					if (stride == 1) {
						memcpy(out[c] + offset, source + at, static_cast<size_t>(run) * sizeof(float));
					}
					else {
						for (int64_t i = 0; i < run; i++) { out[c][(offset + static_cast<size_t>(i)) * stride] = source[at + i]; }
					}
					done += run;
				}
			}
			written += static_cast<size_t>(std::max<int64_t>(0, count));
			position += static_cast<double>(std::max<int64_t>(0, count));
		}
		else {
			const double limit = state.limit;
			const int64_t last = static_cast<int64_t>(std::ceil(limit)) - 1;
			size_t step = 0;
			for (; written < frames; written++, step++) {
				const double p = position + static_cast<double>(step) * rate;
				const int64_t index = static_cast<int64_t>(std::floor(p));
				if (index > last) { break; }
				const double fraction = p - static_cast<double>(index);
				const bool interpolate = fraction > 0 && index + 1 <= last;
				if (fraction > 0 && !interpolate && !state.hard) { break; }
				const int64_t at = index % capacity;
				const int64_t at_next = (index + 1) % capacity;
				for (uint32_t c = 0; c < used; c++) {
					const float *source = _block->plane(static_cast<int>(c));
					const float a = source[at];
					out[c][written * stride] = interpolate
						? static_cast<float>(a + (source[at_next] - a) * fraction)
						: a;
				}
			}
			position = std::min(limit, position + static_cast<double>(step) * rate);
		}

		if (!span || !state.at_entry || position < state.limit) { break; }
		ReadState next;
		_readState(header, position, _epoch, &next);
		if (!next.attached || !next.has || next.entry.channels != channels) { break; }
		state = next;
	}

	for (uint32_t c = 0; c < plane_count; c++) { fill(c, c < used ? written : 0); }

	if (position != start_position) {
		seqWrite(header->reader_seq, [&] () {
			header->consumed.store(position, std::memory_order_relaxed);
		});
	}

	const int64_t used_frames = state.write - static_cast<int64_t>(std::floor(position));
	if (capacity - used_frames >= capacity / 2 && header->writer_waiting.exchange(0)) {
		FeedHub::wakeWriter(header->id);
	}

	return written;
}

// A promise rather than a blocking read, because an offline reader may run on the thread that feeds the file's byte source.
Napi::Value
FeedReader::ready (const Napi::CallbackInfo &info)
{
	Napi::Env env = info.Env();
	const double frames = std::max(1.0, info[0].ToNumber().DoubleValue());
	const double rate = info[1].IsUndefined() ? 1.0 : info[1].ToNumber().DoubleValue();
	if (!std::isfinite(rate) || rate <= 0) {
		NAPI_THROW(Napi::RangeError::New(env, "rate must be a positive number"), Napi::Value());
	}
	if (!_open) { return Napi::Boolean::New(env, true); }

	FeedHeader *header = _feed.header;
	const double position = _skipToStart();

	ReadState state;
	_readState(header, position, _epoch, &state);
	if (!state.attached) { return Napi::Boolean::New(env, true); }
	if (!state.has) { return Napi::Boolean::New(env, false); }

	const double needed = std::min(
		(frames - 1) * rate + (rate == 1 && position == std::floor(position) ? 1 : 2),
		static_cast<double>(_block->capacity / 2));
	const int channels = state.entry.channels;
	const int64_t first_slot = state.entry.slot;
	double available = 0;
	double at = position;
	for (;;) {
		available += std::max(0.0, state.limit - at);
		if (available >= needed) { return Napi::Boolean::New(env, true); }
		if (!state.at_entry) { break; }
		at = state.limit;
		ReadState next;
		_readState(header, at, _epoch, &next);
		if (!next.attached || !next.has || next.entry.channels != channels) { return Napi::Boolean::New(env, true); }
		state = next;
	}
	if (state.hard) { return Napi::Boolean::New(env, true); }
	const int64_t count = header->log_count.load(std::memory_order_relaxed);
	return Napi::Boolean::New(env, count - first_slot >= FEED_LOG_SIZE - FEED_LOG_SPARE);
}

Napi::Value
FeedReader::wait (const Napi::CallbackInfo &info)
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
FeedReader::getChannels (const Napi::CallbackInfo &info)
{
	return Napi::Number::New(info.Env(), _channels);
}

Napi::Value
FeedReader::getEnded (const Napi::CallbackInfo &info)
{
	Napi::Env env = info.Env();
	if (!_open) { return Napi::Boolean::New(env, false); }
	FeedHeader *header = _feed.header;
	if (feedPending(header)) { return Napi::Boolean::New(env, false); }
	const double consumed = header->consumed.load(std::memory_order_relaxed);
	int64_t end = -1;
	bool attached = false;
	seqRead(header->writer_seq, [&] () {
		end = header->end_index.load(std::memory_order_relaxed);
		attached = header->attached.load(std::memory_order_relaxed) != 0;
	});
	return Napi::Boolean::New(env, attached && end >= 0 && consumed >= static_cast<double>(end) - 1e-9);
}

Napi::Value
FeedReader::getSeeking (const Napi::CallbackInfo &info)
{
	return Napi::Boolean::New(info.Env(), _open && feedSeeking(_feed.header));
}

Napi::Value
FeedReader::getError (const Napi::CallbackInfo &info)
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
FeedReader::close (const Napi::CallbackInfo &info)
{
	_close();
	return info.Env().Undefined();
}
