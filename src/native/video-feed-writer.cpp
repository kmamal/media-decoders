#include "video-feed-writer.h"
#include "time-epsilon.h"


void
VideoFeedWriter::attach (const VideoFeedView &view, KeepAliveToken keep_alive, uint64_t file, int64_t segment, int display_width, int display_height)
{
	_feed = view;
	_keep_alive = std::move(keep_alive);
	_id = view.header->id;
	_file = file;
	_display_width = display_width;
	_display_height = display_height;
	_attached = true;
	_finished = false;
	_failure_written = false;
	_block.reset();
	_epoch = 0;
	_end_segment = -1;
	_end_time = 0;
	_previous_end_segment = -1;
	_previous_end_time = 0;
	VideoFeedHeader *header = view.header;
	seqWrite(header->writer_seq, [&] () {
		_generation = header->generation.load(std::memory_order_relaxed) + 1;
		header->generation.store(_generation, std::memory_order_relaxed);
		header->attached.store(1, std::memory_order_relaxed);
		header->file.store(file, std::memory_order_relaxed);
		header->segment.store(segment, std::memory_order_relaxed);
		header->ended.store(0, std::memory_order_relaxed);
		header->error_code.store(0, std::memory_order_relaxed);
		header->error_message[0].store(0, std::memory_order_relaxed);
	});
	_wakeReader();
}

bool
VideoFeedWriter::detach (bool owned)
{
	bool wake = false;
	if (owned) {
		VideoFeedHeader *header = _feed.header;
		seqWrite(header->writer_seq, [&] () {
			header->attached.store(0, std::memory_order_relaxed);
		});
		wake = header->reader_waiting.exchange(0) != 0;
	}
	if (_block) {
		for (int i = 0; i < _block->count; i++) {
			int32_t expected = SLOT_READY;
			_block->slots[i].state.compare_exchange_strong(expected, SLOT_FREE, std::memory_order_acq_rel);
		}
	}
	_attached = false;
	_keep_alive.reset();
	_block.reset();
	return wake;
}

void
VideoFeedWriter::reset (double, int64_t segment, bool, double)
{
	VideoFeedHeader *header = _feed.header;
	seqWrite(header->writer_seq, [&] () {
		header->segment.store(segment, std::memory_order_relaxed);
		header->ended.store(0, std::memory_order_relaxed);
	});
	_finished = false;
	_wakeReader();
}

void
VideoFeedWriter::reopen ()
{
	if (!_finished) { return; }
	VideoFeedHeader *header = _feed.header;
	seqWrite(header->writer_seq, [&] () {
		header->ended.store(0, std::memory_order_relaxed);
	});
	_finished = false;
	_wakeReader();
}

void
VideoFeedWriter::request (int64_t serial, int64_t seek_serial)
{
	VideoFeedHeader *header = _feed.header;
	header->seek_requested.store(seek_serial, std::memory_order_release);
	header->requested.store(serial, std::memory_order_release);
}

void
VideoFeedWriter::applied (int64_t serial)
{
	VideoFeedHeader *header = _feed.header;
	if (header->applied.load(std::memory_order_relaxed) == serial) { return; }
	header->applied.store(serial, std::memory_order_release);
	_wakeReader();
}

void
VideoFeedWriter::finish ()
{
	VideoFeedHeader *header = _feed.header;
	seqWrite(header->writer_seq, [&] () {
		header->end_segment.store(_end_segment, std::memory_order_relaxed);
		header->end_time.store(_end_time, std::memory_order_relaxed);
		header->ended.store(1, std::memory_order_relaxed);
	});
	_finished = true;
	_wakeReader();
}

bool
VideoFeedWriter::finishFailed (int code, const std::string &message)
{
	if (!_failure_written) {
		_failure_written = true;
		writeFeedError(_feed.header, code, message);
	}
	finish();
	return true;
}

bool
VideoFeedWriter::takeReaderNotify ()
{
	const bool notify = _notify_reader;
	_notify_reader = false;
	return notify;
}

void
VideoFeedWriter::armWaiting ()
{
	_feed.header->writer_waiting.store(1);
}

void
VideoFeedWriter::_wakeReader ()
{
	if (_feed.header->reader_waiting.exchange(0)) { _notify_reader = true; }
}

uint64_t
VideoFeedWriter::_readerEpoch ()
{
	VideoFeedHeader *header = _feed.header;
	uint64_t epoch = 0;
	seqRead(header->reader_seq, [&] () {
		epoch = header->epoch.load(std::memory_order_relaxed);
	});
	return epoch;
}

bool
VideoFeedWriter::readerChanged ()
{
	if (!_attached || !_feed.header->reader_open.load()) { return false; }
	return _readerEpoch() != _epoch;
}

bool
VideoFeedWriter::takeReaderChange ()
{
	if (!readerChanged()) { return false; }
	uint64_t epoch = 0;
	VideoBlockRef block = feedDataAs<VideoBlock>(FeedHub::block(_id, &epoch));
	if (!block || epoch == _epoch) { return false; }
	const bool changed = _block != nullptr;
	_block = std::move(block);
	_epoch = epoch;
	return changed;
}

bool
VideoFeedWriter::_active ()
{
	if (!_attached || !_block || !_feed.header->reader_open.load()) { return false; }
	return _readerEpoch() == _epoch;
}

bool
VideoFeedWriter::hasFree ()
{
	if (!_active()) { return false; }
	for (int i = 0; i < _block->count; i++) {
		if (_block->slots[i].state.load(std::memory_order_acquire) == SLOT_FREE) { return true; }
	}
	return false;
}

int
VideoFeedWriter::acquire ()
{
	if (!_active()) { return -1; }
	for (int i = 0; i < _block->count; i++) {
		int32_t expected = SLOT_FREE;
		if (_block->slots[i].state.compare_exchange_strong(expected, SLOT_WRITING, std::memory_order_acq_rel)) { return i; }
	}
	return -1;
}

void
VideoFeedWriter::publish (int slot, OutFrame &frame)
{
	frame.buffer = slot;
	frame.number = _number++;
	frame.file = _file;
	frame.display_width = _display_width;
	frame.display_height = _display_height;
	VideoSlot &target = _block->slots[slot];
	target.store(frame);
	target.state.store(SLOT_READY, std::memory_order_release);
	noteEnd(frame.segment, frame.timestamp + frame.duration);
	_wakeReader();
}

bool
VideoFeedWriter::isReady (const OutFrame &frame) const
{
	if (!_block || frame.buffer < 0 || frame.buffer >= _block->count) { return false; }
	const VideoSlot &slot = _block->slots[frame.buffer];
	return slot.state.load(std::memory_order_acquire) == SLOT_READY && slot.frame.number == frame.number;
}

void
VideoFeedWriter::takeBack (const OutFrame &frame)
{
	if (!isReady(frame)) { return; }
	int32_t expected = SLOT_READY;
	if (_block->slots[frame.buffer].state.compare_exchange_strong(expected, SLOT_FREE, std::memory_order_acq_rel)) {
		_wakeReader();
	}
}

bool
VideoFeedWriter::relabel (const OutFrame &frame, int64_t segment)
{
	if (!isReady(frame)) { return false; }
	VideoSlot &slot = _block->slots[frame.buffer];
	int32_t expected = SLOT_READY;
	if (!slot.state.compare_exchange_strong(expected, SLOT_WRITING, std::memory_order_acq_rel)) { return false; }
	OutFrame value = slot.frame;
	value.segment = segment;
	slot.store(value);
	slot.state.store(SLOT_READY, std::memory_order_release);
	return true;
}

bool
VideoFeedWriter::behindReader (int64_t segment, double end)
{
	if (!_attached) { return false; }
	VideoFeedHeader *header = _feed.header;
	bool has = false;
	int64_t position_segment = 0;
	double position_time = 0;
	seqRead(header->reader_seq, [&] () {
		has = header->has_position.load(std::memory_order_relaxed) != 0
			&& header->mode.load(std::memory_order_relaxed) == static_cast<int32_t>(ReadMode::At)
			&& header->position_file.load(std::memory_order_relaxed) == _file;
		position_segment = header->position_segment.load(std::memory_order_relaxed);
		position_time = header->position_time.load(std::memory_order_relaxed);
	});
	if (!has) { return false; }
	return segment < position_segment || (segment == position_segment && end <= position_time + TIME_EPSILON);
}

void
VideoFeedWriter::noteEnd (int64_t segment, double end)
{
	if (segment != _end_segment) {
		_previous_end_segment = _end_segment;
		_previous_end_time = _end_time;
	}
	_end_segment = segment;
	_end_time = end;
}

void
VideoFeedWriter::cutAfter (int64_t segment)
{
	if (!_attached || _finished) { return; }
	if (_end_segment > segment) {
		_end_segment = _previous_end_segment;
		_end_time = _previous_end_time;
	}
	finish();
}
