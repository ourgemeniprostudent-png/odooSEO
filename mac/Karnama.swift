// کارنامه — native macOS shell that lives at the camera notch.
// A small plain jade button in the menu bar opens the panel, which drops down out of the notch;
// the ⌃ button in the page (or the menu bar button again) slides it back up into the notch.
// Also starts the local Python server.
// Built on the user's Mac by install-mac.command with:  swiftc -O -o Karnama Karnama.swift

import Cocoa
import WebKit

let port = 8770
let baseURL = URL(string: "http://127.0.0.1:\(port)/")!
let jade = NSColor(red: 11 / 255, green: 143 / 255, blue: 107 / 255, alpha: 1)
// Above the menu bar and its status items, so clicks beside the notch reach us.
let panelLevel = NSWindow.Level(rawValue: NSWindow.Level.mainMenu.rawValue + 3)
let supportDir = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Application Support/Karnama")

/// Short diagnostic log (~/Library/Application Support/Karnama/app.log), rewritten each launch.
let appLog = supportDir.appendingPathComponent("app.log")
func diag(_ line: String) {
    let stamp = ISO8601DateFormatter().string(from: Date())
    guard let data = "\(stamp) \(line)\n".data(using: .utf8) else { return }
    if let handle = try? FileHandle(forWritingTo: appLog) {
        handle.seekToEndOfFile()
        handle.write(data)
        handle.closeFile()
    }
}

// Borderless panels refuse keyboard focus by default; the text box needs it.
final class NotchPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
    // macOS pushes windows below the menu bar by default; we need to sit in the notch row.
    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect { frameRect }
}

// A view whose clicks fall through to a handler (the whole collapsed strip is one button).
final class ClickView: NSView {
    var onClick: (() -> Void)?
    // Without this the first click on an inactive app only activates it and is swallowed.
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func mouseDown(with event: NSEvent) {
        diag("click: button view")
        onClick?()
    }
    override func resetCursorRects() { addCursorRect(bounds, cursor: .pointingHand) }
}

// Same for the page: react to the first click even when another app is in front.
final class FirstClickWebView: WKWebView {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKUIDelegate, WKNavigationDelegate, WKScriptMessageHandler {
    var panel: NotchPanel!
    var root: NSView!
    var topStrip: ClickView!
    var webView: WKWebView!
    var server: Process?
    var expanded = false
    var animating = false
    var lastToggle = Date.distantPast
    var statusItem: NSStatusItem!

    func applicationDidFinishLaunching(_ notification: Notification) {
        try? FileManager.default.createDirectory(at: supportDir, withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: appLog.path, contents: nil)
        let version = (try? String(contentsOfFile: (Bundle.main.resourcePath ?? "") + "/VERSION", encoding: .utf8)) ?? "?"
        let screen = targetScreen()
        diag("launch version=\(version.trimmingCharacters(in: .whitespacesAndNewlines).prefix(7)) screen=\(screen.frame) notch=\(notchSize(screen)) notchFrame=\(notchFrame())")
        buildMenu()
        buildStatusItem()
        buildPanel()
        startServer()
        webView.loadHTMLString(Self.page("در حال آماده‌سازی کارنامه…"), baseURL: nil)
        waitAndLoad(attempt: 0)
        NotificationCenter.default.addObserver(
            self, selector: #selector(screensChanged),
            name: NSApplication.didChangeScreenParametersNotification, object: nil)
        // Opening the app opens the panel.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { self.setExpanded(true) }
    }

    // Clicking the Dock icon toggles the panel.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        setExpanded(!expanded)
        return false
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationWillTerminate(_ notification: Notification) {
        server?.terminate()
    }

    // MARK: - notch geometry

    /// The built-in screen with the notch if there is one, otherwise the main screen.
    func targetScreen() -> NSScreen {
        if #available(macOS 12.0, *) {
            if let notched = NSScreen.screens.first(where: { $0.safeAreaInsets.top > 0 }) {
                return notched
            }
        }
        return NSScreen.main ?? NSScreen.screens[0]
    }

    /// Height of the notch (or menu bar) and width of the notch (0 when there is none).
    func notchSize(_ screen: NSScreen) -> (height: CGFloat, width: CGFloat) {
        if #available(macOS 12.0, *), screen.safeAreaInsets.top > 0 {
            var width: CGFloat = 200
            if let left = screen.auxiliaryTopLeftArea, let right = screen.auxiliaryTopRightArea {
                width = screen.frame.width - left.width - right.width
            }
            return (screen.safeAreaInsets.top, width)
        }
        let menuBar = screen.frame.maxY - screen.visibleFrame.maxY
        return (menuBar > 0 ? menuBar : 24, 0)
    }

    /// The notch itself: where the panel grows from and shrinks back into.
    func notchFrame() -> NSRect {
        let screen = targetScreen()
        let notch = notchSize(screen)
        let width = max(notch.width, 160)
        return NSRect(x: screen.frame.midX - width / 2, y: screen.frame.maxY - notch.height,
                      width: width, height: notch.height)
    }

    func expandedFrame() -> NSRect {
        let screen = targetScreen()
        let width = min(860, max(640, screen.frame.width * 0.55))
        let height = min(820, screen.frame.height - 60)
        return NSRect(x: screen.frame.midX - width / 2, y: screen.frame.maxY - height,
                      width: width, height: height)
    }

    // MARK: - panel

    func buildPanel() {
        let frame = notchFrame()
        panel = NotchPanel(contentRect: frame, styleMask: [.borderless], backing: .buffered, defer: false)
        panel.level = panelLevel
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary]
        panel.isFloatingPanel = true
        panel.hidesOnDeactivate = false
        panel.isMovable = false
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = true
        panel.orderOut(nil)

        root = NSView(frame: NSRect(origin: .zero, size: frame.size))
        root.wantsLayer = true
        root.layer?.masksToBounds = true
        panel.contentView = root

        // Click target: the whole button while collapsed, the black band under the notch when open.
        topStrip = ClickView(frame: root.bounds)
        topStrip.autoresizingMask = [.width, .height]
        topStrip.toolTip = "کارنامه"
        topStrip.onClick = { [weak self] in
            guard let self = self else { return }
            self.toggleFromClick()
        }
        root.addSubview(topStrip)
        applyLook()

        // Web content (hidden while collapsed).
        let config = WKWebViewConfiguration()
        config.websiteDataStore = WKWebsiteDataStore.default()
        // The page's own ⌃ button asks the app to collapse through this channel.
        config.userContentController.add(self, name: "karnama")
        webView = FirstClickWebView(frame: .zero, configuration: config)
        webView.uiDelegate = self
        webView.navigationDelegate = self
        webView.isHidden = true
        root.addSubview(webView)
    }

    /// Menu bar button: macOS always delivers clicks here (the notch row itself swallows them).
    func buildStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: 34)
        guard let button = statusItem.button else { return }
        let size = NSSize(width: 26, height: 14)
        let pill = NSImage(size: size, flipped: false) { rect in
            jade.setFill()
            NSBezierPath(roundedRect: rect, xRadius: rect.height / 2, yRadius: rect.height / 2).fill()
            return true
        }
        pill.isTemplate = false
        button.image = pill
        button.imagePosition = .imageOnly
        button.toolTip = "کارنامه"
        button.target = self
        button.action = #selector(statusClicked)
    }

    @objc func statusClicked() {
        diag("click: menu bar button")
        toggleFromClick()
    }

    /// Black panel growing out of the notch, rounded at the bottom.
    func applyLook() {
        guard let layer = root.layer else { return }
        layer.backgroundColor = NSColor.black.cgColor
        layer.cornerRadius = 22
        layer.maskedCorners = [.layerMinXMinYCorner, .layerMaxXMinYCorner]
    }

    func layoutContent() {
        let size = root.bounds.size
        let strip = notchSize(targetScreen()).height
        topStrip.autoresizingMask = [.width, .minYMargin]
        topStrip.frame = NSRect(x: 0, y: size.height - strip, width: size.width, height: strip)
        // Page fills the panel edge to edge under the black notch band; the root clips the bottom corners.
        webView.frame = NSRect(x: 0, y: 0, width: size.width, height: max(0, size.height - strip))
    }

    @objc func collapse() { setExpanded(false) }

    /// One click = one toggle, whichever of the click paths below saw it first.
    func toggleFromClick() {
        guard Date().timeIntervalSince(lastToggle) > 0.4 else { return }
        lastToggle = Date()
        setExpanded(!expanded)
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if let command = message.body as? String, command == "collapse" { setExpanded(false) }
    }

    func setExpanded(_ open: Bool) {
        guard !animating, open != expanded else {
            diag("toggle ignored open=\(open) expanded=\(expanded) animating=\(animating)")
            return
        }
        diag(open ? "expand" : "collapse")
        animating = true
        expanded = open
        // Never stay locked if an animation's completion is skipped.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.animating = false }
        let target = open ? expandedFrame() : notchFrame()
        webView.isHidden = true
        topStrip.autoresizingMask = [.width, .height]
        topStrip.frame = root.bounds
        if open {
            // Start as the notch and drop down from it.
            panel.setFrame(notchFrame(), display: false)
            panel.orderFrontRegardless()
            NSApp.activate(ignoringOtherApps: true)
        }
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = 0.28
            context.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            panel.animator().setFrame(target, display: true)
        }, completionHandler: {
            self.animating = false
            if self.expanded {
                self.layoutContent()
                self.webView.isHidden = false
                self.panel.makeKeyAndOrderFront(nil)
                self.panel.makeFirstResponder(self.webView)
                self.webView.evaluateJavaScript("document.getElementById('text') && document.getElementById('text').focus()",
                                                completionHandler: nil)
            } else {
                self.panel.orderOut(nil)
            }
        })
    }

    @objc func screensChanged() {
        guard expanded else { return }
        panel.setFrame(expandedFrame(), display: true)
        layoutContent()
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
                    self.webView.load(URLRequest(url: URL(string: "?shell=notch", relativeTo: baseURL)!))
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
        background:#0b8f6b;color:#fff;font:15px -apple-system,Tahoma,sans-serif;text-align:center;line-height:2">
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

    /// Alerts are normal windows; drop the panel below them while one is showing.
    func runAlert(_ alert: NSAlert) -> NSApplication.ModalResponse {
        panel.level = .floating
        NSApp.activate(ignoringOtherApps: true)
        let response = alert.runModal()
        panel.level = panelLevel
        panel.makeKeyAndOrderFront(nil)
        return response
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "باشه")
        _ = runAlert(alert)
        completionHandler()
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "بله")
        alert.addButton(withTitle: "انصراف")
        completionHandler(runAlert(alert) == .alertFirstButtonReturn)
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
        let response = runAlert(alert)
        completionHandler(response == .alertFirstButtonReturn ? field.stringValue : nil)
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
        view.addItem(withTitle: "باز / جمع کردن", action: #selector(togglePanel), keyEquivalent: "k")
        view.addItem(withTitle: "بارگذاری دوباره", action: #selector(reloadPage), keyEquivalent: "r")
        view.addItem(withTitle: "باز کردن در مرورگر", action: #selector(openInBrowser), keyEquivalent: "b")
        viewItem.submenu = view
        main.addItem(viewItem)

        NSApp.mainMenu = main
    }

    @objc func togglePanel() { setExpanded(!expanded) }

    @objc func reloadPage() { webView.reload() }

    @objc func openInBrowser() { NSWorkspace.shared.open(baseURL) }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
