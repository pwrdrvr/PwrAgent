/* MIT, Copyright (c) 2026 PwrDrvr LLC.
 * Hold an existing advisory lock until the parent closes stdin. Never create,
 * truncate, unlink or follow a symlink. Cargo uses this lock for build output.
 */
#ifdef _WIN32
static int maintenance_lock(const wchar_t *path) {
  HANDLE file = CreateFileW(path, GENERIC_READ,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING,
    FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  BY_HANDLE_FILE_INFORMATION info;
  if (file == INVALID_HANDLE_VALUE) return 1;
  if (!GetFileInformationByHandle(file, &info)
    || (info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT))) {
    CloseHandle(file); return 1;
  }
  OVERLAPPED operation = {0};
  if (!LockFileEx(file, LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
    0, MAXDWORD, MAXDWORD, &operation)) {
    DWORD error = GetLastError();
    CloseHandle(file);
    return error == ERROR_LOCK_VIOLATION ? 2 : 1;
  }
  if (fputc(1, stdout) == EOF || fflush(stdout)) { CloseHandle(file); return 1; }
  while (fgetc(stdin) != EOF) {}
  CloseHandle(file);
  return 0;
}
#else
#include <sys/file.h>
static int maintenance_lock(const char *path) {
  int file = open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  struct stat info, current;
  if (file < 0) return 1;
  if (fstat(file, &info) || !S_ISREG(info.st_mode)) { close(file); return 1; }
  if (flock(file, LOCK_EX | LOCK_NB)) {
    int busy = errno == EAGAIN || errno == EWOULDBLOCK;
    close(file); return busy ? 2 : 1;
  }
  if (lstat(path, &current) || current.st_dev != info.st_dev || current.st_ino != info.st_ino) {
    close(file); return 1;
  }
  if (write(STDOUT_FILENO, "\1", 1) != 1) { close(file); return 1; }
  char byte;
  while (read(STDIN_FILENO, &byte, 1) > 0) {}
  close(file);
  return 0;
}
#endif
