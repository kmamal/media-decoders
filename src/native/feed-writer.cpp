#include "feed-writer.h"
#include "time-epsilon.h"
#include <cmath>
#include <cstring>
#include <algorithm>


void
FeedWriter::attach (const FeedView &view, KeepAliveToken keep_alive, uint64_t file, bool silent, double time, int64_t segment, double duration)
{
	_feed = view;
	_keep_alive = std::move(keep_alive);
	_id = view.header->id;
	_file = file;
	_attached = true;
	_silent = silent;
	_block.reset();
	_epoch = 0;
	_ring_rate = 0;
	_channels = silent ? 1 : 0;
	_has_entry = false;
	_failure_written = false;
	reset(time, segment, true, duration);
	seqWrite(view.header->writer_seq, [&] () {
		_generation = view.header->generation.load(std::memory_order_relaxed) + 1;
		view.header->generation.store(_generation, std::memory_order_relaxed);
		view.header->attached.store(1, std::memory_order_relaxed);
		view.header->error_code.store(0, std::memory_order_relaxed);
		view.header->error_message[0].store(0, std::memory_order_relaxed);
	});
}

bool
FeedWriter::detach (bool owned)
{
	bool wake = false;
	if (owned) {
		FeedHeader *header = _feed.header;
		seqWrite(header->writer_seq, [&] () {
			header->attached.store(0, std::memory_order_relaxed);
		});
		wake = header->reader_waiting.exchange(0) != 0;
	}
	_attached = false;
	_keep_alive.reset();
	_block.reset();
	return wake;
}

bool
FeedWriter::cutAtLoop (int64_t *segment)
{
	if (_loop_boundary < 0 || _finished) { return false; }
	FeedHeader *header = _feed.header;
	double consumed = 0;
	seqRead(header->reader_seq, [&] () {
		consumed = header->consumed.load(std::memory_order_relaxed);
	});
	consumed = std::max(consumed, static_cast<double>(header->start_index.load(std::memory_order_relaxed)));
	if (consumed >= static_cast<double>(_loop_boundary)) { return false; }
	int64_t boundary = _loop_boundary;
	const int64_t count = header->log_count.load(std::memory_order_relaxed);
	const int64_t oldest = std::max<int64_t>(0, count - FEED_LOG_SIZE);
	for (int64_t k = oldest + 1; k < count; k++) {
		const FeedLogEntry &entry = header->log[k % FEED_LOG_SIZE];
		const int64_t index = entry.index.load(std::memory_order_relaxed);
		if (static_cast<double>(index) <= consumed || index >= boundary) { continue; }
		const int64_t previous = header->log[(k - 1) % FEED_LOG_SIZE].segment.load(std::memory_order_relaxed);
		if (entry.segment.load(std::memory_order_relaxed) != previous) {
			boundary = index;
			break;
		}
	}
	int64_t cut = count;
	for (int64_t k = oldest; k < count; k++) {
		if (header->log[k % FEED_LOG_SIZE].index.load(std::memory_order_relaxed) >= boundary) {
			cut = k;
			break;
		}
	}
	if (cut <= oldest) { return false; }
	*segment = header->log[(cut - 1) % FEED_LOG_SIZE].segment.load(std::memory_order_relaxed);

	seqWrite(header->writer_seq, [&] () {
		header->log_count.store(cut, std::memory_order_relaxed);
		header->write_index.store(boundary, std::memory_order_relaxed);
		header->end_index.store(boundary, std::memory_order_relaxed);
	});
	if (header->reader_waiting.exchange(0)) { _notify_reader = true; }

	_silence_until = -1;
	_loop_ended = true;
	_finished = true;
	return true;
}

void
FeedWriter::resumeLoop ()
{
	if (!_loop_ended) { return; }
	_publishEnd(-1);
	_loop_ended = false;
	_finished = false;
}

void
FeedWriter::reopen ()
{
	if (!_finished) { return; }
	_publishEnd(-1);
	_loop_ended = false;
	_finished = false;
}

void
FeedWriter::request (int64_t serial, int64_t seek_serial)
{
	FeedHeader *header = _feed.header;
	header->seek_requested.store(seek_serial, std::memory_order_release);
	header->requested.store(serial, std::memory_order_release);
}

void
FeedWriter::applied (int64_t serial)
{
	FeedHeader *header = _feed.header;
	if (header->applied.load(std::memory_order_relaxed) == serial) { return; }
	header->applied.store(serial, std::memory_order_release);
	if (header->reader_waiting.exchange(0)) { _notify_reader = true; }
}

bool
FeedWriter::active ()
{
	if (!_attached || _finished || _ring_rate <= 0) { return false; }
	FeedHeader *header = _feed.header;
	if (!header->reader_open.load()) { return false; }
	uint64_t epoch = 0;
	seqRead(header->reader_seq, [&] () {
		epoch = header->epoch.load(std::memory_order_relaxed);
	});
	return epoch == _epoch;
}

bool
FeedWriter::takeReaderChange ()
{
	if (!_attached) { return false; }
	FeedHeader *header = _feed.header;
	if (!header->reader_open.load()) { return false; }
	uint64_t epoch = 0;
	seqRead(header->reader_seq, [&] () {
		epoch = header->epoch.load(std::memory_order_relaxed);
	});
	if (epoch == _epoch) { return false; }
	FeedBlockRef block = feedDataAs<FeedBlock>(FeedHub::block(_id, &epoch));
	if (!block || epoch == _epoch) { return false; }
	const bool changed = _block && _has_entry;
	_block = std::move(block);
	_epoch = epoch;
	_ring_rate = _block->rate;
	if (_silent) { _channels = _silentChannels(); }
	return changed;
}

int
FeedWriter::outputChannels (int source) const
{
	if (!_block) { return source; }
	return _block->fixed ? _block->channels : std::min(source, _block->channels);
}

bool
FeedWriter::takeReaderNotify ()
{
	const bool notify = _notify_reader;
	_notify_reader = false;
	return notify;
}

void
FeedWriter::armWaiting ()
{
	_feed.header->writer_waiting.store(1);
}

int64_t
FeedWriter::freeFrames ()
{
	if (!_block) { return 0; }
	const int64_t capacity = _block->capacity;
	FeedHeader *header = _feed.header;
	double consumed = 0;
	seqRead(header->reader_seq, [&] () {
		consumed = header->consumed.load(std::memory_order_relaxed);
	});
	const int64_t write = header->write_index.load(std::memory_order_relaxed);
	const int64_t used = write - static_cast<int64_t>(std::floor(consumed));
	return std::clamp<int64_t>(capacity - used, 0, capacity);
}

double
FeedWriter::_writtenTime ()
{
	if (_entry_pending || !_has_entry) { return _entry_pending_time; }
	const int64_t write = _feed.header->write_index.load(std::memory_order_relaxed);
	return _entry_time + static_cast<double>(write - _entry_index) / _ring_rate;
}

double
FeedWriter::consumedTime (double fallback)
{
	FeedHeader *header = _feed.header;
	double consumed = 0;
	seqRead(header->reader_seq, [&] () {
		consumed = header->consumed.load(std::memory_order_relaxed);
	});
	consumed = std::max(consumed, static_cast<double>(header->start_index.load(std::memory_order_relaxed)));
	if (_entry_pending && consumed >= static_cast<double>(header->write_index.load(std::memory_order_relaxed))) { return _entry_pending_time; }
	FeedEntry entry;
	int64_t next = 0;
	if (!findEntry(header, consumed, &entry, &next) || entry.rate <= 0) { return fallback; }
	const double offset = std::max(0.0, consumed - static_cast<double>(entry.index));
	return std::max(0.0, entry.time + offset / entry.rate);
}

int64_t
FeedWriter::silenceRemaining ()
{
	if (_silence_until < 0) { return 0; }
	const double remaining = _silence_until - _writtenTime();
	if (remaining <= TIME_EPSILON) { return 0; }
	if (_ring_rate <= 0) { return 1; }
	return std::max<int64_t>(0, std::llround(remaining * _ring_rate));
}

void
FeedWriter::reset (double time, int64_t segment, bool drop, double duration)
{
	FeedHeader *header = _feed.header;
	_entry_pending = true;
	_entry_pending_time = time;
	_entry_segment = segment;
	_silence_until = _silent ? duration : -1;
	_finished = false;
	_loop_ended = false;

	const int64_t write = header->write_index.load(std::memory_order_relaxed);
	_loop_boundary = drop ? -1 : write;
	seqWrite(header->writer_seq, [&] () {
		if (drop) { header->start_index.store(write, std::memory_order_relaxed); }
		header->end_index.store(-1, std::memory_order_relaxed);
	});
	if (header->reader_waiting.exchange(0)) { _notify_reader = true; }
}

void
FeedWriter::_publishEnd (int64_t index)
{
	FeedHeader *header = _feed.header;
	seqWrite(header->writer_seq, [&] () {
		header->end_index.store(index, std::memory_order_relaxed);
	});
	if (header->reader_waiting.exchange(0)) { _notify_reader = true; }
}

void
FeedWriter::finish ()
{
	FeedHeader *header = _feed.header;
	const int64_t write = header->write_index.load(std::memory_order_relaxed);
	const bool append = _entry_pending && _ring_rate > 0 && _channels > 0;
	seqWrite(header->writer_seq, [&] () {
		if (append) { _storeEntry(write); }
		header->end_index.store(write, std::memory_order_relaxed);
	});
	if (append) { _entryStored(write); }
	if (header->reader_waiting.exchange(0)) { _notify_reader = true; }
	_finished = true;
}

bool
FeedWriter::finishFailed (int code, const std::string &message)
{
	if (!_failure_written) {
		_failure_written = true;
		FeedHeader *header = _feed.header;
		writeFeedError(header, code, message);
		if (header->reader_waiting.exchange(0)) { _notify_reader = true; }
	}
	if (_ring_rate <= 0) { return false; }
	if (_channels <= 0) { _channels = _silentChannels(); }
	finish();
	return true;
}

void
FeedWriter::_storeEntry (int64_t write)
{
	FeedHeader *header = _feed.header;
	const int64_t slot = header->log_count.load(std::memory_order_relaxed);
	FeedLogEntry &entry = header->log[slot % FEED_LOG_SIZE];
	entry.index.store(write, std::memory_order_relaxed);
	entry.time.store(_entry_pending_time, std::memory_order_relaxed);
	entry.generation.store(_generation, std::memory_order_relaxed);
	entry.segment.store(_entry_segment, std::memory_order_relaxed);
	entry.rate.store(_ring_rate, std::memory_order_relaxed);
	entry.channels.store(_channels, std::memory_order_relaxed);
	entry.epoch.store(_epoch, std::memory_order_relaxed);
	entry.file.store(_file, std::memory_order_relaxed);
	header->log_count.store(slot + 1, std::memory_order_relaxed);
}

void
FeedWriter::_entryStored (int64_t write)
{
	_entry_pending = false;
	_has_entry = true;
	_entry_index = write;
	_entry_time = _entry_pending_time;
}

bool
FeedWriter::_logFull ()
{
	FeedHeader *header = _feed.header;
	double consumed = 0;
	seqRead(header->reader_seq, [&] () {
		consumed = header->consumed.load(std::memory_order_relaxed);
	});
	consumed = std::max(consumed, static_cast<double>(header->start_index.load(std::memory_order_relaxed)));
	FeedEntry entry;
	int64_t next = 0;
	if (!findEntry(header, consumed, &entry, &next)) { return false; }
	return header->log_count.load(std::memory_order_relaxed) - entry.slot >= FEED_LOG_SIZE - FEED_LOG_SPARE;
}

void
FeedWriter::setChannels (int count, int64_t segment)
{
	if (count == _channels) { return; }
	if (_has_entry && !_entry_pending) {
		_entry_pending_time = _writtenTime();
		_entry_pending = true;
		_entry_segment = segment;
	}
	_channels = count;
}

int64_t
FeedWriter::write (const float *const *source, int64_t count)
{
	FeedHeader *header = _feed.header;
	count = std::min(count, freeFrames());
	if (count <= 0 || _channels <= 0) { return 0; }
	const bool append = _entry_pending || !_has_entry;
	if (append && _logFull()) { return 0; }

	const int64_t write = header->write_index.load(std::memory_order_relaxed);
	const int64_t capacity = _block->capacity;
	const int channels = std::min(_channels, _block->channels);
	for (int c = 0; c < channels; c++) {
		float *plane = _block->plane(c);
		int64_t done = 0;
		while (done < count) {
			const int64_t at = (write + done) % capacity;
			const int64_t run = std::min(count - done, capacity - at);
			if (source) { memcpy(plane + at, source[c] + done, static_cast<size_t>(run) * sizeof(float)); }
			else { std::fill_n(plane + at, run, 0.0f); }
			done += run;
		}
	}

	seqWrite(header->writer_seq, [&] () {
		if (append) { _storeEntry(write); }
		header->write_index.store(write + count, std::memory_order_relaxed);
	});
	if (append) { _entryStored(write); }
	if (header->reader_waiting.exchange(0)) { _notify_reader = true; }
	return count;
}

int64_t
FeedWriter::writeSilence ()
{
	if (_channels <= 0) { _channels = _silentChannels(); }
	return write(nullptr, silenceRemaining());
}
