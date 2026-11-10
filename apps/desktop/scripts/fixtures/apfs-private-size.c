#include <sys/attr.h>
#include <sys/stat.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

// Test oracle: the filesystem, not du or equal content, owns sharing state.
int main(int argc, char **argv) {
  for (int i = 1; i < argc; i++) {
    struct attrlist attrs = {0};
    attrs.bitmapcount = ATTR_BIT_MAP_COUNT;
    attrs.commonattr = ATTR_CMN_RETURNED_ATTRS;
    attrs.forkattr = ATTR_CMNEXT_PRIVATESIZE | ATTR_CMNEXT_CLONEID;
    unsigned char buffer[128] = {0};
    struct stat st;
    if (getattrlist(argv[i], &attrs, buffer, sizeof(buffer), FSOPT_ATTR_CMN_EXTENDED) || stat(argv[i], &st)) {
      perror(argv[i]);
      return 1;
    }
    attribute_set_t returned;
    memcpy(&returned, buffer + sizeof(uint32_t), sizeof(returned));
    if ((returned.forkattr & attrs.forkattr) != attrs.forkattr) {
      fprintf(stderr, "Missing private-size or clone-id attribute\n");
      return 1;
    }
    uint64_t private_size, clone_id;
    memcpy(&private_size, buffer + sizeof(uint32_t) + sizeof(returned), 8);
    memcpy(&clone_id, buffer + sizeof(uint32_t) + sizeof(returned) + 8, 8);
    printf("{\"privateBytes\":%llu,\"cloneId\":\"%llu\",\"inode\":\"%llu\",\"allocatedBytes\":%llu}\n",
      (unsigned long long)private_size, (unsigned long long)clone_id,
      (unsigned long long)st.st_ino, (unsigned long long)st.st_blocks * 512);
  }
  return 0;
}
