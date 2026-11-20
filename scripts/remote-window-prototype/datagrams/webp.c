#include "webp.h"
#include <webp/encode.h>

// Links the operator's libwebp; no codec implementation or third-party source is vendored.
size_t pwrwin_webp(const uint8_t *bgra, int width, int height, int stride,
                  int lossless, uint8_t **output) {
  WebPConfig config;
  WebPPicture picture;
  WebPMemoryWriter writer;
  *output = NULL;
  if (!bgra || width <= 0 || height <= 0 || width > 800 || height > 548
      || stride < width * 4 || !WebPConfigInit(&config) || !WebPPictureInit(&picture)) return 0;
  config.lossless = lossless;
  config.method = 0;
  config.quality = lossless ? 0 : 45;
  config.exact = 1;
  config.thread_level = 0;
  if (!WebPValidateConfig(&config)) return 0;
  picture.use_argb = 1;
  picture.width = width;
  picture.height = height;
  WebPMemoryWriterInit(&writer);
  picture.writer = WebPMemoryWrite;
  picture.custom_ptr = &writer;
  int ok = WebPPictureImportBGRA(&picture, bgra, stride) && WebPEncode(&config, &picture);
  WebPPictureFree(&picture);
  if (!ok) { WebPMemoryWriterClear(&writer); return 0; }
  *output = writer.mem;
  return writer.size;
}
void pwrwin_webp_free(void *output) { WebPFree(output); }
