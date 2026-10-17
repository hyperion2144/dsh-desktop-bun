// 照抄官方 apps/desktop/installer/window-frame.cpp 的机制：
//   进度页 = stock instfiles 之上盖一个自绘子窗口（subclass 藏 stock 页 + 16ms 定时重绘 + 阶段 prop 驱动）；
//   窗体   = DWM 圆角/阴影 + 客户区吞掉非客户区（InstallerApplyFrame）。
// 绘制层换成我们批准的原型（docs/design/windows-installer-ui-prototype.html）：瓦片 + 标题 + 步骤清单 + 百分比 + 圆角进度条。
// 只移植进度/窗体所需导出；7za 解压监督（InstallerExtract）与卸载清理不在本仓范围。
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#define UNICODE
#include <windows.h>
#include <objidl.h>     // IUnknown：GDI+ 头要求先包含（官方同款）
#include <commctrl.h>
#include <dwmapi.h>
#include <gdiplus.h>
#include <new>
#include <algorithm>
#include <tlhelp32.h>   // 进程枚举（Toolhelp32）：按安装路径找/杀残留实例
#include "progress.h"

using namespace Gdiplus;

namespace {

int g_diagStage = 0;   // InstallerShowProgress 的失败阶段（1=分配 2=GDI+ 3=subclass 4=瓦片 5=建窗）
DWORD g_diagGLE = 0;   // 失败处的 GetLastError()
DWORD g_diagPathLen = 0;   // DLL 实际收到的 tile 路径长度（校验字符串编组）
DWORD g_diagAttrs = 0xFFFFFFFFu;   // GetFileAttributesW(tile)（INVALID = 路径不通）
DWORD g_strLen[4] = {0, 0, 0, 0};   // 收到的字符串长度（0xFFFFFFFF=NULL）：appName/headline/preparing/tile

constexpr COLORREF kDarkBackground = RGB(20, 20, 23);     // #141417
constexpr COLORREF kLightBackground = RGB(255, 255, 255);
constexpr COLORREF kDarkInk = RGB(242, 243, 245);         // #F2F3F5
constexpr COLORREF kLightInk = RGB(15, 17, 21);           // #0F1115
constexpr COLORREF kDarkDim = RGB(167, 172, 180);         // #A7ACB4
constexpr COLORREF kLightDim = RGB(90, 96, 105);          // #5A6069
constexpr COLORREF kDarkTrack = RGB(44, 44, 51);          // #2C2C33
constexpr COLORREF kLightTrack = RGB(231, 233, 238);      // #E7E9EE
constexpr COLORREF kAccent = RGB(77, 107, 254);           // #4D6BFE

constexpr wchar_t kStageProp[] = L"HarnessInstaller.Stage";
constexpr int kTileSize = 44;
constexpr int kBarX = 32;
constexpr int kBarY = 452;
constexpr int kBarWidth = 536;
constexpr int kBarHeight = 8;
constexpr int kStepTop = 296;
constexpr int kStepGap = 40;

Color ArgbOf(COLORREF value, BYTE alpha = 255) {
    return Color(alpha, GetRValue(value), GetGValue(value), GetBValue(value));
}

}  // namespace

struct ProgressPage {
    InstallProgress progress{GetTickCount64()};
    bool dark;
    UINT dpi;
    ULONG_PTR gdiplus;
    Image* tile;
    WCHAR appName[96];
    WCHAR headline[96];
    WCHAR captions[4][128];
    HWND stockBar;                     // 被藏住的 NSIS stock 进度条：解压阶段从它读真实百分比（PBM_GETPOS）
    int lastPercent;                   // 上次画过的值；没变化就不重绘，别抢解压线程的 CPU
    int lastStage;
    WCHAR cancel[64];                  // 取消按钮文案
};

// NSIS 在 SHOW 回调之后还会把 stock 页摆回来；subclass 把它永久按住。
static LRESULT CALLBACK HiddenPageProc(HWND window, UINT message, WPARAM wparam,
                                       LPARAM lparam, UINT_PTR id, DWORD_PTR) {
    if (message == WM_WINDOWPOSCHANGING) {
        auto* position = reinterpret_cast<WINDOWPOS*>(lparam);
        position->flags = (position->flags & ~SWP_SHOWWINDOW) | SWP_HIDEWINDOW;
    }
    if (message == WM_NCDESTROY) RemoveWindowSubclass(window, HiddenPageProc, id);
    return DefSubclassProc(window, message, wparam, lparam);
}

// 圆角进度条：8px 高、半径 4 的胶囊条（原型 spec）。
static void FillProgress(Graphics& graphics, Brush& brush, REAL width) {
    if (width <= 0) return;
    if (width < kBarHeight) {
        graphics.FillRectangle(&brush, static_cast<REAL>(kBarX), static_cast<REAL>(kBarY), width,
                               static_cast<REAL>(kBarHeight));
        return;
    }
    const REAL arc = static_cast<REAL>(kBarHeight);
    const REAL top = static_cast<REAL>(kBarY);
    const REAL left = static_cast<REAL>(kBarX);
    GraphicsPath path;
    path.AddArc(left, top, arc, arc, 180.0f, 90.0f);
    path.AddArc(left + width - arc, top, arc, arc, 270.0f, 90.0f);
    path.AddArc(left + width - arc, top, arc, arc, 0.0f, 90.0f);
    path.AddArc(left, top, arc, arc, 90.0f, 90.0f);
    path.CloseFigure();
    graphics.FillPath(&brush, &path);
}

// 幽灵按钮（取消）：仅描边+居中文字，点中发 stock IDCANCEL（NSIS 标准中止→回滚）。
static void GhostButton(Graphics& graphics, const Brush& brush, const Font& font,
                        REAL x, REAL y, REAL w, REAL h, const WCHAR* label) {
    const REAL d = 20.0f;   // r10 逻辑像素
    GraphicsPath path;
    path.AddArc(x, y, d, d, 180.0f, 90.0f);
    path.AddArc(x + w - d, y, d, d, 270.0f, 90.0f);
    path.AddArc(x + w - d, y + h - d, d, d, 0.0f, 90.0f);
    path.AddArc(x, y + h - d, d, d, 90.0f, 90.0f);
    path.CloseFigure();
    Pen border(&brush, 1.0f);
    graphics.DrawPath(&border, &path);
    StringFormat centered;
    centered.SetAlignment(StringAlignmentCenter);
    centered.SetLineAlignment(StringAlignmentCenter);
    graphics.DrawString(label, -1, &font, RectF(x, y, w, h), &centered, &brush);
}

// 步骤清单：完成=accent 实心+白勾，进行中=accent 圆环，未开始=弱色点。
static void DrawSteps(Graphics& graphics, const ProgressPage& page, const Font& label,
                      const Brush& ink, const Brush& dim) {
    const SolidBrush accentBrush(ArgbOf(kAccent));
    const Pen accentPen(ArgbOf(kAccent), 2.0f);
    const SolidBrush pendingBrush(page.dark ? Color(255, 78, 82, 90) : Color(255, 216, 220, 226));
    const Pen checkPen(Color(255, 255, 255, 255), 2.0f);
    for (int step = 0; step < 4; ++step) {
        const REAL y = static_cast<REAL>(kStepTop + step * kStepGap);
        const bool done = page.progress.succeeded || page.progress.stage > step;
        const bool current = !done && page.progress.stage == step;   // stage 即当前步下标（与顶部文案同源，修复圈/勾错位）
        if (done) {
            graphics.FillEllipse(&accentBrush, static_cast<REAL>(kBarX), y, 18.0f, 18.0f);
            graphics.DrawLine(&checkPen, 37.0f, y + 9.0f, 40.0f, y + 12.0f);
            graphics.DrawLine(&checkPen, 40.0f, y + 12.0f, 46.0f, y + 5.0f);
        } else if (current) {
            graphics.DrawEllipse(&accentPen, static_cast<REAL>(kBarX) + 1.0f, y + 1.0f, 16.0f, 16.0f);
        } else {
            graphics.FillEllipse(&pendingBrush, static_cast<REAL>(kBarX), y, 18.0f, 18.0f);
        }
        graphics.DrawString(page.captions[step], -1, &label, RectF(60.0f, y - 3.0f, 360.0f, 24.0f),
                            nullptr, current ? &ink : &dim);
    }
}

static LRESULT CALLBACK ProgressProc(HWND window, UINT message, WPARAM wparam, LPARAM lparam) {
    auto* page = reinterpret_cast<ProgressPage*>(GetWindowLongPtrW(window, GWLP_USERDATA));
    if (message == WM_CREATE) {
        page = static_cast<ProgressPage*>(reinterpret_cast<CREATESTRUCTW*>(lparam)->lpCreateParams);
        SetWindowLongPtrW(window, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(page));
         SetTimer(window, 1, 200, nullptr);   // 5fps 足够：60fps 全量重绘（200% DPI 单帧 10-30ms）曾把解压线程拖慢数倍
    }
    if (message == WM_ERASEBKGND) return 1;
    if (message == WM_TIMER) {
        // 解压阶段从被藏住的 stock 进度条读真实百分比（NSIS 藏了仍在跳）；其余阶段时间估算
        const int stage = static_cast<int>(reinterpret_cast<INT_PTR>(GetPropW(GetParent(window), kStageProp)));
        REAL fraction = 0.0f;
        if (stage == 1 && page && page->stockBar) {
            const LRESULT pos = SendMessageW(page->stockBar, 0x0408 /* PBM_GETPOS */, 0, 0);
            // stock 条的量程是 0..30000（instfiles 里 PBM_SETRANGE MAKELPARAM(0,30000)，exec.c 用 MulDiv(barpos,30000,len) 摆位置），
            // 不是百分比！除 100 一上去就封顶，条子直接从 0 跳满、看着像假的。
            if (pos > 0) fraction = static_cast<REAL>(pos) / 30000.0f;
        }
        if (page) page->progress.Advance(stage, fraction, GetTickCount64());
        if (page && (static_cast<int>(page->progress.value) != page->lastPercent || page->progress.stage != page->lastStage)) {
            page->lastPercent = static_cast<int>(page->progress.value);
            page->lastStage = page->progress.stage;
            InvalidateRect(window, nullptr, FALSE);   // 数值没变就不重绘
        }
        return 0;
    }
    if (message == WM_LBUTTONDOWN && page) {
        const int x = LOWORD(lparam) * 96 / page->dpi;
        const int y = HIWORD(lparam) * 96 / page->dpi;
        if (y < 44) {
            HWND parent = GetParent(window);
            if (x >= 556) PostMessageW(parent, WM_COMMAND, 2, 0);   // WM_CLOSE 会被 NSIS 吞掉，走 stock 取消命令（IDCANCEL=2）
            else if (x >= 512) ShowWindow(parent, SW_MINIMIZE);
            else { ReleaseCapture(); SendMessageW(parent, WM_NCLBUTTONDOWN, HTCAPTION, 0); }
        } else if (x >= 448 && x <= 576 && y >= 508 && y <= 560) {
            PostMessageW(GetParent(window), WM_COMMAND, 2, 0);   // 取消按钮：解压期间随时可中止，NSIS 标准取消→回滚
        }
        return 0;
    }
    if (message == WM_PAINT && page) {
        PAINTSTRUCT paint;
        HDC dc = BeginPaint(window, &paint);
        {
            Bitmap buffer(MulDiv(600, page->dpi, 96), MulDiv(600, page->dpi, 96), PixelFormat32bppPARGB);
            Graphics graphics(&buffer);
            graphics.ScaleTransform(page->dpi / 96.0f, page->dpi / 96.0f);
            graphics.Clear(page->dark ? ArgbOf(kDarkBackground) : ArgbOf(kLightBackground));
            graphics.SetSmoothingMode(SmoothingModeAntiAlias);
            graphics.SetInterpolationMode(InterpolationModeHighQualityBicubic);
            graphics.SetPixelOffsetMode(PixelOffsetModeHalf);
            SolidBrush ink(page->dark ? ArgbOf(kDarkInk) : ArgbOf(kLightInk));
            SolidBrush dim(page->dark ? ArgbOf(kDarkDim) : ArgbOf(kLightDim));
            SolidBrush accentBrush(ArgbOf(kAccent));
            const FontFamily family(L"Microsoft YaHei UI");
            const Font title(&family, 26, FontStyleBold, UnitPixel);
            const Font subtitle(&family, 13, FontStyleRegular, UnitPixel);
            const Font appName(&family, 14, FontStyleBold, UnitPixel);
            const Font percentFont(&family, 20, FontStyleBold, UnitPixel);
            if (page->tile) {
                graphics.DrawImage(page->tile, Rect(32, 44, kTileSize, kTileSize));
            }
            graphics.DrawString(page->appName, -1, &appName, RectF(88.0f, 44.0f, 300.0f, 44.0f),
                                nullptr, &ink);
            graphics.DrawString(page->headline, -1, &title, RectF(32.0f, 128.0f, 536.0f, 44.0f),
                                nullptr, &ink);
            // 模型状态由 WM_TIMER 推进（含解压真百分比）；PAINT 只画不算，抢 CPU 的锅在 timer 频率
            const int percent = static_cast<int>(page->progress.value);
            const int caption = std::min(3, page->progress.stage);   // 与 DrawSteps 同源：stage 即当前步下标
            graphics.DrawString(page->captions[caption], -1, &subtitle, RectF(32.0f, 186.0f, 536.0f, 24.0f),
                                nullptr, &dim);
            DrawSteps(graphics, *page, subtitle, ink, dim);
            WCHAR percentText[16];
            wsprintfW(percentText, L"%d%%", percent);
            StringFormat right;
            right.SetAlignment(StringAlignmentFar);
            right.SetLineAlignment(StringAlignmentCenter);
            graphics.DrawString(percentText, -1, &percentFont, RectF(368.0f, 414.0f, 200.0f, 32.0f),
                                &right, &ink);
            SolidBrush track(page->dark ? ArgbOf(kDarkTrack) : ArgbOf(kLightTrack));
            FillProgress(graphics, track, static_cast<REAL>(kBarWidth));
            FillProgress(graphics, accentBrush, kBarWidth * static_cast<REAL>(percent) / 100);
            StringFormat centered;
            centered.SetAlignment(StringAlignmentCenter);
            centered.SetLineAlignment(StringAlignmentCenter);
            const Font controls(&family, 16, FontStyleRegular, UnitPixel);
            graphics.DrawString(L"\x2212", -1, &controls, RectF(512.0f, 6.0f, 44.0f, 32.0f), &centered, &ink);
            graphics.DrawString(L"\x00d7", -1, &controls, RectF(556.0f, 6.0f, 44.0f, 32.0f), &centered, &ink);
            GhostButton(graphics, dim, subtitle, 456.0f, 516.0f, 112.0f, 36.0f, page->cancel);
            Graphics screen(dc);
            screen.DrawImage(&buffer, 0, 0);
        }
        EndPaint(window, &paint);
        return 0;
    }
    if (message == WM_NCDESTROY && page) {
        KillTimer(window, 1);
        delete page->tile;
        GdiplusShutdown(page->gdiplus);
        delete page;
    }
    return DefWindowProcW(window, message, wparam, lparam);
}

// 在 NSIS UI 线程上执行；stock 安装段跑在它自己的 worker 线程。
extern "C" __declspec(dllexport) HWND __cdecl InstallerShowProgress(HWND parent, HWND source,
        BOOL dark, UINT dpi, const WCHAR* appName, const WCHAR* headline,
        const WCHAR* preparing, const WCHAR* copying, const WCHAR* registering, const WCHAR* cleaning,
        const WCHAR* tile, const WCHAR* cancel) {
    HINSTANCE module = GetModuleHandleW(nullptr);
    WNDCLASSW type = {};
    type.lpfnWndProc = ProgressProc;
    type.hInstance = module;
    type.lpszClassName = L"DshInstallerProgress";
    type.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    RegisterClassW(&type);
    auto* page = new (std::nothrow) ProgressPage{};
    if (!page) { g_diagStage = 1; return nullptr; }
    GdiplusStartupInput startup;
    if (GdiplusStartup(&page->gdiplus, &startup, nullptr) != Ok) { g_diagStage = 2; delete page; return nullptr; }
    HWND stockPage = GetParent(source);

    if (!SetWindowSubclass(stockPage, HiddenPageProc, 1, 0)) {
        g_diagStage = 3; GdiplusShutdown(page->gdiplus); delete page; return nullptr;
    }
    ShowWindow(stockPage, SW_HIDE);
    page->dark = dark != FALSE;
    page->dpi = dpi;
    page->stockBar = source;                 // source = stock 进度条（1004），解压阶段从这里读真实百分比
    page->lastPercent = -1;
    page->lastStage = -1;
    // GDI+ 的文件加载器对某些合法 24bpp BMP 会拒收（CI diag=4 实锤）；先用 GDI 读
    // （NSIS 显示同一批瓦片已证明 GDI 能读），再包成 GDI+ 位图。

    g_strLen[0] = appName ? (DWORD)wcslen(appName) : 0xFFFFFFFFu;
    g_strLen[1] = headline ? (DWORD)wcslen(headline) : 0xFFFFFFFFu;
    g_strLen[2] = preparing ? (DWORD)wcslen(preparing) : 0xFFFFFFFFu;
    g_strLen[3] = tile ? (DWORD)wcslen(tile) : 0xFFFFFFFFu;
    g_diagPathLen = g_strLen[3];
    g_diagGLE = GetLastError(); g_diagPathLen = g_strLen[3];
    g_diagAttrs = GetFileAttributesW(tile);
    HBITMAP loaded = static_cast<HBITMAP>(LoadImageW(nullptr, tile, IMAGE_BITMAP, 0, 0, LR_LOADFROMFILE));
    g_diagGLE = GetLastError();
    page->tile = loaded ? static_cast<Image*>(new Bitmap(loaded, static_cast<HPALETTE>(nullptr))) : nullptr;   // Bitmap(HBITMAP) 内部拷贝
    if (loaded) DeleteObject(loaded);
    if (!page->tile || page->tile->GetLastStatus() != Ok) {
        g_diagStage = 4; delete page->tile; GdiplusShutdown(page->gdiplus); delete page; return nullptr;
    }

    const WCHAR* captions[] = {preparing, copying, registering, cleaning};
    for (int i = 0; i < 4; ++i) lstrcpynW(page->captions[i], captions[i], 128);
    lstrcpynW(page->appName, appName ? appName : L"", 96);
    lstrcpynW(page->headline, headline ? headline : L"", 96);
    lstrcpynW(page->cancel, cancel ? cancel : L"", 64);
    HWND window = CreateWindowExW(0, type.lpszClassName, L"", WS_CHILD | WS_VISIBLE,
        0, 0, MulDiv(600, dpi, 96), MulDiv(600, dpi, 96), parent, nullptr, module, page);
    if (!window) { g_diagStage = 5; delete page->tile; GdiplusShutdown(page->gdiplus); delete page; return nullptr; }
    g_diagStage = 0;
    return window;
}

// 失败阶段诊断：NSIS 侧在 ShowProgress 返回空时调用并写进 trace。
// 打包：stage<<20 | (GLE & 0xFFF) << 8 | (路径长度 & 0xFF)；attrs 单独用 InstallerDiagEx。
extern "C" __declspec(dllexport) int __cdecl InstallerDiag() {
    return (g_diagStage << 20) | ((g_diagGLE & 0xFFF) << 8) | (g_diagPathLen & 0xFF);
}
extern "C" __declspec(dllexport) DWORD __cdecl InstallerDiagAttrs() { return g_diagAttrs; }
extern "C" __declspec(dllexport) DWORD __cdecl InstallerDiagStr(int index) {
    return (index >= 0 && index < 4) ? g_strLen[index] : 0xDEADBEEF;
}

// 枚举进程：返回 exe 路径位于 prefix（带尾反斜杠）之下的进程数；terminate=true 时逐个结束。
// 按进程名杀杀不全（launcher.exe 只是壳父进程，bun.exe/WebView2 等同样占文件），只能按路径。
static int EnumProcessesUnderPath(const WCHAR* prefix, bool terminate) {
    if (!prefix || !*prefix) return -1;
    const size_t prefixLen = wcslen(prefix);
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snap == INVALID_HANDLE_VALUE) return -1;
    int hits = 0;
    PROCESSENTRY32W entry = {};
    entry.dwSize = sizeof(entry);
    if (Process32FirstW(snap, &entry)) {
        do {
            HANDLE process = OpenProcess(PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, entry.th32ProcessID);
            if (!process) continue;
            WCHAR path[1024];
            DWORD size = 1024;
            if (QueryFullProcessImageNameW(process, 0, path, &size) &&
                _wcsnicmp(path, prefix, prefixLen) == 0 &&
                (path[prefixLen] == L'\\' || path[prefixLen] == L'\0')) {   // 目录边界：C:\\pkg 不误杀 C:\\pkg2
                if (!terminate || TerminateProcess(process, 0)) ++hits;
            }
            CloseHandle(process);
        } while (Process32NextW(snap, &entry));
    }
    CloseHandle(snap);
    return hits;
}

extern "C" __declspec(dllexport) int __cdecl InstallerFindUnderPath(const WCHAR* prefix) {
    return EnumProcessesUnderPath(prefix, false);
}

extern "C" __declspec(dllexport) int __cdecl InstallerTerminateUnderPath(const WCHAR* prefix) {
    return EnumProcessesUnderPath(prefix, true);
}


// NSIS 已报告成功。抽动 UI 泵 750ms 播完 100% 动画再进完成页。
extern "C" __declspec(dllexport) BOOL __cdecl InstallerFinishProgress(HWND window) {
    auto* page = reinterpret_cast<ProgressPage*>(GetWindowLongPtrW(window, GWLP_USERDATA));
    if (!page) return FALSE;
    const ULONGLONG started = GetTickCount64();
    page->progress.Complete(started);
    while (IsWindow(window) && GetTickCount64() - started < 750) {
        MSG message;
        if (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) {
            if (message.message == WM_QUIT) { PostQuitMessage(static_cast<int>(message.wParam)); return FALSE; }
            TranslateMessage(&message);
            DispatchMessageW(&message);
        } else {
            MsgWaitForMultipleObjectsEx(0, nullptr, 16, QS_ALLINPUT, MWMO_INPUTAVAILABLE);
        }
    }
    if (!IsWindow(window)) return FALSE;
    InvalidateRect(window, nullptr, FALSE);
    UpdateWindow(window);
    return TRUE;
}

static LRESULT CALLBACK FrameProc(HWND window, UINT message, WPARAM wparam,
                                  LPARAM lparam, UINT_PTR id, DWORD_PTR) {
    if (message == WM_NCCALCSIZE && wparam) return 0;
    if (message == WM_NCHITTEST) {
        const LRESULT hit = DefSubclassProc(window, message, wparam, lparam);
        // 固定尺寸窗口；拖拽由页面内容自己处理。
        return hit >= HTLEFT && hit <= HTBOTTOMRIGHT ? HTCLIENT : hit;
    }
    if (message == WM_NCDESTROY) RemoveWindowSubclass(window, FrameProc, id);
    return DefSubclassProc(window, message, wparam, lparam);
}

extern "C" __declspec(dllexport) HRESULT __cdecl InstallerApplyFrame(HWND window) {
    // NSIS 可能在窗口收到 WM_NCDESTROY 前就释放 DLL 引用，先钉住模块。
    HMODULE module = nullptr;
    if (!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_PIN | GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS,
                            reinterpret_cast<LPCWSTR>(&FrameProc), &module)) return E_FAIL;
    if (!SetWindowSubclass(window, FrameProc, 1, 0)) return E_FAIL;
    // Windows 11 圆角；老系统自动忽略不支持的首选项。
    DWM_WINDOW_CORNER_PREFERENCE rounded = DWMWCP_ROUND;
    DwmSetWindowAttribute(window, 33, &rounded, sizeof(rounded));
    const MARGINS margins = {1, 1, 1, 1};
    const HRESULT result = DwmExtendFrameIntoClientArea(window, &margins);
    SetWindowPos(window, nullptr, 0, 0, 0, 0,
                 SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
    return result;
}
