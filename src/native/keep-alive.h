#ifndef _MEDIA_DECODERS_KEEP_ALIVE_H_
#define _MEDIA_DECODERS_KEEP_ALIVE_H_

#include <memory>

class KeepAlive {
public:
	virtual ~KeepAlive () = default;
};

using KeepAliveToken = std::unique_ptr<KeepAlive>;

#endif // _MEDIA_DECODERS_KEEP_ALIVE_H_
