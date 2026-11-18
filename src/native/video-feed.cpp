#include "video-feed.h"
#include <new>


void
initVideoFeedHeader (VideoFeedHeader *header)
{
	new (header) VideoFeedHeader();
	header->id = nextFeedId();
	header->segment.store(-1);
	header->end_segment.store(-1);
	header->magic = VIDEO_FEED_MAGIC;
}

VideoBlock::VideoBlock (const FrameLayout &layout, const std::vector<uint8_t *> &data)
	: FeedData(KIND)
	, layout(layout)
	, count(static_cast<int>(data.size()))
	, slots(new VideoSlot[data.size()])
{
	for (int i = 0; i < count; i++) { slots[i].data = data[i]; }
}

void
VideoSlot::store (const OutFrame &value)
{
	frame = value;
	number.store(value.number, std::memory_order_relaxed);
	segment.store(value.segment, std::memory_order_relaxed);
	timestamp.store(value.timestamp, std::memory_order_relaxed);
	duration.store(value.duration, std::memory_order_relaxed);
}

int
VideoBlock::leaseNext ()
{
	for (;;) {
		int best = -1;
		int64_t number = 0;
		for (int i = 0; i < count; i++) {
			if (slots[i].state.load(std::memory_order_acquire) != SLOT_READY) { continue; }
			const int64_t candidate = slots[i].number.load(std::memory_order_relaxed);
			if (best < 0 || candidate < number) {
				best = i;
				number = candidate;
			}
		}
		if (best < 0) { return -1; }
		int32_t expected = SLOT_READY;
		if (slots[best].state.compare_exchange_strong(expected, SLOT_LEASED, std::memory_order_acq_rel)) { return best; }
	}
}

bool
VideoBlock::hasReady ()
{
	for (int i = 0; i < count; i++) {
		if (slots[i].state.load(std::memory_order_acquire) == SLOT_READY) { return true; }
	}
	return false;
}

bool
VideoBlock::release (int slot)
{
	if (slot < 0 || slot >= count) { return false; }
	int32_t expected = SLOT_LEASED;
	return slots[slot].state.compare_exchange_strong(expected, SLOT_FREE, std::memory_order_acq_rel);
}
