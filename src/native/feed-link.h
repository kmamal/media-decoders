#ifndef _MEDIA_DECODERS_FEED_LINK_H_
#define _MEDIA_DECODERS_FEED_LINK_H_

#include <cstdint>
#include <string>

class FeedLink {
public:
	virtual ~FeedLink () = default;

	virtual bool attached () const = 0;
	virtual bool finished () const = 0;
	virtual uint64_t id () const = 0;
	virtual bool detach (bool owned) = 0;
	virtual void reset (double time, int64_t segment, bool drop, double duration) = 0;
	virtual void reopen () = 0;
	virtual void request (int64_t serial, int64_t seek_serial) = 0;
	virtual void applied (int64_t serial) = 0;
	virtual void finish () = 0;
	virtual bool finishFailed (int code, const std::string &message) = 0;
	virtual bool takeReaderNotify () = 0;
	virtual void armWaiting () = 0;
};

#endif // _MEDIA_DECODERS_FEED_LINK_H_
