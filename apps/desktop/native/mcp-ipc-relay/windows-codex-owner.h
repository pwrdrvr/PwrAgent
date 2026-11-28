/* MIT, Copyright (c) 2026 PwrDrvr LLC.
 * Windows Codex owner transport. Inherited descriptors carry only control.
 */
#include <bcrypt.h>
#include <io.h>
#include <stdint.h>
#include <sddl.h>
#pragma comment(lib, "bcrypt.lib")

#define CODEX_PUBLIC_PREFIX L"\\\\.\\pipe\\pwa-codex-relay-"
#define CODEX_OWNER_PREFIX L"\\\\.\\pipe\\pwa-codex-owner-"
#define CODEX_SESSION_LIMIT 96
#define CODEX_PIN_LIMIT 256
#define CODEX_PROOF_TIMEOUT 3000

typedef struct {
  DWORD pid;
  HANDLE process;
  BOOL initial_breakpoint;
} CodexDebugPin;

typedef BOOL (WINAPI *CodexCompareObjects)(HANDLE, HANDLE);

typedef struct {
  HANDLE stop, owner_lifetime, owner_events, owner_process;
  const wchar_t *endpoint;
  PSECURITY_DESCRIPTOR descriptor;
  SRWLOCK event_lock;
  CodexCompareObjects compare_objects;
  DWORD root_pid;
  SRWLOCK pin_lock;
  CodexDebugPin pins[CODEX_PIN_LIMIT];
} CodexOwner;

static PSECURITY_DESCRIPTOR codex_pipe_descriptor(void) {
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
  return descriptor;
}

static HANDLE codex_protected_pipe(const CodexOwner *owner, const wchar_t *path, BOOL first, DWORD instances) {
  SECURITY_ATTRIBUTES attributes = {sizeof(attributes), owner->descriptor, FALSE};
  return CreateNamedPipeW(path, PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | (first ? FILE_FLAG_FIRST_PIPE_INSTANCE : 0),
    PIPE_TYPE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, instances, 16384, 16384, 0, &attributes);
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
  DWORD failure = ok ? ERROR_SUCCESS : (error == ERROR_IO_PENDING ? GetLastError() : error);
  CloseHandle(op.hEvent);
  if (!ok) SetLastError(failure);
  return ok;
}

static void codex_track(CodexOwner *server, DWORD pid, HANDLE process) {
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

static void codex_untrack(CodexOwner *server, DWORD pid) {
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

static BOOL codex_pid_pinned(CodexOwner *server, DWORD pid, HANDLE process) {
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

static HANDLE codex_prove_connected_peer(CodexOwner *server, HANDLE pipe, HANDLE stop) {
  ULONG pid = 0, checked_pid = 0;
  if (!GetNamedPipeClientProcessId(pipe, &pid) || !pid || pid == server->root_pid) return NULL;
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
    HANDLE waits[] = {stop, process, challenge};
    admitted = codex_overlapped(pipe, stop, FALSE, &wire, sizeof(wire), &count, CODEX_PROOF_TIMEOUT)
      && count == sizeof(wire) && WaitForMultipleObjects(_countof(waits), waits, FALSE, CODEX_PROOF_TIMEOUT)
        == WAIT_OBJECT_0 + 2
      && GetNamedPipeClientProcessId(pipe, &checked_pid) && checked_pid == pid
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

typedef struct {
  CodexOwner *owner;
  HANDLE external, inner, stop, thread;
} CodexSession;

static void codex_close_pipe(HANDLE pipe) {
  DisconnectNamedPipe(pipe);
  CloseHandle(pipe);
}

static BOOL codex_control(CodexOwner *owner, char *line) {
  DWORD length = (DWORD)strlen(line), written = 0;
  AcquireSRWLockExclusive(&owner->event_lock);
  BOOL ok = codex_overlapped(owner->owner_events, owner->stop, FALSE, line, length, &written, CODEX_PROOF_TIMEOUT)
    && written == length;
  ReleaseSRWLockExclusive(&owner->event_lock);
  if (!ok) SetEvent(owner->stop);
  return ok;
}

static BOOL codex_private_name(wchar_t *path, size_t capacity) {
  unsigned char bytes[16];
  if (BCryptGenRandom(NULL, bytes, sizeof(bytes), BCRYPT_USE_SYSTEM_PREFERRED_RNG) != 0
    || capacity < wcslen(CODEX_OWNER_PREFIX) + 33) return FALSE;
  static const wchar_t hex[] = L"0123456789abcdef";
  wcscpy_s(path, capacity, CODEX_OWNER_PREFIX);
  size_t offset = wcslen(path);
  for (size_t i = 0; i < sizeof(bytes); i++) {
    path[offset++] = hex[bytes[i] >> 4];
    path[offset++] = hex[bytes[i] & 15];
  }
  path[offset] = 0;
  return TRUE;
}

static BOOL codex_connected_owner(const CodexSession *session) {
  ULONG pid = 0;
  if (!GetNamedPipeClientProcessId(session->inner, &pid)
    || pid != GetProcessId(session->owner->owner_process)
    || WaitForSingleObject(session->owner->owner_process, 0) != WAIT_TIMEOUT) return FALSE;
  HANDLE client = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid);
  if (!client) return FALSE;
  BOOL match = session->owner->compare_objects(client, session->owner->owner_process)
    && WaitForSingleObject(client, 0) == WAIT_TIMEOUT;
  CloseHandle(client);
  return match;
}

static void codex_pump(HANDLE input, HANDLE output, HANDLE stop) {
  char buffer[16384];
  DWORD read = 0, written = 0;
  while (WaitForSingleObject(stop, 0) == WAIT_TIMEOUT
    && codex_overlapped(input, stop, TRUE, buffer, sizeof(buffer), &read, INFINITE) && read) {
    DWORD offset = 0;
    while (offset < read) {
      if (!codex_overlapped(output, stop, FALSE, buffer + offset, read - offset, &written, CODEX_PROOF_TIMEOUT)
        || !written) return;
      offset += written;
    }
  }
}

static DWORD WINAPI codex_upload(void *data) {
  CodexSession *session = data;
  codex_pump(session->inner, session->external, session->stop);
  SetEvent(session->stop);
  return 0;
}

static void codex_run_session(CodexSession *session) {
  wchar_t path[100];
  if (!codex_private_name(path, _countof(path))) return;
  session->inner = codex_protected_pipe(session->owner, path, TRUE, 1);
  if (session->inner == INVALID_HANDLE_VALUE) return;
  char line[160];
  if (sprintf_s(line, sizeof(line), "stream %ls\n", path) < 0 || !codex_control(session->owner, line)) return;
  DWORD count = 0;
  if (!codex_overlapped(session->inner, session->stop, FALSE, NULL, 0, &count, CODEX_PROOF_TIMEOUT)
    || !codex_connected_owner(session)) return;
  HANDLE upload = CreateThread(NULL, 0, codex_upload, session, 0, NULL);
  if (!upload) return;
  codex_pump(session->external, session->inner, session->stop);
  SetEvent(session->stop);
  WaitForSingleObject(upload, INFINITE);
  CloseHandle(upload);
}

static VOID CALLBACK codex_peer_exited(PVOID stop, BOOLEAN timed_out) {
  (void)timed_out;
  SetEvent((HANDLE)stop);
}

static DWORD WINAPI codex_session(void *data) {
  CodexSession *session = data;
  HANDLE peer = codex_prove_connected_peer(session->owner, session->external, session->stop);
  if (peer) {
    HANDLE monitor;
    if (RegisterWaitForSingleObject(&monitor, peer, codex_peer_exited, session->stop, INFINITE, WT_EXECUTEONLYONCE)) {
      codex_run_session(session);
      UnregisterWaitEx(monitor, INVALID_HANDLE_VALUE);
    }
    CloseHandle(peer);
  }
  if (session->inner != INVALID_HANDLE_VALUE) codex_close_pipe(session->inner);
  codex_close_pipe(session->external);
  return 0;
}

static void codex_reap_session(CodexSession *session, DWORD wait) {
  if (!session->thread || WaitForSingleObject(session->thread, wait) != WAIT_OBJECT_0) return;
  CloseHandle(session->thread);
  CloseHandle(session->stop);
  ZeroMemory(session, sizeof(*session));
}

typedef struct {
  CodexOwner *owner;
  HANDLE first;
} CodexAccept;

static DWORD WINAPI codex_accept(void *data) {
  CodexAccept *accept = data;
  CodexOwner *owner = accept->owner;
  HANDLE pending = accept->first;
  CodexSession sessions[CODEX_SESSION_LIMIT] = {0};
  while (WaitForSingleObject(owner->stop, 0) == WAIT_TIMEOUT) {
    DWORD count = 0;
    if (!codex_overlapped(pending, owner->stop, FALSE, NULL, 0, &count, INFINITE)) {
      if (GetLastError() != ERROR_NO_DATA) break;
      DisconnectNamedPipe(pending);
      continue;
    }
    CodexSession *slot = NULL;
    for (size_t i = 0; i < _countof(sessions); i++) {
      codex_reap_session(sessions + i, 0);
      if (!slot && !sessions[i].thread) slot = sessions + i;
    }
    if (!slot) {
      DisconnectNamedPipe(pending);
      continue;
    }
    // Keep a handle to the public name while creating its successor.
    HANDLE next = codex_protected_pipe(owner, owner->endpoint, FALSE, CODEX_SESSION_LIMIT + 1);
    if (next == INVALID_HANDLE_VALUE) break;
    slot->owner = owner;
    slot->external = pending;
    slot->inner = INVALID_HANDLE_VALUE;
    slot->stop = CreateEventW(NULL, TRUE, FALSE, NULL);
    if (slot->stop) slot->thread = CreateThread(NULL, 0, codex_session, slot, 0, NULL);
    if (!slot->thread) {
      if (slot->stop) CloseHandle(slot->stop);
      codex_close_pipe(pending);
      ZeroMemory(slot, sizeof(*slot));
    }
    pending = next;
  }
  SetEvent(owner->stop);
  codex_close_pipe(pending);
  for (size_t i = 0; i < _countof(sessions); i++) if (sessions[i].thread) SetEvent(sessions[i].stop);
  for (size_t i = 0; i < _countof(sessions); i++) codex_reap_session(sessions + i, INFINITE);
  return 0;
}

static DWORD WINAPI codex_watch_owner(void *data) {
  CodexOwner *owner = data;
  char byte;
  DWORD count;
  // This descriptor carries lifetime only. Any write or EOF ends the runtime.
  ReadFile(owner->owner_lifetime, &byte, sizeof(byte), &count, NULL);
  SetEvent(owner->stop);
  return 0;
}

static DWORD codex_exception_status(CodexOwner *server, const DEBUG_EVENT *event) {
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

static int codex_windows_supervisor(const wchar_t *pipe, const wchar_t *executable, wchar_t *command_line, const wchar_t *owner_pid) {
  CodexOwner server = {0};
  /* Some SDK distributions declare this API but omit Kernelbase.lib.
   * Resolve the documented OS export. Its absence cannot relax admission.
   */
  HMODULE kernel = GetModuleHandleW(L"Kernelbase.dll");
  FARPROC compare = kernel ? GetProcAddress(kernel, "CompareObjectHandles") : NULL;
  if (!compare) fail("Windows process object comparison is unavailable");
  memcpy(&server.compare_objects, &compare, sizeof(server.compare_objects));
  size_t prefix = wcslen(CODEX_PUBLIC_PREFIX);
  if (wcsncmp(pipe, CODEX_PUBLIC_PREFIX, prefix) || !pipe[prefix]
    || wcspbrk(pipe + prefix, L"\\/:?*\"<>|")) fail("expected a local Codex relay pipe name");
  wchar_t *end;
  unsigned long pid = wcstoul(owner_pid, &end, 10);
  if (!pid || *end) fail("expected the Windows owner process ID");
  InitializeSRWLock(&server.pin_lock);
  InitializeSRWLock(&server.event_lock);
  server.endpoint = pipe;
  server.descriptor = codex_pipe_descriptor();
  server.stop = CreateEventW(NULL, TRUE, FALSE, NULL);
  server.owner_process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid);
  if (!server.owner_process || WaitForSingleObject(server.owner_process, 0) != WAIT_TIMEOUT
    || !codex_client_same_user(server.owner_process)) fail("cannot pin the Windows owner process");
  server.owner_lifetime = (HANDLE)_get_osfhandle(3);
  server.owner_events = (HANDLE)_get_osfhandle(4);
  if (!server.stop || server.owner_lifetime == INVALID_HANDLE_VALUE || server.owner_events == INVALID_HANDLE_VALUE)
    fail("owner must supply both control descriptors");
  CodexAccept accept = {&server, codex_protected_pipe(&server, pipe, TRUE, CODEX_SESSION_LIMIT + 1)};
  if (accept.first == INVALID_HANDLE_VALUE) fail("cannot create first protected Codex pipe instance");

  HANDLE job = CreateJobObjectW(NULL, NULL);
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limit = {0};
  limit.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!job || !SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limit, sizeof(limit)))
    fail("cannot own the Codex runtime job");

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
    DEBUG_PROCESS | CREATE_SUSPENDED | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT, NULL, NULL, &startup.StartupInfo, &runtime))
    fail("cannot start selected runtime as the root of the debug generation");
  DeleteProcThreadAttributeList(startup.lpAttributeList);
  free(startup.lpAttributeList);
  if (!DebugSetProcessKillOnExit(TRUE) || !AssignProcessToJobObject(job, runtime.hProcess)
    || ResumeThread(runtime.hThread) == (DWORD)-1)
    fail("cannot establish the selected runtime ownership");
  CloseHandle(runtime.hThread);
  server.root_pid = runtime.dwProcessId;
  HANDLE listener = CreateThread(NULL, 0, codex_accept, &accept, 0, NULL);
  HANDLE lifetime = CreateThread(NULL, 0, codex_watch_owner, &server, 0, NULL);
  if (!listener || !lifetime) fail("cannot start Codex pipe ownership");
  char ready[48];
  if (sprintf_s(ready, sizeof(ready), "ready %lu\n", server.root_pid) < 0 || !codex_control(&server, ready))
    fail("cannot announce the verified Codex runtime");

  ULONGLONG shutdown_deadline = 0;
  int exit_code = 1;
  for (;;) {
    if (!shutdown_deadline && WaitForSingleObject(server.stop, 0) == WAIT_OBJECT_0) {
      if (!TerminateJobObject(job, 1)) fail("cannot terminate the verified Codex runtime job");
      shutdown_deadline = GetTickCount64() + CODEX_PROOF_TIMEOUT;
    }
    if (shutdown_deadline) {
      JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting = {0};
      if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), NULL))
        fail("cannot verify Codex job cleanup");
      if (!accounting.ActiveProcesses) break;
      if (GetTickCount64() >= shutdown_deadline) fail("Codex runtime job did not drain");
    }
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
      if (event.dwProcessId == server.root_pid) {
        exit_code = (int)event.u.ExitProcess.dwExitCode;
        SetEvent(server.stop);
      }
    } else if (event.dwDebugEventCode == EXCEPTION_DEBUG_EVENT) {
      disposition = codex_exception_status(&server, &event);
    }
    if (!ContinueDebugEvent(event.dwProcessId, event.dwThreadId, disposition)) fail("cannot continue the selected runtime");
  }
  SetEvent(server.stop);
  while (WaitForSingleObject(lifetime, 5) == WAIT_TIMEOUT) CancelSynchronousIo(lifetime);
  WaitForSingleObject(listener, INFINITE);
  CloseHandle(lifetime);
  CloseHandle(listener);
  codex_untrack(&server, 0);
  CloseHandle(server.stop);
  CloseHandle(server.owner_process);
  LocalFree(server.descriptor);
  CloseHandle(runtime.hProcess);
  CloseHandle(job);
  return exit_code;
}
