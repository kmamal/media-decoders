#ifndef _MEDIA_DECODERS_FEED_H_
#define _MEDIA_DECODERS_FEED_H_

#include <atomic>
#include <algorithm>
#include <string>
#include <cstdint>
#include <functional>
#include <memory>
#include <vector>
#include <thread>

static constexpr uint32_t FEED_MAX_CHANNELS = 512;
static constexpr int64_t FEED_MIN_FRAMES = 256;
static constexpr int64_t FEED_MAX_SAMPLES = int64_t(1) << 28;
static constexpr int FEED_LOG_SIZE = 64;
static constexpr int FEED_LOG_SPARE = 8;
static constexpr int FEED_MESSAGE_SIZE = 128;
static constexpr uint32_t FEED_MAGIC = 0x6d647074;

struct FeedLogEntry {
	std::atomic<int64_t> index;
	std::atomic<double> time;
	std::atomic<int64_t> generation;
	std::atomic<int64_t> segment;
	std::atomic<int32_t> rate;
	std::atomic<int32_t> channels;
	std::atomic<uint64_t> epoch;
	std::atomic<uint64_t> file;
};

// Private layout: both sides go through addon calls, so there is no protocol for anyone else to implement.
// Each of the two writers (the file's thread and the reader) has its own sequence counter,
// so readers on other threads retry instead of taking a lock.
struct FeedHeader {
	uint32_t magic;
	uint64_t id;

	std::atomic<uint32_t> writer_seq;
	std::atomic<int64_t> write_index;
	std::atomic<int64_t> start_index;
	std::atomic<int64_t> end_index;
	std::atomic<int32_t> attached;
	std::atomic<int64_t> generation;
	std::atomic<int64_t> log_count;
	FeedLogEntry log[FEED_LOG_SIZE];
	std::atomic<int32_t> error_code;
	std::atomic<char> error_message[FEED_MESSAGE_SIZE];

	std::atomic<int64_t> requested;
	std::atomic<int64_t> seek_requested;
	std::atomic<int64_t> applied;

	std::atomic<uint32_t> reader_seq;
	std::atomic<double> consumed;
	std::atomic<uint64_t> epoch;
	std::atomic<int32_t> reader_open;

	std::atomic<int32_t> writer_waiting;
	std::atomic<int32_t> reader_waiting;
};

static_assert(std::atomic<double>::is_always_lock_free, "atomic doubles must be lock free");
static_assert(std::atomic<int64_t>::is_always_lock_free, "atomic int64 must be lock free");

static constexpr size_t FEED_HEADER_SIZE = (sizeof(FeedHeader) + 63) & ~static_cast<size_t>(63);
static constexpr size_t FEED_USER_SIZE = 256;

template <typename F>
inline void
seqWrite (std::atomic<uint32_t> &seq, F &&write)
{
	const uint32_t value = seq.load(std::memory_order_relaxed);
	seq.store(value + 1, std::memory_order_relaxed);
	std::atomic_thread_fence(std::memory_order_release);
	write();
	seq.store(value + 2, std::memory_order_release);
}

template <typename F>
inline void
seqRead (const std::atomic<uint32_t> &seq, F &&read)
{
	for (;;) {
		const uint32_t before = seq.load(std::memory_order_acquire);
		if (before & 1) {
			std::this_thread::yield();
			continue;
		}
		read();
		std::atomic_thread_fence(std::memory_order_acquire);
		if (seq.load(std::memory_order_relaxed) == before) { return; }
	}
}

struct FeedView {
	FeedHeader *header = nullptr;
};

template <typename Header>
inline bool
feedPending (const Header *header)
{
	const int64_t requested = header->requested.load(std::memory_order_acquire);
	return header->applied.load(std::memory_order_acquire) < requested;
}

template <typename Header>
inline bool
feedSeeking (const Header *header)
{
	const int64_t requested = header->seek_requested.load(std::memory_order_acquire);
	return header->applied.load(std::memory_order_acquire) < requested;
}

template <typename Header>
inline void
writeFeedError (Header *header, int code, const std::string &message)
{
	size_t length = std::min(message.size(), static_cast<size_t>(FEED_MESSAGE_SIZE - 1));
	while (length > 0 && length < message.size() && (static_cast<unsigned char>(message[length]) & 0xc0) == 0x80) { length -= 1; }
	seqWrite(header->writer_seq, [&] () {
		header->error_code.store(code, std::memory_order_relaxed);
		for (size_t i = 0; i < length; i++) { header->error_message[i].store(message[i], std::memory_order_relaxed); }
		header->error_message[length].store(0, std::memory_order_relaxed);
	});
}

template <typename Header>
inline int
readFeedError (Header *header, std::string *message)
{
	int32_t code = 0;
	char buffer[FEED_MESSAGE_SIZE];
	seqRead(header->writer_seq, [&] () {
		code = header->error_code.load(std::memory_order_relaxed);
		for (int i = 0; i < FEED_MESSAGE_SIZE; i++) { buffer[i] = header->error_message[i].load(std::memory_order_relaxed); }
	});
	buffer[FEED_MESSAGE_SIZE - 1] = 0;
	*message = buffer;
	return code;
}

enum class FeedKind {
	Audio,
	Video,
};

struct FeedData {
	explicit FeedData (FeedKind kind) : kind(kind) {}
	virtual ~FeedData () = default;

	const FeedKind kind;
};

using FeedDataRef = std::shared_ptr<FeedData>;

template <typename Data>
inline std::shared_ptr<Data>
feedDataAs (const FeedDataRef &data)
{
	if (!data || data->kind != Data::KIND) { return nullptr; }
	return std::static_pointer_cast<Data>(data);
}

struct FeedBlock : FeedData {
	static constexpr FeedKind KIND = FeedKind::Audio;

	FeedBlock (int channels, bool fixed, int rate, int64_t capacity)
		: FeedData(KIND)
		, channels(channels)
		, fixed(fixed)
		, rate(rate)
		, capacity(capacity)
		, samples(static_cast<size_t>(channels) * static_cast<size_t>(capacity))
	{}

	const int channels;
	const bool fixed;
	const int rate;
	const int64_t capacity;
	std::vector<float> samples;

	float *plane (int channel) { return samples.data() + static_cast<size_t>(channel) * static_cast<size_t>(capacity); }
};

using FeedBlockRef = std::shared_ptr<FeedBlock>;

struct FeedEntry {
	int64_t index = 0;
	double time = 0;
	int64_t generation = -1;
	int64_t segment = -1;
	int rate = 0;
	int channels = 0;
	uint64_t epoch = 0;
	uint64_t file = 0;
	int64_t slot = -1;
};

bool findEntry (FeedHeader *header, double position, FeedEntry *entry, int64_t *next_index);
uint64_t nextFeedId ();

namespace FeedHub {
	bool setWriter (uint64_t id, const void *owner, std::function<void ()> wake);
	bool clearWriter (uint64_t id, const void *owner);
	uint64_t setReader (uint64_t id, const void *owner, std::function<void ()> wake, FeedDataRef block);
	FeedDataRef block (uint64_t id, uint64_t *epoch);
	void clearReader (uint64_t id, const void *owner);
	void wakeWriter (uint64_t id);
	void wakeReader (uint64_t id);
}

#endif // _MEDIA_DECODERS_FEED_H_
