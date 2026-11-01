/* Native-only tests: compiled separately; never packaged or called by the app. */
#ifdef _WIN32
#define wmain relay_wmain
#else
#define main relay_main
#endif
#include "main.c"
#ifdef _WIN32
#undef wmain
int wmain(int argc, wchar_t **argv) {
  if (argc != 2) return 2;
  if (!wcscmp(argv[1], L"unreadable")) {
    user_of(INVALID_HANDLE_VALUE);
    return 2;
  }
  return 2;
}
#else
#undef main
#include <sys/wait.h>
int main(int argc, char **argv) {
  if (argc != 2) return 2;
  if (!strcmp(argv[1], "unreadable")) { check_peer(-1); return 2; }
  if (!strcmp(argv[1], "wrong-user")) {
    if (geteuid() != 0) return 77;
    /* The root harness forks an unprivileged listener. Peer credentials are
     * measured on a real connected socket, independently of pathname owner.
     */
    char directory[] = "/tmp/pwragent-peer-XXXXXX";
    if (!mkdtemp(directory) || chmod(directory, 0777)) return 2;
    char path[108];
    snprintf(path, sizeof(path), "%s/server.sock", directory);
    int ready[2];
    if (pipe(ready)) return 2;
    pid_t child = fork();
    if (child < 0) return 2;
    if (!child) {
      close(ready[0]);
      if (setgid(65534) || setuid(65534)) _exit(2);
      int listener = socket(AF_UNIX, SOCK_STREAM, 0);
      struct sockaddr_un address;
      memset(&address, 0, sizeof(address)); address.sun_family = AF_UNIX;
      memcpy(address.sun_path, path, strlen(path) + 1);
      if (bind(listener, (struct sockaddr *)&address, sizeof(address)) || listen(listener, 1)) _exit(2);
      if (write(ready[1], "x", 1) != 1) _exit(2);
      int connection = accept(listener, NULL, NULL);
      if (connection < 0) _exit(2);
      char byte;
      /* Client verification must send no protocol data. */
      ssize_t received = read(connection, &byte, 1);
      close(connection); close(listener);
      _exit(received == 0 ? 0 : 3);
    }
    close(ready[1]);
    char marker;
    if (read(ready[0], &marker, 1) != 1) return 2;
    close(ready[0]);
    pid_t verifier = fork();
    if (!verifier) {
      int fd = socket(AF_UNIX, SOCK_STREAM, 0);
      struct sockaddr_un address;
      memset(&address, 0, sizeof(address)); address.sun_family = AF_UNIX;
      memcpy(address.sun_path, path, strlen(path) + 1);
      if (connect(fd, (struct sockaddr *)&address, sizeof(address))) _exit(2);
      check_peer(fd);
      _exit(3);
    }
    int status, server_status;
    waitpid(verifier, &status, 0); waitpid(child, &server_status, 0);
    unlink(path); rmdir(directory);
    return WIFEXITED(status) && WEXITSTATUS(status) == 1
      && WIFEXITED(server_status) && WEXITSTATUS(server_status) == 0 ? 0 : 2;
  }
  return 2;
}
#endif
