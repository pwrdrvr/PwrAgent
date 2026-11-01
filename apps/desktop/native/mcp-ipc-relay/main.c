/* MIT, Copyright (c) 2026 PwrDrvr LLC.
 * One verified local connection, never a listener. stdout is a one-byte
 * readiness marker followed by opaque HTTP bytes. No input is read until
 * identity verification succeeds. Process termination owns all pending I/O.
 */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#define _WIN32_WINNT 0x0600
#include <windows.h>
#include <aclapi.h>
#include <wchar.h>

static void fail(const char *message) {
  fprintf(stderr, "MCP IPC: %s (Windows error %lu)\n", message, GetLastError());
  ExitProcess(1);
}

static TOKEN_USER *user_of(HANDLE process) {
  HANDLE token;
  DWORD size = 0;
  if (!OpenProcessToken(process, TOKEN_QUERY, &token)) fail("cannot read user token");
  GetTokenInformation(token, TokenUser, NULL, 0, &size);
  if (!size || size > 65536) fail("cannot size user token");
  TOKEN_USER *user = (TOKEN_USER *)malloc(size);
  if (!user || !GetTokenInformation(token, TokenUser, user, size, &size)) fail("cannot verify user SID");
  CloseHandle(token);
  return user;
}

static void same_user(PSID expected, PSID actual, const char *message) {
  if (!actual || !IsValidSid(actual) || !EqualSid(actual, expected)) {
    SetLastError(ERROR_ACCESS_DENIED); fail(message);
  }
}

static void verify_pipe_identity(HANDLE pipe) {
  TOKEN_USER *user = user_of(GetCurrentProcess());
  PSID owner = NULL;
  PSECURITY_DESCRIPTOR descriptor = NULL;
  DWORD error = GetSecurityInfo(pipe, SE_KERNEL_OBJECT, OWNER_SECURITY_INFORMATION,
    &owner, NULL, NULL, NULL, &descriptor);
  if (error != ERROR_SUCCESS) { SetLastError(error); fail("cannot verify connected pipe owner"); }
  same_user(user->User.Sid, owner, "pipe owner is another user");
  LocalFree(descriptor);
  ULONG pid = 0, checked_pid = 0;
  if (!GetNamedPipeServerProcessId(pipe, &pid) || !pid) fail("cannot verify pipe server process");
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid);
  if (!process) fail("cannot open pipe server identity");
  TOKEN_USER *server = user_of(process);
  same_user(user->User.Sid, server->User.Sid, "pipe server is another user");
  /* Hold the process handle through verification and recheck the connected
   * instance. A dead/reused PID is never accepted as an identity lookup.
   */
  if (WaitForSingleObject(process, 0) != WAIT_TIMEOUT
    || !GetNamedPipeServerProcessId(pipe, &checked_pid) || pid != checked_pid) {
    fail("pipe server changed during identity verification");
  }
  free(server);
  free(user);
  CloseHandle(process);
}

static HANDLE verified_pipe(const wchar_t *path) {
  if (wcsncmp(path, L"\\\\.\\pipe\\", 9) || !path[9]
    || wcspbrk(path + 9, L"\\/:?*\"<>|")) fail("expected a local Windows pipe name");
  /* SECURITY_IDENTIFICATION prevents the server impersonating this client.
   * No WaitNamedPipe/retry: a busy, absent or replaced endpoint fails once.
   */
  HANDLE pipe = CreateFileW(path, GENERIC_READ | GENERIC_WRITE | READ_CONTROL,
    0, NULL, OPEN_EXISTING,
    FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, NULL);
  if (pipe == INVALID_HANDLE_VALUE) fail("cannot open local pipe");
  if (GetFileType(pipe) != FILE_TYPE_PIPE) fail("endpoint is not a pipe");
  verify_pipe_identity(pipe);
  return pipe;
}

typedef struct { HANDLE from; HANDLE to; BOOL read_async; BOOL write_async; } Copy;

static BOOL transfer(HANDLE handle, BOOL reading, BOOL asynchronous,
  char *bytes, DWORD capacity, DWORD *size, HANDLE event) {
  if (!asynchronous) {
    return reading ? ReadFile(handle, bytes, capacity, size, NULL)
      : WriteFile(handle, bytes, capacity, size, NULL);
  }
  OVERLAPPED operation = {0};
  operation.hEvent = event;
  if (!ResetEvent(event)) fail("cannot reset relay I/O event");
  BOOL started = reading ? ReadFile(handle, bytes, capacity, NULL, &operation)
    : WriteFile(handle, bytes, capacity, NULL, &operation);
  if (!started && GetLastError() != ERROR_IO_PENDING) return FALSE;
  return GetOverlappedResult(handle, &operation, size, TRUE);
}

static DWORD WINAPI copy_bytes(void *arg) {
  Copy *io = (Copy *)arg;
  /* Simultaneous reads and writes on the one connected pipe require
   * overlapped I/O. Each direction owns its event and operation; inherited
   * stdin/stdout remain synchronous. ExitProcess cancels both directions.
   */
  HANDLE event = CreateEventW(NULL, TRUE, FALSE, NULL);
  if (!event) fail("cannot create relay I/O event");
  char bytes[16384];
  DWORD size;
  while (transfer(io->from, TRUE, io->read_async, bytes, sizeof(bytes), &size, event) && size) {
    DWORD offset = 0;
    while (offset < size) {
      DWORD written;
      if (!transfer(io->to, FALSE, io->write_async, bytes + offset, size - offset, &written, event)
        || !written) ExitProcess(1);
      offset += written;
    }
  }
  /* Either direction closing ends the connection, including blocked writes
   * on the other thread. Windows cancels process-owned I/O.
   */
  ExitProcess(0);
}

int wmain(int argc, wchar_t **argv) {
  if (argc != 2) fail("expected one endpoint");
  HANDLE pipe = verified_pipe(argv[1]);
  HANDLE output = GetStdHandle(STD_OUTPUT_HANDLE);
  DWORD written;
  if (!WriteFile(output, "\1", 1, &written, NULL) || written != 1) fail("parent closed");
  Copy up = { GetStdHandle(STD_INPUT_HANDLE), pipe, FALSE, TRUE };
  Copy down = { pipe, output, TRUE, FALSE };
  HANDLE worker = CreateThread(NULL, 0, copy_bytes, &up, 0, NULL);
  if (!worker) fail("cannot start relay");
  copy_bytes(&down);
}
#else
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stddef.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>
#ifdef __APPLE__
#include <sys/acl.h>
#endif

static void fail(const char *message) {
  fprintf(stderr, "MCP IPC: %s (%s)\n", message, strerror(errno));
  exit(1);
}

static void deny(const char *message) { errno = EACCES; fail(message); }

#ifdef __APPLE__
static void no_grant_acl(acl_t acl) {
  if (!acl) fail("cannot inspect endpoint ACL");
  if (acl_valid(acl)) fail("endpoint ACL is invalid");
  acl_entry_t entry;
  int result = acl_get_entry(acl, ACL_FIRST_ENTRY, &entry);
  while (result == 0) {
    acl_tag_t tag;
    if (acl_get_tag_type(entry, &tag)) fail("cannot inspect ACL entry");
    if (tag == ACL_EXTENDED_ALLOW) deny("endpoint path has an extended allow ACL");
    result = acl_get_entry(acl, ACL_NEXT_ENTRY, &entry);
  }
  acl_free(acl);
}

static void check_acl(int fd, const char *path) {
  filesec_t security = filesec_init();
  struct stat info;
  if (!security) fail("cannot allocate endpoint security metadata");
  if ((fd >= 0 ? fstatx_np(fd, &info, security) : lstatx_np(path, &info, security))) {
    fail("cannot read endpoint security metadata");
  }
  acl_t acl = NULL;
  /* Apple represents an absent ACL property as ENOENT too. Query it only
   * after a successful statx, distinguishing absence from an unreadable or
   * nonexistent filesystem object. Never accept an acl_get_* lookup error.
   */
  if (filesec_get_property(security, FILESEC_ACL, &acl)) {
    if (errno != ENOENT) fail("cannot read endpoint ACL property");
  } else {
    no_grant_acl(acl);
  }
  filesec_free(security);
}
#endif

static int protected_parent(const char *path, char **storage, char **name) {
  *storage = strdup(path);
  if (!*storage) fail("out of memory");
  char *last = strrchr(*storage, '/');
  if (!last || last == *storage || !last[1]) deny("use a socket in a protected user directory");
  *last = 0;
  *name = last + 1;
  int dir = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  if (dir < 0) fail("cannot open filesystem root");
  char *save = NULL;
  for (char *part = strtok_r(*storage, "/", &save); part; part = strtok_r(NULL, "/", &save)) {
    if (!strcmp(part, ".") || !strcmp(part, "..")) deny("dot segments are not supported");
    int next = openat(dir, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (next < 0) fail("cannot open endpoint parent without following symlinks");
    close(dir);
    dir = next;
    struct stat info;
    if (fstat(dir, &info)) fail("cannot inspect endpoint parent");
#ifdef __APPLE__
    check_acl(dir, NULL);
#endif
    if (info.st_uid != 0 && info.st_uid != geteuid()) deny("endpoint ancestor belongs to another user");
    if ((info.st_mode & 0022) && !(info.st_uid == 0 && (info.st_mode & S_ISVTX))) {
      deny("endpoint ancestor is writable by another user");
    }
  }
  struct stat parent;
  if (fstat(dir, &parent)) fail("cannot inspect socket directory");
  if (parent.st_uid != geteuid() || (parent.st_mode & 0077)) {
    deny("socket parent must belong to this user with mode 0700");
  }
  return dir;
}

static void check_socket(int dir, const char *name, struct stat *info) {
  if (fstatat(dir, name, info, AT_SYMLINK_NOFOLLOW)) fail("cannot inspect socket endpoint");
  if (!S_ISSOCK(info->st_mode) || info->st_uid != geteuid() || (info->st_mode & 0077)) {
    deny("endpoint must be this user's socket with mode 0600");
  }
}

static void check_peer(int fd) {
  uid_t uid;
#if defined(__linux__)
  struct ucred peer;
  socklen_t size = sizeof(peer);
  if (getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &peer, &size) || size != sizeof(peer)) fail("cannot verify peer effective UID");
  uid = peer.uid;
#elif defined(__APPLE__)
  gid_t gid;
  if (getpeereid(fd, &uid, &gid)) fail("cannot verify peer effective UID");
#else
  deny("peer identity verification is unsupported on this platform");
  uid = (uid_t)-1;
#endif
  if (uid != geteuid()) deny("connected socket peer belongs to another user");
}

static int verified_socket(const char *path) {
  struct sockaddr_un addr;
  memset(&addr, 0, sizeof(addr));
  if (path[0] != '/' || strlen(path) >= sizeof(addr.sun_path)) {
    errno = EINVAL; fail("Unix socket path is not absolute or is too long");
  }
  char *storage, *name;
  int dir = protected_parent(path, &storage, &name);
  struct stat before, after;
  check_socket(dir, name, &before);
#ifdef __APPLE__
  check_acl(-1, path);
#endif
  int fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (fd < 0) fail("cannot create Unix socket");
  addr.sun_family = AF_UNIX;
  memcpy(addr.sun_path, path, strlen(path) + 1);
  if (connect(fd, (struct sockaddr *)&addr, (socklen_t)(offsetof(struct sockaddr_un, sun_path) + strlen(path) + 1))) {
    fail("cannot connect to Unix socket");
  }
  check_peer(fd);
  check_socket(dir, name, &after);
  if (before.st_dev != after.st_dev || before.st_ino != after.st_ino) deny("socket changed during connection");
  /* Rewalk the original path as well: pinning its parent alone would miss a
   * renamed ancestor. Actual peer credentials remain mandatory in all cases.
   */
  char *again, *again_name;
  int again_dir = protected_parent(path, &again, &again_name);
  check_socket(again_dir, again_name, &after);
  if (before.st_dev != after.st_dev || before.st_ino != after.st_ino) deny("endpoint path changed during connection");
  close(again_dir); free(again); close(dir); free(storage);
  return fd;
}

typedef struct { char bytes[16384]; size_t start; size_t end; } Buffer;
static void nonblocking(int fd) {
  int flags = fcntl(fd, F_GETFL);
  if (flags < 0 || fcntl(fd, F_SETFL, flags | O_NONBLOCK)) fail("cannot configure relay");
}
static int transfer_read(int fd, Buffer *buffer) {
  ssize_t n = read(fd, buffer->bytes, sizeof(buffer->bytes));
  if (n == 0) return 0;
  if (n < 0) {
    if (errno == EAGAIN || errno == EINTR) return 1;
    fail("relay read failed");
  }
  buffer->start = 0; buffer->end = (size_t)n;
  return 1;
}
static void transfer_write(int fd, Buffer *buffer) {
  ssize_t n = write(fd, buffer->bytes + buffer->start, buffer->end - buffer->start);
  if (n < 0) {
    if (errno == EAGAIN || errno == EINTR) return;
    fail("relay write failed");
  }
  if (!n) fail("relay write made no progress");
  buffer->start += (size_t)n;
}
int main(int argc, char **argv) {
  if (argc != 2) { errno = EINVAL; fail("expected one endpoint"); }
  signal(SIGPIPE, SIG_IGN);
  int fd = verified_socket(argv[1]);
  if (write(STDOUT_FILENO, "\1", 1) != 1) fail("parent closed");
  nonblocking(fd); nonblocking(STDIN_FILENO); nonblocking(STDOUT_FILENO);
  Buffer up = {{0}, 0, 0}, down = {{0}, 0, 0};
  for (;;) {
    struct pollfd events[3] = {
      {up.start == up.end ? STDIN_FILENO : -1, POLLIN, 0},
      {fd, (short)((down.start == down.end ? POLLIN : 0) | (up.start != up.end ? POLLOUT : 0)), 0},
      {down.start != down.end ? STDOUT_FILENO : -1, POLLOUT, 0},
    };
    if (poll(events, 3, -1) < 0) { if (errno == EINTR) continue; fail("relay poll failed"); }
    if (events[2].revents & POLLOUT) transfer_write(STDOUT_FILENO, &down);
    if (events[1].revents & POLLOUT) transfer_write(fd, &up);
    if ((events[0].revents & (POLLIN | POLLHUP)) && up.start == up.end) {
      if (!transfer_read(STDIN_FILENO, &up)) break;
    }
    if ((events[1].revents & (POLLIN | POLLHUP)) && down.start == down.end) {
      if (!transfer_read(fd, &down)) break;
    }
    if ((events[0].revents | events[1].revents | events[2].revents) & (POLLERR | POLLNVAL)) break;
    if (events[2].revents & POLLHUP) break;
  }
  close(fd);
  return 0;
}
#endif
