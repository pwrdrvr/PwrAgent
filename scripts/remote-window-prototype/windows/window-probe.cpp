// Fixture-only probe. No desktop capture, window enumeration, or arbitrary HWND input.
#include <windows.h>
#include <dwmapi.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <wincodec.h>
#include <wtsapi32.h>
#include <windows.graphics.capture.interop.h>
#include <windows.graphics.directx.direct3d11.interop.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Graphics.Capture.h>
#include <winrt/Windows.Graphics.DirectX.Direct3D11.h>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <vector>
#include <string>
#include <algorithm>

using namespace winrt;
using namespace winrt::Windows::Graphics;
using namespace winrt::Windows::Graphics::Capture;
using namespace winrt::Windows::Graphics::DirectX;
using namespace winrt::Windows::Graphics::DirectX::Direct3D11;
using Clock = std::chrono::steady_clock;
static unsigned tick = 0, clicks = 0, keys = 0;
static std::vector<BYTE> viewerPixels;
static UINT viewerWidth = 0, viewerHeight = 0;
static double ms(Clock::time_point a, Clock::time_point b) {
  return std::chrono::duration<double, std::milli>(b - a).count();
}
static void pump(unsigned duration) {
  auto end = Clock::now() + std::chrono::milliseconds(duration);
  do {
    MSG msg;
    while (PeekMessageW(&msg, nullptr, 0, 0, PM_REMOVE)) {
      TranslateMessage(&msg);
      DispatchMessageW(&msg);
    }
    Sleep(1);
  } while (Clock::now() < end);
}
static LRESULT CALLBACK windowProc(HWND hwnd, UINT message, WPARAM w, LPARAM l) {
  if (message == WM_TIMER) { ++tick; InvalidateRect(hwnd, nullptr, FALSE); return 0; }
  if (message == WM_LBUTTONDOWN) { ++clicks; InvalidateRect(hwnd, nullptr, FALSE); return 0; }
  if (message == WM_KEYDOWN) { ++keys; InvalidateRect(hwnd, nullptr, FALSE); return 0; }
  if (message == WM_DPICHANGED) {
    auto r = reinterpret_cast<RECT*>(l);
    SetWindowPos(hwnd, nullptr, r->left, r->top, r->right-r->left, r->bottom-r->top, SWP_NOZORDER);
    return 0;
  }
  if (message == WM_PAINT) {
    PAINTSTRUCT ps;
    HDC dc = BeginPaint(hwnd, &ps);
    RECT r;
    GetClientRect(hwnd, &r);
    bool occluder = GetWindowLongPtrW(hwnd, GWLP_USERDATA) == 1;
    HBRUSH brush = CreateSolidBrush(occluder ? RGB(210, 38, 82) : RGB(14, 28, 48));
    FillRect(dc, &r, brush);
    DeleteObject(brush);
    SetTextColor(dc, RGB(240, 245, 255));
    SetBkMode(dc, TRANSPARENT);
    if (!viewerPixels.empty() && !occluder) {
      BITMAPINFO info{};
      info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
      info.bmiHeader.biWidth = viewerWidth;
      info.bmiHeader.biHeight = -static_cast<LONG>(viewerHeight);
      info.bmiHeader.biPlanes = 1;
      info.bmiHeader.biBitCount = 32;
      info.bmiHeader.biCompression = BI_RGB;
      SetStretchBltMode(dc, HALFTONE);
      StretchDIBits(dc, 0, 0, r.right, r.bottom, 0, 0, viewerWidth, viewerHeight,
        viewerPixels.data(), &info, DIB_RGB_COLORS, SRCCOPY);
    } else {
      std::wstring text = occluder ? L"OWNED OCCLUDER - NOT THE CAPTURE TARGET" :
        L"PwrAgent / synthetic single-window fixture\nNo private data\nFrame " + std::to_wstring(tick)
        + L"   clicks " + std::to_wstring(clicks) + L"   keys " + std::to_wstring(keys);
      RECT textRect{24, 24, r.right - 20, 125};
      DrawTextW(dc, text.c_str(), -1, &textRect, DT_LEFT | DT_WORDBREAK);
      RECT bar{24 + static_cast<LONG>(tick % 200), 145, 180 + static_cast<LONG>(tick % 200), 225};
      HBRUSH accent = CreateSolidBrush(RGB(28, 205, 175));
      FillRect(dc, &bar, accent);
      DeleteObject(accent);
    }
    EndPaint(hwnd, &ps);
    return 0;
  }
  return DefWindowProcW(hwnd, message, w, l);
}
static com_ptr<IWICImagingFactory> imaging() {
  com_ptr<IWICImagingFactory> factory;
  check_hresult(CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(factory.put())));
  return factory;
}
static void png(const std::filesystem::path& path, UINT width, UINT height, BYTE* pixels, UINT stride) {
  auto factory = imaging();
  com_ptr<IWICStream> stream;
  check_hresult(factory->CreateStream(stream.put()));
  check_hresult(stream->InitializeFromFilename(path.c_str(), GENERIC_WRITE));
  com_ptr<IWICBitmapEncoder> encoder;
  check_hresult(factory->CreateEncoder(GUID_ContainerFormatPng, nullptr, encoder.put()));
  check_hresult(encoder->Initialize(stream.get(), WICBitmapEncoderNoCache));
  com_ptr<IWICBitmapFrameEncode> frame;
  com_ptr<IPropertyBag2> props;
  check_hresult(encoder->CreateNewFrame(frame.put(), props.put()));
  check_hresult(frame->Initialize(props.get()));
  check_hresult(frame->SetSize(width, height));
  WICPixelFormatGUID format = GUID_WICPixelFormat32bppBGRA;
  check_hresult(frame->SetPixelFormat(&format));
  check_hresult(frame->WritePixels(height, stride, stride * height, pixels));
  check_hresult(frame->Commit());
  check_hresult(encoder->Commit());
}
struct WindowCapture {
  com_ptr<ID3D11Device> device;
  com_ptr<ID3D11DeviceContext> context;
  IDirect3DDevice direct{nullptr};
  GraphicsCaptureItem item{nullptr};
  Direct3D11CaptureFramePool pool{nullptr};
  GraphicsCaptureSession session{nullptr};
  SizeInt32 size{};
  explicit WindowCapture(HWND hwnd) {
    DWORD owner = 0;
    GetWindowThreadProcessId(hwnd, &owner);
    if (owner != GetCurrentProcessId()) throw std::runtime_error("Only this process's fixture HWND is allowed");
    check_hresult(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr,
      D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0, D3D11_SDK_VERSION, device.put(), nullptr, context.put()));
    auto dxgi = device.as<IDXGIDevice>();
    com_ptr<IInspectable> inspectable;
    check_hresult(CreateDirect3D11DeviceFromDXGIDevice(dxgi.get(), inspectable.put()));
    direct = inspectable.as<IDirect3DDevice>();
    auto interop = get_activation_factory<GraphicsCaptureItem, IGraphicsCaptureItemInterop>();
    check_hresult(interop->CreateForWindow(hwnd, guid_of<GraphicsCaptureItem>(), put_abi(item)));
    size = item.Size();
    pool = Direct3D11CaptureFramePool::CreateFreeThreaded(direct, DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, size);
    session = pool.CreateCaptureSession(item);
    // Keep OS capture indication and permission behavior unchanged.
    session.StartCapture();
  }
  ~WindowCapture() { if (session) session.Close(); if (pool) pool.Close(); }
  bool save(Direct3D11CaptureFrame const& frame, const std::filesystem::path& path) {
    auto content = frame.ContentSize();
    auto access = frame.Surface().as<::Windows::Graphics::DirectX::Direct3D11::IDirect3DDxgiInterfaceAccess>();
    com_ptr<ID3D11Texture2D> texture;
    check_hresult(access->GetInterface(IID_PPV_ARGS(texture.put())));
    D3D11_TEXTURE2D_DESC desc;
    texture->GetDesc(&desc);
    if (content.Width <= 0 || content.Height <= 0 || content.Width > static_cast<int>(desc.Width)
      || content.Height > static_cast<int>(desc.Height)) return false;
    desc.Width = content.Width;
    desc.Height = content.Height;
    desc.Usage = D3D11_USAGE_STAGING;
    desc.BindFlags = 0;
    desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    desc.MiscFlags = 0;
    com_ptr<ID3D11Texture2D> staging;
    check_hresult(device->CreateTexture2D(&desc, nullptr, staging.put()));
    D3D11_BOX box{0, 0, 0, desc.Width, desc.Height, 1};
    context->CopySubresourceRegion(staging.get(), 0, 0, 0, 0, texture.get(), 0, &box);
    D3D11_MAPPED_SUBRESOURCE mapped;
    check_hresult(context->Map(staging.get(), 0, D3D11_MAP_READ, 0, &mapped));
    try { png(path, desc.Width, desc.Height, static_cast<BYTE*>(mapped.pData), mapped.RowPitch); }
    catch (...) { context->Unmap(staging.get(), 0); throw; }
    context->Unmap(staging.get(), 0);
    return true;
  }
};
static void printWindow(HWND hwnd, const std::filesystem::path& path, std::ostream& report) {
  RECT r;
  GetClientRect(hwnd, &r);
  if (r.right <= 0 || r.bottom <= 0) {
    report << "{\"api\":\"PrintWindow(PW_CLIENTONLY)\",\"success\":false,\"reason\":\"empty minimized client\"}";
    return;
  }
  HDC screen = GetDC(hwnd), dc = CreateCompatibleDC(screen);
  BITMAPINFO info{};
  info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
  info.bmiHeader.biWidth = r.right;
  info.bmiHeader.biHeight = -r.bottom;
  info.bmiHeader.biPlanes = 1;
  info.bmiHeader.biBitCount = 32;
  void* pixels = nullptr;
  HBITMAP bitmap = CreateDIBSection(screen, &info, DIB_RGB_COLORS, &pixels, nullptr, 0);
  if (!bitmap || !pixels) throw std::runtime_error("CreateDIBSection failed");
  auto old = SelectObject(dc, bitmap);
  auto start = Clock::now();
  BOOL ok = PrintWindow(hwnd, dc, PW_CLIENTONLY);
  auto elapsed = ms(start, Clock::now());
  if (ok) {
    auto bytes = static_cast<BYTE*>(pixels);
    for (int i = 0; i < r.right * r.bottom; ++i) bytes[i * 4 + 3] = 255;
    png(path, r.right, r.bottom, bytes, r.right * 4);
  }
  report << "{\"api\":\"PrintWindow(PW_CLIENTONLY)\",\"success\":" << (ok ? "true" : "false")
    << ",\"call_ms\":" << elapsed << ",\"width\":" << r.right << ",\"height\":" << r.bottom
    << ",\"png_bytes\":" << (ok ? std::filesystem::file_size(path) : 0) << "}";
  SelectObject(dc, old);
  DeleteObject(bitmap);
  DeleteDC(dc);
  ReleaseDC(hwnd, screen);
}
static void stage(WindowCapture& cap, HWND hwnd, const std::string& name,
  const std::filesystem::path& output, std::ostream& report) {
  const auto start = Clock::now();
  unsigned count = 0, resized = 0, saved = 0;
  std::vector<double> arrivals;
  double encode = 0;
  UINT width = 0, height = 0;
  auto path = output / ("wgc-" + name + ".png");
  while (ms(start, Clock::now()) < 2200) {
    pump(2);
    auto frame = cap.pool.TryGetNextFrame();
    if (!frame) continue;
    auto content = frame.ContentSize();
    arrivals.push_back(ms(start, Clock::now()));
    ++count;
    if (content.Width != cap.size.Width || content.Height != cap.size.Height) {
      cap.size = content;
      frame.Close();
      if (content.Width > 0 && content.Height > 0) {
        cap.pool.Recreate(cap.direct, DirectXPixelFormat::B8G8R8A8UIntNormalized, 2, content);
        ++resized;
      }
      continue;
    }
    if (!saved && ms(start, Clock::now()) > 300) {
      auto encodeStart = Clock::now();
      if (cap.save(frame, path)) { saved = 1; width = content.Width; height = content.Height; }
      encode = ms(encodeStart, Clock::now());
    }
    frame.Close();
  }
  report << "{\"state\":\"" << name << "\",\"duration_ms\":" << ms(start, Clock::now())
    << ",\"frames\":" << count << ",\"dpi\":" << GetDpiForWindow(hwnd)
    << ",\"pool_recreates\":" << resized << ",\"saved_width\":" << width << ",\"saved_height\":" << height
    << ",\"readback_png_ms\":" << encode << ",\"png_bytes\":" << (saved ? std::filesystem::file_size(path) : 0)
    << ",\"arrival_ms\":[";
  for (size_t i = 0; i < arrivals.size(); ++i) report << (i ? "," : "") << arrivals[i];
  report << "],\"fallback\":";
  printWindow(hwnd, output / ("printwindow-" + name + ".png"), report);
  report << "}";
}
int wmain(int argc, wchar_t** argv) {
  try {
    if (argc < 2) { std::cerr << "Usage: window-probe OUTPUT_DIR [FIXTURE_IMAGE]\n"; return 2; }
    std::filesystem::path output(argv[1]);
    std::filesystem::create_directories(output);
    init_apartment(apartment_type::multi_threaded);
    BOOL dpiAware = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    DWORD sessionId = 0;
    ProcessIdToSessionId(GetCurrentProcessId(), &sessionId);
    WTS_CONNECTSTATE_CLASS connection = WTSDisconnected;
    LPWSTR connectionBuffer = nullptr;
    DWORD connectionBytes = 0;
    bool sessionKnown = WTSQuerySessionInformationW(WTS_CURRENT_SERVER_HANDLE, sessionId,
      WTSConnectState, &connectionBuffer, &connectionBytes) != FALSE;
    if (sessionKnown && connectionBytes >= sizeof(connection)) {
      connection = *reinterpret_cast<WTS_CONNECTSTATE_CLASS*>(connectionBuffer);
    }
    if (connectionBuffer) WTSFreeMemory(connectionBuffer);
    auto desktop = OpenInputDesktop(0, FALSE, DESKTOP_READOBJECTS);
    DWORD desktopError = desktop ? 0 : GetLastError();
    wchar_t desktopName[100]{};
    DWORD needed = 0;
    if (desktop) GetUserObjectInformationW(desktop, UOI_NAME, desktopName, sizeof(desktopName), &needed);
    BOOL composition = FALSE;
    DwmIsCompositionEnabled(&composition);
    bool supported = false;
    unsigned supportError = 0;
    try { supported = GraphicsCaptureSession::IsSupported(); }
    catch (hresult_error const& error) { supportError = static_cast<unsigned>(error.code().value); }
    std::ofstream report(output / "windows-benchmark.json");
    report << "{\"schema\":1,\"session_id\":" << sessionId << ",\"input_desktop_open\":" << (desktop ? "true" : "false")
      << ",\"input_desktop_error\":" << desktopError
      << ",\"session_state_known\":" << (sessionKnown ? "true" : "false")
      << ",\"session_active\":" << (sessionKnown && connection == WTSActive ? "true" : "false")
      << ",\"default_input_desktop\":" << (wcscmp(desktopName, L"Default") == 0 ? "true" : "false")
      << ",\"per_monitor_v2_set\":" << (dpiAware ? "true" : "false")
      << ",\"dwm_enabled\":" << (composition ? "true" : "false")
      << ",\"display_count\":" << GetSystemMetrics(SM_CMONITORS)
      << ",\"wgc_supported\":" << (supported ? "true" : "false")
      << ",\"wgc_support_hresult\":" << supportError;
    bool ready = sessionKnown && connection == WTSActive && desktop && wcscmp(desktopName, L"Default") == 0;
    if (desktop) CloseDesktop(desktop);
    if (!ready) {
      report << ",\"blocked\":\"Active session and Default input desktop required; no capture or input attempted\"}\n";
      std::cerr << "Active session and Default input desktop required; refusing focus/capture experiment.\n";
      return 3;
    }
    if (!sessionId || !supported) {
      report << ",\"blocked\":\"WGC unavailable; no capture or input attempted\"}\n";
      return 3;
    }
    WNDCLASSW wc{};
    wc.lpfnWndProc = windowProc;
    wc.hInstance = GetModuleHandleW(nullptr);
    wc.lpszClassName = L"PwrAgentOwnedCaptureFixture";
    wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    if (!RegisterClassW(&wc)) throw std::runtime_error("RegisterClass failed");
    auto hwnd = CreateWindowExW(0, wc.lpszClassName, L"PwrAgent synthetic window capture fixture", WS_OVERLAPPEDWINDOW,
      100, 100, 720, 420, nullptr, nullptr, wc.hInstance, nullptr);
    if (!hwnd) throw std::runtime_error("CreateWindow failed");
    if (argc > 2) {
      auto start = Clock::now();
      auto factory = imaging();
      com_ptr<IWICBitmapDecoder> decoder;
      check_hresult(factory->CreateDecoderFromFilename(argv[2], nullptr, GENERIC_READ, WICDecodeMetadataCacheOnLoad, decoder.put()));
      com_ptr<IWICBitmapFrameDecode> image;
      check_hresult(decoder->GetFrame(0, image.put()));
      check_hresult(image->GetSize(&viewerWidth, &viewerHeight));
      if (viewerWidth > 8192 || viewerHeight > 8192) throw std::runtime_error("Fixture image too large");
      com_ptr<IWICFormatConverter> converter;
      check_hresult(factory->CreateFormatConverter(converter.put()));
      check_hresult(converter->Initialize(image.get(), GUID_WICPixelFormat32bppBGRA, WICBitmapDitherTypeNone, nullptr, 0, WICBitmapPaletteTypeCustom));
      viewerPixels.resize(static_cast<size_t>(viewerWidth) * viewerHeight * 4);
      check_hresult(converter->CopyPixels(nullptr, viewerWidth * 4, static_cast<UINT>(viewerPixels.size()), viewerPixels.data()));
      report << ",\"viewer\":{\"encoded_bytes\":" << std::filesystem::file_size(argv[2])
        << ",\"decoded_bytes\":" << viewerPixels.size() << ",\"width\":" << viewerWidth << ",\"height\":" << viewerHeight
        << ",\"file_decode_ms\":" << ms(start, Clock::now()) << "}";
      SetWindowTextW(hwnd, L"PwrAgent remote fixture viewer");
    } else SetTimer(hwnd, 1, 33, nullptr);
    ShowWindow(hwnd, SW_SHOWNORMAL);
    UpdateWindow(hwnd);
    pump(400);
    {
      WindowCapture cap(hwnd);
      report << ",\"stages\":[";
      stage(cap, hwnd, "visible", output, report);
      RECT r;
      GetWindowRect(hwnd, &r);
      auto occluder = CreateWindowExW(0, wc.lpszClassName, L"Owned synthetic occluder", WS_OVERLAPPEDWINDOW,
        r.left - 10, r.top - 10, r.right-r.left + 20, r.bottom-r.top + 20, nullptr, nullptr, wc.hInstance, nullptr);
      SetWindowLongPtrW(occluder, GWLP_USERDATA, 1);
      ShowWindow(occluder, SW_SHOWNORMAL);
      SetWindowPos(occluder, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
      pump(300);
      report << ",";
      stage(cap, hwnd, "obscured", output, report);
      DestroyWindow(occluder);
      SetWindowPos(hwnd, nullptr, 0, 0, 960, 540, SWP_NOMOVE | SWP_NOZORDER);
      pump(100);
      report << ",";
      stage(cap, hwnd, "resized", output, report);
      ShowWindow(hwnd, SW_MINIMIZE);
      pump(300);
      report << ",";
      stage(cap, hwnd, "minimized", output, report);
      ShowWindow(hwnd, SW_RESTORE);
      pump(300);
      report << ",";
      stage(cap, hwnd, "restored", output, report);
      report << "]";
    }
    // Capture has ended. A separate input probe targets only our focused fixture.
    SetForegroundWindow(hwnd);
    SetFocus(hwnd);
    pump(100);
    bool focused = GetForegroundWindow() == hwnd;
    auto beforeKeys = keys, beforeClicks = clicks;
    UINT delivered = 0;
    auto inputStart = Clock::now();
    if (focused) {
      INPUT input[2]{};
      input[0].type = INPUT_KEYBOARD;
      input[0].ki.wVk = VK_F8;
      input[1] = input[0];
      input[1].ki.dwFlags = KEYEVENTF_KEYUP;
      delivered = SendInput(2, input, sizeof(INPUT));
      pump(100);
    }
    // Window message targeting is measured separately; it is not SendInput or OS hit-testing.
    PostMessageW(hwnd, WM_LBUTTONDOWN, MK_LBUTTON, MAKELPARAM(30, 30));
    PostMessageW(hwnd, WM_LBUTTONUP, 0, MAKELPARAM(30, 30));
    pump(100);
    report << ",\"input\":{\"capture_session_closed\":true,\"fixture_foreground\":" << (focused ? "true" : "false")
      << ",\"sendinput_events_inserted\":" << delivered << ",\"fixture_keydown_received\":" << keys-beforeKeys
      << ",\"postmessage_click_received\":" << clicks-beforeClicks << ",\"wait_inclusive_ms\":" << ms(inputStart, Clock::now()) << "}}\n";
    DestroyWindow(hwnd);
    std::cout << "Completed fixture-only WGC/PrintWindow/input probe.\n";
    return 0;
  } catch (hresult_error const& error) {
    std::cerr << "Windows HRESULT: 0x" << std::hex << static_cast<unsigned>(error.code().value) << "\n";
    return 1;
  } catch (std::exception const& error) {
    std::cerr << error.what() << "\n";
    return 1;
  }
}
