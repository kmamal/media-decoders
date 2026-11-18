#ifndef _MEDIA_DECODERS_VIDEO_FEED_H_
#define _MEDIA_DECODERS_VIDEO_FEED_H_

#include "feed.h"
#include "video-output.h"
#include <mutex>
#include <memory>
#include <vector>

static constexpr uint32_t VIDEO_FEED_MAGIC = 0x6d647076;
static constexpr int VIDEO_FEED_MAX_FRAMES = 1024;

enum class ReadMode : int32_t {
	None = 0,
	Next = 1,
	At = 2,
};

struct VideoFeedHeader {
	uint32_t magic;
	uint64_t id;

	std::atomic<uint32_t> writer_seq;
	std::atomic<int32_t> attached;
	std::atomic<int64_t> generation;
	std::atomic<uint64_t> file;
	std::atomic<int64_t> segment;
	std::atomic<int32_t> ended;
	std::atomic<int64_t> end_segment;
	std::atomic<double> end_time;
	std::atomic<int32_t> error_code;
	std::atomic<char> error_message[FEED_MESSAGE_SIZE];

	std::atomic<int64_t> requested;
	std::atomic<int64_t> seek_requested;
	std::atomic<int64_t> applied;

	std::atomic<uint32_t> reader_seq;
	std::atomic<uint64_t> epoch;
	std::atomic<int32_t> reader_open;
	std::atomic<int32_t> mode;
	std::atomic<int32_t> has_position;
	std::atomic<uint64_t> position_file;
	std::atomic<int64_t> position_segment;
	std::atomic<double> position_time;

	std::atomic<int32_t> writer_waiting;
	std::atomic<int32_t> reader_waiting;
};

static constexpr size_t VIDEO_FEED_HEADER_SIZE = (sizeof(VideoFeedHeader) + 63) & ~static_cast<size_t>(63);

struct VideoFeedView {
	VideoFeedHeader *header = nullptr;
};

void initVideoFeedHeader (VideoFeedHeader *header);

enum : int32_t {
	SLOT_FREE = 0,
	SLOT_WRITING = 1,
	SLOT_READY = 2,
	SLOT_LEASED = 3,
};

struct VideoSlot {
	std::atomic<int32_t> state { SLOT_FREE };
	std::atomic<int64_t> number { 0 };
	std::atomic<int64_t> segment { 0 };
	std::atomic<double> timestamp { 0 };
	std::atomic<double> duration { 0 };
	uint8_t *data = nullptr;
	OutFrame frame;

	void store (const OutFrame &value);
};

struct VideoBlock : FeedData {
	static constexpr FeedKind KIND = FeedKind::Video;

	VideoBlock (const FrameLayout &layout, const std::vector<uint8_t *> &data);

	const FrameLayout layout;
	const int count;
	std::unique_ptr<VideoSlot[]> slots;
	std::mutex mutex;
	bool alive = true;

	int leaseNext ();
	bool hasReady ();
	bool release (int slot);
};

using VideoBlockRef = std::shared_ptr<VideoBlock>;

#endif // _MEDIA_DECODERS_VIDEO_FEED_H_
