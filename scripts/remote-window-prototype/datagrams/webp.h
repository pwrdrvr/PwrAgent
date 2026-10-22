#include <stddef.h>
#include <stdint.h>
size_t pwrwin_webp(const uint8_t *bgra, int width, int height, int stride,
                  int lossless, uint8_t **output);
void pwrwin_webp_free(void *output);
