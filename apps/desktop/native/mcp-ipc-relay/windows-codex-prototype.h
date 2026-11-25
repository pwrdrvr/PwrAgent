/* MIT, Copyright (c) 2026 PwrDrvr LLC.
 * Native Windows admission experiment. Included only by the test executable.
 * One protected pipe, one owned debug generation, at most one admitted stream.
 */
#include <io.h>
#include <stdint.h>
#include <sddl.h>

#define CODEX_PROTOTYPE_PREFIX L"\\\\.\\pipe\\pwa-codex-prototype-"
#define CODEX_PIN_LIMIT 256
#define CODEX_PROOF_TIMEOUT 3000

typedef struct {
  DWORD pid;
  HANDLE process;
  BOOL initial_breakpoint;
} CodexDebugPin;

typedef BOOL (WINAPI *CodexCompareObjects)(HANDLE, HANDLE);

typedef struct {
  HANDLE pipe, stop, bridge_input, bridge_output;
  CodexCompareObjects compare_objects;
  DWORD root_pid;
  SRWLOCK pin_lock;
  CodexDebugPin pins[CODEX_PIN_LIMIT];
} CodexPrototype;

static HANDLE codex_protected_pipe(const wchar_t *path) {
  const size_t prefix = wcslen(CODEX_PROTOTYPE_PREFIX);
  if (wcsncmp(path, CODEX_PROTOTYPE_PREFIX, prefix) || !path[prefix]
    || wcspbrk(path + prefix, L"\\/:?*\"<>|")) fail("expected a local Codex prototype pipe name");
  TOKEN_USER *user = user_of(GetCurrentProcess());
  LPWSTR sid = NULL;
  if (!ConvertSidToStringSidW(user->User.Sid, &sid)) fail("cannot format listener SID");
  wchar_t sddl[256];
  int length = swprintf(sddl, _countof(sddl), L"O:%lsD:P(A;;GA;;;%ls)", sid, sid);
  LocalFree(sid);
  free(user);
  PSECURITY_DESCRIPTOR descriptor = NULL;
  if (length < 0 || !ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, SDDL_REVISION_1, &descriptor, NULL))
    fail("cannot restrict Codex pipe to the current SID");
  SECURITY_ATTRIBUTES attributes = {sizeof(attributes), descriptor, FALSE};
  HANDLE pipe = CreateNamedPipeW(path, PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
    PIPE_TYPE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, 16384, 16384, 0, &attributes);
  LocalFree(descriptor);
  if (pipe == INVALID_HANDLE_VALUE) fail("cannot create first protected Codex pipe instance");
  return pipe;
}

static BOOL codex_overlapped(HANDLE pipe, HANDLE stop, BOOL read, void *buffer, DWORD length,
  DWORD *count, DWORD timeout) {
  OVERLAPPED op = {0};
  op.hEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
  if (!op.hEvent) return FALSE;
  BOOL ok;
  if (!buffer) ok = ConnectNamedPipe(pipe, &op);
  else if (read) ok = ReadFile(pipe, buffer, length, NULL, &op);
  else ok = WriteFile(pipe, buffer, length, NULL, &op);
  DWORD error = ok ? ERROR_SUCCESS : GetLastError();
  if (error == ERROR_IO_PENDING) {
    HANDLE events[] = {stop, op.hEvent};
    if (WaitForMultipleObjects(_countof(events), events, FALSE, timeout) != WAIT_OBJECT_0 + 1) {
      CancelIoEx(pipe, &op);
      GetOverlappedResult(pipe, &op, count, TRUE);
      ok = FALSE;
    } else ok = GetOverlappedResult(pipe, &op, count, FALSE);
  } else if (!buffer) ok = ok || error == ERROR_PIPE_CONNECTED;
  else if (ok) ok = GetOverlappedResult(pipe, &op, count, FALSE);
  CloseHandle(op.hEvent);
  return ok;
}

static void codex_track(CodexPrototype *server, DWORD pid, HANDLE process) {
  AcquireSRWLockExclusive(&server->pin_lock);
  for (size_t i = 0; i < _countof(server->pins); i++) {
    CodexDebugPin *pin = server->pins + i;
    if (pin->process) continue;
    if (DuplicateHandle(GetCurrentProcess(), process, GetCurrentProcess(), &pin->process,
      0, FALSE, DUPLICATE_SAME_ACCESS)) {
      pin->pid = pid;
      pin->initial_breakpoint = TRUE;
    }
    break;
  }
  ReleaseSRWLockExclusive(&server->pin_lock);
}

static void codex_untrack(CodexPrototype *server, DWORD pid) {
  AcquireSRWLockExclusive(&server->pin_lock);
  for (size_t i = 0; i < _countof(server->pins); i++) {
    CodexDebugPin *pin = server->pins + i;
    if (pin->process && (pin->pid == pid || !pid)) {
      CloseHandle(pin->process);
      ZeroMemory(pin, sizeof(*pin));
    }
  }
  ReleaseSRWLockExclusive(&server->pin_lock);
}

static BOOL codex_pid_pinned(CodexPrototype *server, DWORD pid, HANDLE process) {
  BOOL match = FALSE;
  AcquireSRWLockShared(&server->pin_lock);
  for (size_t i = 0; i < _countof(server->pins); i++) {
    const CodexDebugPin *pin = server->pins + i;
    if (pin->process && pin->pid == pid && server->compare_objects(pin->process, process)) {
      match = TRUE;
      break;
    }
  }
  ReleaseSRWLockShared(&server->pin_lock);
  return match;
}

static BOOL codex_client_same_user(HANDLE process) {
  HANDLE token;
  if (!OpenProcessToken(process, TOKEN_QUERY, &token)) return FALSE;
  DWORD length = 0;
  GetTokenInformation(token, TokenUser, NULL, 0, &length);
  TOKEN_USER *client = length && length <= 65536 ? malloc(length) : NULL;
  TOKEN_USER *owner = user_of(GetCurrentProcess());
  BOOL same = client && GetTokenInformation(token, TokenUser, client, length, &length)
    && IsValidSid(client->User.Sid) && EqualSid(client->User.Sid, owner->User.Sid);
  CloseHandle(token);
  free(client);
  free(owner);
  return same;
}

static HANDLE codex_prove_connected_peer(CodexPrototype *server) {
  ULONG pid = 0, checked_pid = 0;
  if (!GetNamedPipeClientProcessId(server->pipe, &pid) || !pid || pid == server->root_pid) return NULL;
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_DUP_HANDLE | SYNCHRONIZE, FALSE, pid);
  if (!process) return NULL;
  HANDLE challenge = NULL, remote = NULL;
  if (WaitForSingleObject(process, 0) == WAIT_TIMEOUT && codex_pid_pinned(server, pid, process)
    && codex_client_same_user(process)) challenge = CreateEventW(NULL, FALSE, FALSE, NULL);
  BOOL admitted = FALSE;
  if (challenge && DuplicateHandle(GetCurrentProcess(), challenge, process, &remote, EVENT_MODIFY_STATE, FALSE, 0)) {
    /* A current process object found under a stale pipe PID cannot answer
     * through the old connector. Only this actual object can set the event.
     */
    uint64_t wire = (uint64_t)(uintptr_t)remote;
    DWORD count = 0;
    HANDLE waits[] = {server->stop, process, challenge};
    admitted = codex_overlapped(server->pipe, server->stop, FALSE, &wire, sizeof(wire), &count, CODEX_PROOF_TIMEOUT)
      && count == sizeof(wire) && WaitForMultipleObjects(_countof(waits), waits, FALSE, CODEX_PROOF_TIMEOUT)
        == WAIT_OBJECT_0 + 2
      && GetNamedPipeClientProcessId(server->pipe, &checked_pid) && checked_pid == pid
      && WaitForSingleObject(process, 0) == WAIT_TIMEOUT && codex_pid_pinned(server, pid, process);
    /* The relay closes the remote handle after use. On timeout its eventual
     * process teardown owns it. Closing a numeric handle remotely could hit
     * an unrelated handle if a client already recycled the value.
     */
  }
  if (challenge) CloseHandle(challenge);
  if (admitted) return process;
  CloseHandle(process);
  return NULL;
}

static DWORD WINAPI codex_bridge_upload(void *data) {
  CodexPrototype *server = data;
  char buffer[16384];
  DWORD read = 0, written = 0;
  while (WaitForSingleObject(server->stop, 0) == WAIT_TIMEOUT
    && ReadFile(server->bridge_input, buffer, sizeof(buffer), &read, NULL) && read
    && codex_overlapped(server->pipe, server->stop, FALSE, buffer, read, &written, CODEX_PROOF_TIMEOUT)
    && read == written) {}
  SetEvent(server->stop);
  return 0;
}

static DWORD WINAPI codex_accept(void *data) {
  CodexPrototype *server = data;
  DWORD count;
  HANDLE peer = NULL;
  while (WaitForSingleObject(server->stop, 0) == WAIT_TIMEOUT
    && codex_overlapped(server->pipe, server->stop, FALSE, NULL, 0, &count, INFINITE)) {
    peer = codex_prove_connected_peer(server);
    if (peer) break;
    DisconnectNamedPipe(server->pipe);
  }
  if (peer) {
    HANDLE upload = CreateThread(NULL, 0, codex_bridge_upload, server, 0, NULL);
    if (!upload) fail("cannot start owner bridge writer");
    char buffer[16384];
    DWORD written;
    while (WaitForSingleObject(peer, 0) == WAIT_TIMEOUT
      && codex_overlapped(server->pipe, server->stop, TRUE, buffer, sizeof(buffer), &count, INFINITE)
      && count && WriteFile(server->bridge_output, buffer, count, &written, NULL) && count == written) {}
    SetEvent(server->stop);
    /* The upload may be blocked in an inherited synchronous pipe. Retry
     * cancellation until it has observed stop or its read was cancelled.
     */
    while (WaitForSingleObject(upload, 5) == WAIT_TIMEOUT) CancelSynchronousIo(upload);
    CloseHandle(upload);
    CloseHandle(peer);
  }
  SetEvent(server->stop);
  DisconnectNamedPipe(server->pipe);
  return 0;
}

static DWORD codex_exception_status(CodexPrototype *server, const DEBUG_EVENT *event) {
  if (event->u.Exception.ExceptionRecord.ExceptionCode != EXCEPTION_BREAKPOINT
    || !event->u.Exception.dwFirstChance) return DBG_EXCEPTION_NOT_HANDLED;
  AcquireSRWLockExclusive(&server->pin_lock);
  DWORD status = DBG_EXCEPTION_NOT_HANDLED;
  for (size_t i = 0; i < _countof(server->pins); i++) {
    CodexDebugPin *pin = server->pins + i;
    if (pin->process && pin->pid == event->dwProcessId && pin->initial_breakpoint) {
      pin->initial_breakpoint = FALSE;
      status = DBG_CONTINUE;
      break;
    }
  }
  ReleaseSRWLockExclusive(&server->pin_lock);
  return status;
}

static int codex_windows_supervisor(const wchar_t *pipe, const wchar_t *executable, wchar_t *command_line) {
  CodexPrototype server = {0};
  /* Some SDK distributions declare this API but omit Kernelbase.lib.
   * Resolve the documented OS export. Its absence cannot relax admission.
   */
  HMODULE kernel = GetModuleHandleW(L"Kernelbase.dll");
  FARPROC compare = kernel ? GetProcAddress(kernel, "CompareObjectHandles") : NULL;
  if (!compare) fail("Windows process object comparison is unavailable");
  memcpy(&server.compare_objects, &compare, sizeof(server.compare_objects));
  InitializeSRWLock(&server.pin_lock);
  server.pipe = codex_protected_pipe(pipe);
  server.stop = CreateEventW(NULL, TRUE, FALSE, NULL);
  server.bridge_input = (HANDLE)_get_osfhandle(3);
  server.bridge_output = (HANDLE)_get_osfhandle(4);
  if (!server.stop || server.bridge_input == INVALID_HANDLE_VALUE || server.bridge_output == INVALID_HANDLE_VALUE)
    fail("owner must supply the two prototype bridge descriptors");

  STARTUPINFOEXW startup = {0};
  startup.StartupInfo.cb = sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  HANDLE stdio[] = {GetStdHandle(STD_INPUT_HANDLE), GetStdHandle(STD_OUTPUT_HANDLE), GetStdHandle(STD_ERROR_HANDLE)};
  for (size_t i = 0; i < _countof(stdio); i++) {
    if (!stdio[i] || !SetHandleInformation(stdio[i], HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT))
      fail("cannot pass supervisor stdio to the selected runtime");
  }
  startup.StartupInfo.hStdInput = stdio[0];
  startup.StartupInfo.hStdOutput = stdio[1];
  startup.StartupInfo.hStdError = stdio[2];
  SIZE_T bytes = 0;
  InitializeProcThreadAttributeList(NULL, 1, 0, &bytes);
  startup.lpAttributeList = malloc(bytes);
  if (!startup.lpAttributeList || !InitializeProcThreadAttributeList(startup.lpAttributeList, 1, 0, &bytes)
    || !UpdateProcThreadAttribute(startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
      stdio, sizeof(stdio), NULL, NULL)) fail("cannot restrict runtime handle inheritance");
  PROCESS_INFORMATION runtime = {0};
  if (!CreateProcessW(executable, command_line, NULL, NULL, TRUE,
    DEBUG_PROCESS | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT, NULL, NULL, &startup.StartupInfo, &runtime))
    fail("cannot start selected runtime as the root of the debug generation");
  DeleteProcThreadAttributeList(startup.lpAttributeList);
  free(startup.lpAttributeList);
  CloseHandle(runtime.hThread);
  if (!DebugSetProcessKillOnExit(TRUE)) fail("cannot own the selected runtime lifecycle");
  server.root_pid = runtime.dwProcessId;
  HANDLE accept = CreateThread(NULL, 0, codex_accept, &server, 0, NULL);
  if (!accept) fail("cannot start Codex pipe admission");

  while (WaitForSingleObject(server.stop, 0) == WAIT_TIMEOUT) {
    DEBUG_EVENT event;
    if (!WaitForDebugEvent(&event, 100)) {
      DWORD error = GetLastError();
      if (error == ERROR_SEM_TIMEOUT || error == ERROR_TIMEOUT || error == WAIT_TIMEOUT) continue;
      fail("lost Windows process creation evidence");
    }
    DWORD disposition = DBG_CONTINUE;
    if (event.dwDebugEventCode == CREATE_PROCESS_DEBUG_EVENT) {
      codex_track(&server, event.dwProcessId, event.u.CreateProcessInfo.hProcess);
      if (event.u.CreateProcessInfo.hFile) CloseHandle(event.u.CreateProcessInfo.hFile);
    } else if (event.dwDebugEventCode == LOAD_DLL_DEBUG_EVENT) {
      if (event.u.LoadDll.hFile) CloseHandle(event.u.LoadDll.hFile);
    } else if (event.dwDebugEventCode == EXIT_PROCESS_DEBUG_EVENT) {
      codex_untrack(&server, event.dwProcessId);
      if (event.dwProcessId == server.root_pid) SetEvent(server.stop);
    } else if (event.dwDebugEventCode == EXCEPTION_DEBUG_EVENT) {
      disposition = codex_exception_status(&server, &event);
    }
    if (!ContinueDebugEvent(event.dwProcessId, event.dwThreadId, disposition)) fail("cannot continue the selected runtime");
  }
  SetEvent(server.stop);
  while (WaitForSingleObject(accept, 5) == WAIT_TIMEOUT) CancelSynchronousIo(accept);
  CloseHandle(accept);
  CloseHandle(server.pipe);
  codex_untrack(&server, 0);
  CloseHandle(server.stop);
  CloseHandle(runtime.hProcess);
  /* DEBUG_PROCESS defaults to terminating debuggees when this debugger exits. */
  return 0;
}

static void codex_answer_handle_challenge(HANDLE pipe) {
  wchar_t expected[32];
  DWORD size = GetEnvironmentVariableW(L"PWRAGENT_CODEX_PROTOTYPE_SERVER_PID", expected, _countof(expected));
  ULONG pid = 0;
  if (!size || size >= _countof(expected) || !GetNamedPipeServerProcessId(pipe, &pid)
    || _wcstoui64(expected, NULL, 10) != pid) fail("unexpected Codex prototype listener process");
  HANDLE stop = CreateEventW(NULL, TRUE, FALSE, NULL);
  uint64_t remote = 0;
  DWORD count;
  if (!stop || !codex_overlapped(pipe, stop, TRUE, &remote, sizeof(remote), &count, CODEX_PROOF_TIMEOUT)
    || count != sizeof(remote) || remote > UINTPTR_MAX || !SetEvent((HANDLE)(uintptr_t)remote))
    fail("cannot prove connected Codex relay process");
  CloseHandle((HANDLE)(uintptr_t)remote);
  CloseHandle(stop);
}
