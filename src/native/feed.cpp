#include "feed.h"
#include <map>
#include <mutex>
#include <limits>
#include <algorithm>

namespace {

struct Link {
	const void *writer = nullptr;
	std::function<void ()> wake_writer;
	const void *reader = nullptr;
	std::function<void ()> wake_reader;
	FeedDataRef block;
	uint64_t epoch = 0;
};

std::atomic<uint64_t> next_feed_id { 1 };
std::mutex hub_mutex;
uint64_t next_epoch = 1;
std::map<uint64_t, Link> hub;

void
eraseIfEmpty (std::map<uint64_t, Link>::iterator it)
{
	if (!it->second.writer && !it->second.reader) { hub.erase(it); }
}

}

bool
FeedHub::setWriter (uint64_t id, const void *owner, std::function<void ()> wake)
{
	std::unique_lock<std::mutex> lock(hub_mutex);
	Link &link = hub[id];
	if (link.writer && link.writer != owner) { return false; }
	link.writer = owner;
	link.wake_writer = std::move(wake);
	return true;
}

bool
FeedHub::clearWriter (uint64_t id, const void *owner)
{
	std::unique_lock<std::mutex> lock(hub_mutex);
	auto it = hub.find(id);
	if (it == hub.end() || it->second.writer != owner) { return false; }
	it->second.writer = nullptr;
	it->second.wake_writer = nullptr;
	eraseIfEmpty(it);
	return true;
}

uint64_t
nextFeedId ()
{
	return next_feed_id.fetch_add(1);
}

uint64_t
FeedHub::setReader (uint64_t id, const void *owner, std::function<void ()> wake, FeedDataRef block)
{
	std::unique_lock<std::mutex> lock(hub_mutex);
	Link &link = hub[id];
	link.reader = owner;
	link.wake_reader = std::move(wake);
	link.block = std::move(block);
	link.epoch = next_epoch++;
	return link.epoch;
}

FeedDataRef
FeedHub::block (uint64_t id, uint64_t *epoch)
{
	std::unique_lock<std::mutex> lock(hub_mutex);
	auto it = hub.find(id);
	if (it == hub.end() || !it->second.block) { return nullptr; }
	*epoch = it->second.epoch;
	return it->second.block;
}

void
FeedHub::clearReader (uint64_t id, const void *owner)
{
	std::unique_lock<std::mutex> lock(hub_mutex);
	auto it = hub.find(id);
	if (it == hub.end() || it->second.reader != owner) { return; }
	it->second.reader = nullptr;
	it->second.wake_reader = nullptr;
	it->second.block = nullptr;
	eraseIfEmpty(it);
}

void
FeedHub::wakeWriter (uint64_t id)
{
	std::unique_lock<std::mutex> lock(hub_mutex);
	auto it = hub.find(id);
	if (it != hub.end() && it->second.wake_writer) { it->second.wake_writer(); }
}

void
FeedHub::wakeReader (uint64_t id)
{
	std::unique_lock<std::mutex> lock(hub_mutex);
	auto it = hub.find(id);
	if (it != hub.end() && it->second.wake_reader) { it->second.wake_reader(); }
}


bool
findEntry (FeedHeader *header, double position, FeedEntry *entry, int64_t *next_index)
{
	const int64_t count = header->log_count.load(std::memory_order_relaxed);
	if (count <= 0) { return false; }
	const int64_t oldest = std::max<int64_t>(0, count - FEED_LOG_SIZE);
	int64_t found = oldest;
	for (int64_t k = count - 1; k >= oldest; k--) {
		if (static_cast<double>(header->log[k % FEED_LOG_SIZE].index.load(std::memory_order_relaxed)) <= position) {
			found = k;
			break;
		}
	}
	const FeedLogEntry &source = header->log[found % FEED_LOG_SIZE];
	entry->index = source.index.load(std::memory_order_relaxed);
	entry->time = source.time.load(std::memory_order_relaxed);
	entry->generation = source.generation.load(std::memory_order_relaxed);
	entry->segment = source.segment.load(std::memory_order_relaxed);
	entry->rate = source.rate.load(std::memory_order_relaxed);
	entry->channels = source.channels.load(std::memory_order_relaxed);
	entry->epoch = source.epoch.load(std::memory_order_relaxed);
	entry->file = source.file.load(std::memory_order_relaxed);
	entry->slot = found;
	*next_index = found + 1 < count
		? header->log[(found + 1) % FEED_LOG_SIZE].index.load(std::memory_order_relaxed)
		: std::numeric_limits<int64_t>::max();
	return true;
}

