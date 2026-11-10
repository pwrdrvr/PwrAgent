/* MIT, Copyright (c) 2026 PwrDrvr LLC.
 * Allocation beneath explicit caller-owned paths only. Never follow reparse
 * points. Native identities deduplicate hardlinks across all supplied roots.
 * These are shared allocations, not a prediction of volume space recovered.
 */
#include <stdint.h>

#define ALLOCATION_MAX_BYTES UINT64_C(9007199254740991)
#define ALLOCATION_MAX_ENTRIES 1048576

typedef struct { FILE_ID_INFO id; int used; } AllocationIdentity;
typedef struct {
  AllocationIdentity *ids;
  size_t capacity, count;
  uint64_t bytes;
  int lower_bound, measured;
} Allocation;

static size_t allocation_hash(const FILE_ID_INFO *id) {
  uint64_t hash = id->VolumeSerialNumber;
  for (size_t index = 0; index < sizeof(id->FileId.Identifier); index++)
    hash = (hash ^ id->FileId.Identifier[index]) * UINT64_C(1099511628211);
  return (size_t)hash;
}

/* 1 = new identity, 0 = already counted, -1 = unknown. Bounded hash storage
 * avoids a quadratic hardlink scan on node_modules and Cargo output. */
static int allocation_seen(Allocation *allocation, const FILE_ID_INFO *id) {
  if (!allocation->capacity || allocation->count >= allocation->capacity / 2) {
    size_t capacity = allocation->capacity ? allocation->capacity * 2 : 1024;
    if (capacity > ALLOCATION_MAX_ENTRIES * 2) return -1;
    AllocationIdentity *ids = (AllocationIdentity *)calloc(capacity, sizeof(*ids));
    if (!ids) return -1;
    for (size_t index = 0; index < allocation->capacity; index++) {
      if (!allocation->ids[index].used) continue;
      size_t slot = allocation_hash(&allocation->ids[index].id) & (capacity - 1);
      while (ids[slot].used) slot = (slot + 1) & (capacity - 1);
      ids[slot] = allocation->ids[index];
    }
    free(allocation->ids);
    allocation->ids = ids;
    allocation->capacity = capacity;
  }
  size_t slot = allocation_hash(id) & (allocation->capacity - 1);
  while (allocation->ids[slot].used) {
    const FILE_ID_INFO *other = &allocation->ids[slot].id;
    if (other->VolumeSerialNumber == id->VolumeSerialNumber
      && !memcmp(other->FileId.Identifier, id->FileId.Identifier, sizeof(id->FileId.Identifier))) return 0;
    slot = (slot + 1) & (allocation->capacity - 1);
  }
  allocation->ids[slot].id = *id;
  allocation->ids[slot].used = 1;
  allocation->count++;
  return 1;
}

static wchar_t *allocation_child(const wchar_t *parent, const wchar_t *name) {
  size_t length = wcslen(parent) + wcslen(name) + 2;
  if (length > 32767) return NULL;
  wchar_t *child = (wchar_t *)malloc(length * sizeof(wchar_t));
  if (child) swprintf_s(child, length, L"%ls\\%ls", parent, name);
  return child;
}

static int allocation_walk(Allocation *allocation, const wchar_t *path, unsigned depth) {
  if (depth > 256) return 0;
  /* Omitting FILE_SHARE_DELETE pins each opened ancestor until its walk
   * completes, so a directory cannot be replaced by a junction mid-walk. */
  HANDLE file = CreateFileW(path, FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE,
    NULL, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  if (file == INVALID_HANDLE_VALUE) return 0;
  int ok = 0;
  FILE_ATTRIBUTE_TAG_INFO attributes;
  FILE_ID_INFO id;
  FILE_STANDARD_INFO standard;
  if (!GetFileInformationByHandleEx(file, FileAttributeTagInfo, &attributes, sizeof(attributes))) goto done;
  if (attributes.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) {
    allocation->lower_bound = 1;
    ok = 1;
    goto done;
  }
  if (!GetFileInformationByHandleEx(file, FileIdInfo, &id, sizeof(id))
    || !GetFileInformationByHandleEx(file, FileStandardInfo, &standard, sizeof(standard))) goto done;
  int fresh = allocation_seen(allocation, &id);
  if (fresh < 0) goto done;
  if (!fresh) { ok = 1; goto done; }
  LONGLONG bytes = standard.AllocationSize.QuadPart;
  if (!standard.Directory && (attributes.FileAttributes & (FILE_ATTRIBUTE_COMPRESSED | FILE_ATTRIBUTE_SPARSE_FILE))) {
    FILE_COMPRESSION_INFO compression;
    if (!GetFileInformationByHandleEx(file, FileCompressionInfo, &compression, sizeof(compression))) goto done;
    bytes = compression.CompressedFileSize.QuadPart;
  }
  if (bytes < 0 || (uint64_t)bytes > ALLOCATION_MAX_BYTES - allocation->bytes) goto done;
  allocation->bytes += (uint64_t)bytes;
  allocation->measured = 1;
  if (!standard.Directory) { ok = 1; goto done; }

  wchar_t *pattern = allocation_child(path, L"*");
  if (!pattern) goto done;
  WIN32_FIND_DATAW entry;
  HANDLE search = FindFirstFileW(pattern, &entry);
  free(pattern);
  if (search == INVALID_HANDLE_VALUE) {
    ok = GetLastError() == ERROR_FILE_NOT_FOUND;
    goto done;
  }
  do {
    if (!wcscmp(entry.cFileName, L".") || !wcscmp(entry.cFileName, L"..")) continue;
    wchar_t *child = allocation_child(path, entry.cFileName);
    if (!child) { FindClose(search); goto done; }
    int walked = allocation_walk(allocation, child, depth + 1);
    free(child);
    if (!walked) { FindClose(search); goto done; }
  } while (FindNextFileW(search, &entry));
  ok = GetLastError() == ERROR_NO_MORE_FILES;
  FindClose(search);
done:
  CloseHandle(file);
  return ok;
}

static int maintenance_allocation(int count, wchar_t **paths) {
  if (count < 1 || count > 1000) return 1;
  Allocation allocation = {0};
  int ok = 1;
  for (int index = 0; index < count; index++) {
    /* Caller resolves absolute paths. Extended-length paths retain Unicode
     * names and avoid MAX_PATH limits, including explicit UNC checkouts. */
    const wchar_t *source = paths[index];
    wchar_t *extended = NULL;
    if (wcsncmp(source, L"\\\\?\\", 4)) {
      size_t length = wcslen(source) + 8;
      extended = (wchar_t *)malloc(length * sizeof(wchar_t));
      if (!extended) { ok = 0; break; }
      if (!wcsncmp(source, L"\\\\", 2)) swprintf_s(extended, length, L"\\\\?\\UNC\\%ls", source + 2);
      else if (source[0] && source[1] == L':' && source[2] == L'\\') swprintf_s(extended, length, L"\\\\?\\%ls", source);
      else { free(extended); ok = 0; break; }
    }
    ok = allocation_walk(&allocation, extended ? extended : source, 0);
    free(extended);
    if (!ok) break;
  }
  if (ok && allocation.measured) {
    printf("{\"allocatedBytes\":%llu%s}\n", (unsigned long long)allocation.bytes,
      allocation.lower_bound ? ",\"lowerBound\":true" : "");
  } else ok = 0;
  free(allocation.ids);
  return ok && !ferror(stdout) ? 0 : 1;
}
