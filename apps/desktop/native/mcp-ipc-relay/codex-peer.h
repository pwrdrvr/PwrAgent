/* MIT, Copyright (c) 2026 PwrDrvr LLC. Unix Codex relay admission probes.
 * The owner passes the accepted socket as fd 3. No fields come from the client.
 */
#ifdef __APPLE__
#include <libproc.h>
#include <sys/proc_info.h>
#elif defined(__linux__)
#include <sys/syscall.h>
/* Linux UAPI. Older build headers omit the option even on a new kernel. */
#ifndef SO_PEERPIDFD
#define SO_PEERPIDFD 77
#endif
#endif

typedef struct {
  int pid;
  int parent;
  unsigned long long generation;
#ifdef __APPLE__
  unsigned long long parent_generation;
  unsigned int audit_version;
#endif
} CodexProcess;

static int codex_process(int pid, CodexProcess *info) {
  if (pid <= 1) return 0;
#ifdef __APPLE__
  /* Layout and flavor 18 are documented in XNU's proc_info_private.h.
   * Treat an absent flavor or a changed size as unavailable.
   */
  struct {
    struct proc_bsdinfo bsd;
    unsigned char executable_uuid[16];
    unsigned long long unique_id;
    unsigned long long parent_unique_id;
    unsigned int pid_version;
    unsigned int original_parent_version;
    unsigned long long reserved[2];
  } snapshot;
  if (proc_pidinfo(pid, 18, 0, &snapshot, sizeof(snapshot)) != sizeof(snapshot)
    || snapshot.bsd.pbi_pid != (unsigned int)pid || snapshot.bsd.pbi_uid != geteuid()
    || snapshot.bsd.pbi_status == 5 || !snapshot.unique_id) return 0;
  *info = (CodexProcess){pid, (int)snapshot.bsd.pbi_ppid, snapshot.unique_id,
    snapshot.parent_unique_id, snapshot.pid_version};
  return 1;
#elif defined(__linux__)
  char path[64], data[4096];
  snprintf(path, sizeof(path), "/proc/%d/stat", pid);
  int fd = open(path, O_RDONLY | O_CLOEXEC);
  if (fd < 0) return 0;
  struct stat metadata;
  ssize_t n = fstat(fd, &metadata) || metadata.st_uid != geteuid()
    ? -1 : read(fd, data, sizeof(data) - 1);
  close(fd);
  if (n <= 0 || (size_t)n == sizeof(data) - 1) return 0;
  data[n] = 0;
  /* comm can contain spaces, newlines and parentheses. The final ')' ends it. */
  char *fields = strrchr(data, ')'), *save = NULL;
  if (!fields) return 0;
  char *value = strtok_r(fields + 1, " ", &save);
  if (!value || *value == 'Z' || *value == 'X') return 0;
  int parent = 0;
  for (int field = 4; field <= 22; field++) {
    value = strtok_r(NULL, " ", &save);
    if (!value) return 0;
    if (field == 4) parent = atoi(value);
  }
  unsigned long long start = strtoull(value, NULL, 10);
  if (!start) return 0;
  *info = (CodexProcess){pid, parent, start};
  return 1;
#else
  (void)info;
  return 0;
#endif
}

static void codex_print_process(const CodexProcess *info) {
  printf("%d:%llu\n", info->pid, info->generation);
}

#ifdef __linux__
static int codex_peer_pidfd(int socket_fd) {
  int descriptor = -1;
  socklen_t size = sizeof(descriptor);
  if (getsockopt(socket_fd, SOL_SOCKET, SO_PEERPIDFD, &descriptor, &size)
    || size != sizeof(descriptor) || descriptor < 0) deny("SO_PEERPIDFD is unavailable");
  return descriptor;
}

static void codex_require_live(int pidfd) {
  struct pollfd process = {pidfd, POLLIN, 0};
  if (poll(&process, 1, 0) != 0) deny("connected peer is no longer live");
}
#endif

static void codex_root(const char *argument) {
  char *end;
  long pid = strtol(argument, &end, 10);
  CodexProcess root;
  if (*end || pid <= 1 || pid > 2147483647 || !codex_process((int)pid, &root)
    || root.parent != getppid()) deny("Codex runtime is not a live owner child");
#ifdef __linux__
  /* Give old kernels an explicit unavailable path before configuring Codex. */
  int pair[2];
  if (socketpair(AF_UNIX, SOCK_STREAM, 0, pair)) fail("cannot probe peer identity");
  close(codex_peer_pidfd(pair[0]));
  close(pair[0]);
  close(pair[1]);
#endif
  codex_print_process(&root);
}

static void codex_ancestry(int fd) {
  check_peer(fd);
  int pid;
#ifdef __APPLE__
  /* LOCAL_PEERTOKEN supplies the connector's PID and its audit PID version. */
  unsigned int token[8];
  socklen_t size = sizeof(token);
  if (getsockopt(fd, SOL_LOCAL, LOCAL_PEERTOKEN, token, &size) || size != sizeof(token))
    deny("cannot read connected peer audit token");
  pid = (int)token[5];
#elif defined(__linux__)
  int peer_fd = codex_peer_pidfd(fd);
  struct ucred peer;
  socklen_t size = sizeof(peer);
  if (getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &peer, &size) || size != sizeof(peer))
    deny("cannot read connected peer credentials");
  pid = peer.pid;
#else
  deny("Codex ancestry is unavailable");
  return;
#endif
  enum { MAX_CHAIN = 5 };
  CodexProcess chain[MAX_CHAIN];
  if (!codex_process(pid, &chain[0])) deny("cannot identify connected peer process");
#ifdef __APPLE__
  if (chain[0].audit_version != token[7]) deny("connected peer PID generation changed");
#endif
  int count = 1;
  for (; count < MAX_CHAIN; count++) {
    CodexProcess *child = &chain[count - 1], *parent = &chain[count];
    if (!codex_process(child->parent, parent)) break;
#ifdef __APPLE__
    if (child->parent_generation != parent->generation) break;
#elif defined(__linux__)
    if (parent->generation > child->generation) break;
#endif
  }
  /* Parentage may change while traversing; discard a changing observation. */
  for (int i = count - 1; i >= 0; i--) {
    CodexProcess checked;
    if (!codex_process(chain[i].pid, &checked) || checked.parent != chain[i].parent
      || checked.generation != chain[i].generation) deny("peer ancestry changed");
  }
#ifdef __linux__
  codex_require_live(peer_fd);
  close(peer_fd);
#endif
  for (int i = 0; i < count; i++) codex_print_process(&chain[i]);
}
