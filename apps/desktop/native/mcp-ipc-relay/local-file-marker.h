/* MIT, Copyright (c) 2026 PwrDrvr LLC.
 * Traverse a canonical marker path from a filesystem root. Each lookup gets
 * one name and the preceding directory handle. Renaming an opened directory
 * cannot redirect the rest of the walk through its replacement.
 */
enum marker_status { MARKER_OK, MARKER_ERROR, MARKER_MISSING, MARKER_UNSAFE };

#ifdef _WIN32
#include <limits.h>
#include <winternl.h>

typedef wchar_t marker_char;
typedef HANDLE marker_directory;
#define MARKER_SEPARATOR L'\\'
#define marker_separator wcschr
#define marker_last_separator wcsrchr
#define marker_dot L'.'
#define marker_close CloseHandle
#define MARKER_INVALID_DIRECTORY INVALID_HANDLE_VALUE

static const ULONG marker_share = FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE;
static const ACCESS_MASK marker_directory_access = FILE_READ_ATTRIBUTES | FILE_TRAVERSE | SYNCHRONIZE;

static enum marker_status marker_open_error(DWORD error, BOOL directory) {
  switch (error) {
    case ERROR_FILE_NOT_FOUND:
    case ERROR_PATH_NOT_FOUND:
      return MARKER_MISSING;
    case ERROR_DIRECTORY:
      return MARKER_UNSAFE;
    case ERROR_REPARSE_POINT_ENCOUNTERED:
      return directory ? MARKER_UNSAFE : MARKER_MISSING;
    default:
      return MARKER_ERROR;
  }
}

static enum marker_status marker_verify_directory(HANDLE handle) {
  FILE_ATTRIBUTE_TAG_INFO info;
  if (!GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &info, sizeof(info))) return MARKER_ERROR;
  if (!(info.FileAttributes & FILE_ATTRIBUTE_DIRECTORY)
    || (info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)
    || GetFileType(handle) != FILE_TYPE_DISK) return MARKER_UNSAFE;
  return MARKER_OK;
}

static enum marker_status marker_open_root(const wchar_t *root, HANDLE *directory) {
  HANDLE handle = CreateFileW(root, marker_directory_access, marker_share, NULL, OPEN_EXISTING,
    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  if (handle == INVALID_HANDLE_VALUE) return marker_open_error(GetLastError(), TRUE);
  enum marker_status status = marker_verify_directory(handle);
  if (status == MARKER_OK) *directory = handle;
  else CloseHandle(handle);
  return status;
}

static enum marker_status marker_open_relative(HANDLE parent, wchar_t *name, BOOL directory, HANDLE *handle) {
  size_t length = wcslen(name);
  if (length > USHRT_MAX / sizeof(wchar_t) || wcspbrk(name, L"/:")) return MARKER_UNSAFE;
  USHORT bytes = (USHORT)(length * sizeof(wchar_t));
  UNICODE_STRING object_name = { bytes, bytes, name };
  OBJECT_ATTRIBUTES attributes = {
    sizeof(attributes), parent, &object_name, OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE, NULL, NULL
  };
  IO_STATUS_BLOCK io;
  NTSTATUS status = NtCreateFile(handle,
    directory ? marker_directory_access : FILE_READ_ATTRIBUTES | SYNCHRONIZE,
    &attributes, &io, NULL, 0, marker_share, FILE_OPEN,
    FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT,
    NULL, 0);
  return status < 0 ? marker_open_error(RtlNtStatusToDosError(status), directory) : MARKER_OK;
}

static enum marker_status marker_open_directory(HANDLE parent, wchar_t *name, HANDLE *directory) {
  enum marker_status status = marker_open_relative(parent, name, TRUE, directory);
  if (status != MARKER_OK) return status;
  status = marker_verify_directory(*directory);
  if (status != MARKER_OK) CloseHandle(*directory);
  return status;
}

static enum marker_status marker_read_mtime(HANDLE parent, wchar_t *name, double *mtime) {
  HANDLE handle;
  enum marker_status status = marker_open_relative(parent, name, FALSE, &handle);
  if (status != MARKER_OK) return status;
  FILE_BASIC_INFO info;
  if (!GetFileInformationByHandleEx(handle, FileBasicInfo, &info, sizeof(info))) status = MARKER_ERROR;
  else if ((info.FileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DEVICE))
    || GetFileType(handle) != FILE_TYPE_DISK) status = MARKER_MISSING;
  else *mtime = (double)(info.LastWriteTime.QuadPart - 116444736000000000LL) / 10000.0;
  CloseHandle(handle);
  return status;
}

#else

typedef char marker_char;
typedef int marker_directory;
#define MARKER_SEPARATOR '/'
#define marker_separator strchr
#define marker_last_separator strrchr
#define marker_dot '.'
#define marker_close close
#define MARKER_INVALID_DIRECTORY -1

#if defined(O_PATH)
#define MARKER_DIRECTORY_ACCESS O_PATH
#elif defined(O_SEARCH)
#define MARKER_DIRECTORY_ACCESS O_SEARCH
#else
#define MARKER_DIRECTORY_ACCESS O_RDONLY
#endif

static enum marker_status marker_open_directory(int parent, const char *name, int *directory) {
  int handle = openat(parent, name, MARKER_DIRECTORY_ACCESS | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (handle < 0) {
    if (errno == ENOENT) return MARKER_MISSING;
    if (errno == ELOOP || errno == ENOTDIR) return MARKER_UNSAFE;
    return MARKER_ERROR;
  }
  *directory = handle;
  return MARKER_OK;
}

static enum marker_status marker_open_root(const char *root, int *directory) {
  if (strcmp(root, "/")) return MARKER_UNSAFE;
  return marker_open_directory(AT_FDCWD, root, directory);
}

static enum marker_status marker_read_mtime(int parent, const char *name, double *mtime) {
  struct stat info;
  if (fstatat(parent, name, &info, AT_SYMLINK_NOFOLLOW)) return errno == ENOENT ? MARKER_MISSING : MARKER_ERROR;
  if (!S_ISREG(info.st_mode)) return MARKER_MISSING;
#ifdef __APPLE__
  *mtime = (double)info.st_mtimespec.tv_sec * 1000.0 + (double)info.st_mtimespec.tv_nsec / 1000000.0;
#else
  *mtime = (double)info.st_mtim.tv_sec * 1000.0 + (double)info.st_mtim.tv_nsec / 1000000.0;
#endif
  return MARKER_OK;
}
#endif

static int marker_safe_component(const marker_char *name) {
  return name[0] && !(name[0] == marker_dot
    && (!name[1] || (name[1] == marker_dot && !name[2])));
}

static enum marker_status marker_walk_directories(marker_directory *parent, marker_char *name) {
  for (;;) {
    marker_char *separator = marker_separator(name, MARKER_SEPARATOR);
    if (separator) *separator = 0;
    marker_directory child = MARKER_INVALID_DIRECTORY;
    enum marker_status status = marker_safe_component(name)
      ? marker_open_directory(*parent, name, &child) : MARKER_UNSAFE;
    if (separator) *separator = MARKER_SEPARATOR;
    if (status != MARKER_OK) return status;
    marker_close(*parent);
    *parent = child;
    if (!separator) return MARKER_OK;
    name = separator + 1;
  }
}

static enum marker_status marker_lookup(marker_directory *parent, marker_char *relative, double *mtime) {
  marker_char *separator = marker_last_separator(relative, MARKER_SEPARATOR);
  if (separator) {
    *separator = 0;
    enum marker_status status = marker_walk_directories(parent, relative);
    *separator = MARKER_SEPARATOR;
    if (status != MARKER_OK) return status;
    relative = separator + 1;
  }
  return marker_safe_component(relative) ? marker_read_mtime(*parent, relative, mtime) : MARKER_UNSAFE;
}

static int marker_report(enum marker_status status, double mtime) {
  if (status != MARKER_OK) return status;
  return printf("%.17g\n", mtime) < 0 ? MARKER_ERROR : MARKER_OK;
}

static int local_file_marker(const marker_char *root, marker_char *relative) {
  marker_directory directory;
  enum marker_status status = marker_open_root(root, &directory);
  if (status != MARKER_OK) return status;
  double mtime = 0;
  status = marker_lookup(&directory, relative, &mtime);
  marker_close(directory);
  return marker_report(status, mtime);
}
