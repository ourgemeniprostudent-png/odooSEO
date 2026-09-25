// کارنامه — native macOS shell: starts the local Python server and shows it in a WebKit window.
// Built on the user's Mac by install-mac.command with:  swiftc -O -o Karnama Karnama.swift

import Cocoa
import WebKit

let port = 8770
let baseURL = URL(string: "http://127.0.0.1:\(port)/")!
let jade = NSColor(red: 11 / 255, green: 143 / 255, blue: 107 / 255, alpha: 1)
let supportDir = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Application Support/Karnama")

final class AppDelegate: NSObject, NSApplicationDelegate, WKUIDelegate, WKNavigationDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var server: Process?

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()

        let config = WKWebViewConfiguration()
        config.websiteDataStore = WKWebsiteDataStore.default()
        webView = WKWebView(frame: .zero, configuration: config)
        webView.uiDelegate = self
        webView.navigationDelegate = self

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1100, height: 820),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false)
        window.title = "کارنامه"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.backgroundColor = jade
        window.minSize = NSSize(width: 420, height: 520)
        window.contentView = webView
        window.center()
        window.setFrameAutosaveName("KarnamaMainWindow")
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        webView.loadHTMLString(Self.page("در حال آماده‌سازی کارنامه…"), baseURL: nil)
        startServer()
        waitAndLoad(attempt: 0)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ notification: Notification) {
        server?.terminate()
    }

    // MARK: - local server

    func startServer() {
        let python = supportDir.appendingPathComponent("venv/bin/python").path
        guard FileManager.default.isExecutableFile(atPath: python),
              let resources = Bundle.main.resourcePath else { return }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: python)
        p.arguments = ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1",
                       "--port", String(port), "--log-level", "warning"]
        p.currentDirectoryURL = URL(fileURLWithPath: resources)
        var env = ProcessInfo.processInfo.environment
        env["KARNAMA_DATA"] = supportDir.appendingPathComponent("data").path
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        // Apps opened from Finder get a minimal PATH; ffmpeg usually lives in Homebrew.
        env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:" + (env["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin")
        p.environment = env
        let log = supportDir.appendingPathComponent("server.log")
        FileManager.default.createFile(atPath: log.path, contents: nil)
        if let handle = try? FileHandle(forWritingTo: log) {
            p.standardOutput = handle
            p.standardError = handle
        }
        do {
            try p.run()
            server = p
        } catch {
            NSLog("Karnama: could not start server: \(error)")
        }
    }

    func waitAndLoad(attempt: Int) {
        var request = URLRequest(url: baseURL.appendingPathComponent("api/settings"))
        request.timeoutInterval = 1
        URLSession.shared.dataTask(with: request) { _, response, _ in
            DispatchQueue.main.async {
                if let http = response as? HTTPURLResponse, http.statusCode == 200 {
                    self.webView.load(URLRequest(url: baseURL))
                } else if attempt < 120 {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
                        self.waitAndLoad(attempt: attempt + 1)
                    }
                } else {
                    self.webView.loadHTMLString(Self.page(
                        "برنامه اجرا نشد. یک بار دیگر install-mac.command را اجرا کنید.<br><small>جزئیات: ~/Library/Application Support/Karnama/server.log</small>"),
                        baseURL: nil)
                }
            }
        }.resume()
    }

    static func page(_ message: String) -> String {
        return """
        <html dir="rtl"><body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;
        background:#0b8f6b;color:#fff;font:17px -apple-system,Tahoma,sans-serif;text-align:center;line-height:2">
        <div>\(message)</div></body></html>
        """
    }

    // MARK: - web view permissions and dialogs

    // Microphone for voice typing: allowed only for our own local page.
    @available(macOS 12.0, *)
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(origin.host == "127.0.0.1" ? .grant : .deny)
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "باشه")
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "بله")
        alert.addButton(withTitle: "انصراف")
        alert.beginSheetModal(for: window) { response in
            completionHandler(response == .alertFirstButtonReturn)
        }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
                 defaultText: String?, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (String?) -> Void) {
        let alert = NSAlert()
        alert.messageText = prompt
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 260, height: 24))
        field.stringValue = defaultText ?? ""
        field.alignment = .right
        alert.accessoryView = field
        alert.addButton(withTitle: "تأیید")
        alert.addButton(withTitle: "انصراف")
        alert.window.initialFirstResponder = field
        alert.beginSheetModal(for: window) { response in
            completionHandler(response == .alertFirstButtonReturn ? field.stringValue : nil)
        }
    }

    // Links to other sites open in the default browser, not inside the app.
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = navigationAction.request.url,
           let scheme = url.scheme, scheme.hasPrefix("http"),
           url.host != "127.0.0.1" {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    // MARK: - menu (needed for ⌘C / ⌘V / ⌘Q inside the web view)

    func buildMenu() {
        let main = NSMenu()

        let appItem = NSMenuItem()
        let appMenu = NSMenu(title: "کارنامه")
        appMenu.addItem(withTitle: "درباره‌ی کارنامه",
                        action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "پنهان کردن کارنامه", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "خروج از کارنامه", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        main.addItem(appItem)

        let editItem = NSMenuItem()
        let edit = NSMenu(title: "ویرایش")
        edit.addItem(withTitle: "برگرداندن", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = edit.addItem(withTitle: "انجام دوباره", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(NSMenuItem.separator())
        edit.addItem(withTitle: "بریدن", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "کپی", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "چسباندن", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "انتخاب همه", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        main.addItem(editItem)

        let viewItem = NSMenuItem()
        let view = NSMenu(title: "نما")
        view.addItem(withTitle: "بارگذاری دوباره", action: #selector(reloadPage), keyEquivalent: "r")
        view.addItem(withTitle: "باز کردن در مرورگر", action: #selector(openInBrowser), keyEquivalent: "b")
        viewItem.submenu = view
        main.addItem(viewItem)

        let windowItem = NSMenuItem()
        let windowMenu = NSMenu(title: "پنجره")
        windowMenu.addItem(withTitle: "کوچک کردن", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "بستن", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windowItem.submenu = windowMenu
        main.addItem(windowItem)

        NSApp.mainMenu = main
    }

    @objc func reloadPage() { webView.reload() }

    @objc func openInBrowser() { NSWorkspace.shared.open(baseURL) }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
