#ifndef _MEDIA_DECODERS_BYTE_SOURCE_STATE_H_
#define _MEDIA_DECODERS_BYTE_SOURCE_STATE_H_

#include <map>
#include <vector>
#include <mutex>
#include <string>
#include <cstdint>
#include <functional>
#include <condition_variable>

class ByteSourceState {
public:
	std::mutex mutex;
	std::condition_variable cond;

	bool random_access = false;
	int64_t size = -1;
	int64_t ahead_limit = 0;
	int64_t behind_limit = 0;

	std::map<int64_t, std::vector<uint8_t>> chunks;
	int64_t position = 0;
	int64_t stream_end = 0;
	int64_t requested = -1;
	bool full = false;
	bool closed = false;
	std::string error;

	bool request_pending = false;
	bool space_pending = false;
	std::function<void ()> notify;
	std::function<void ()> on_close;

	int64_t max_chunk = 0;

	int read (uint8_t *buffer, int length);
	int64_t seek (int64_t offset, int whence);
	void close ();
	void evict ();

private:
	bool _find (int64_t offset, const uint8_t **data, int64_t *length);
	void _notify ();
	void _checkSpace ();
};

#endif // _MEDIA_DECODERS_BYTE_SOURCE_STATE_H_
