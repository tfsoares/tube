/**
 * Tube Menubar Helper — lightweight macOS menubar app.
 *
 * Shows a status icon in the menubar with quick actions.
 * Optional component — the PerryTS app works standalone.
 */

import Cocoa
import AppKit

// ─── Menubar App Delegate ───────────────────────────────────────────────────

class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var popover: NSPopover!
    private var statusVC: StatusViewController!

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(
            withLength: NSStatusItem.variableLength
        )

        if let button = statusItem.button {
            if #available(macOS 11.0, *) {
                button.image = NSImage(
                    systemSymbolName: "point.3.connected.trianglepath.dotted",
                    accessibilityDescription: "Tube"
                )
            } else {
                button.title = "📍"
            }
            button.action = #selector(togglePopover)
            button.target = self
        }

        popover = NSPopover()
        statusVC = StatusViewController()
        popover.contentViewController = statusVC
        popover.behavior = .transient

        Timer.scheduledTimer(withTimeInterval: 3.0, repeats: true) { [weak self] _ in
            self?.checkEngineStatus()
        }
    }

    @objc func togglePopover() {
        guard let button = statusItem.button else { return }
        if popover.isShown {
            popover.performClose(button)
        } else {
            popover.show(
                relativeTo: button.bounds,
                of: button,
                preferredEdge: .minY
            )
            popover.contentViewController?.view.window?.makeKey()
        }
    }

    func checkEngineStatus() {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let portFilePath = home.appendingPathComponent(".portless/api.port")

        guard let portData = try? String(contentsOf: portFilePath, encoding: .utf8),
              let port = Int(portData.trimmingCharacters(in: .whitespacesAndNewlines)) else {
            statusVC.updateStatus("Engine: not running")
            return
        }

        let url = URL(string: "http://127.0.0.1:\(port)/")!
        let task = URLSession.shared.dataTask(with: url) { [weak self] data, _, error in
            DispatchQueue.main.async {
                if error != nil {
                    self?.statusVC.updateStatus("Engine: disconnected")
                } else {
                    self?.statusVC.updateStatus("Engine: connected (port \(port))")
                }
            }
        }
        task.resume()
    }

    @objc func quitAction() {
        NSApplication.shared.terminate(nil)
    }
}

// ─── Status Popover ─────────────────────────────────────────────────────────

class StatusViewController: NSViewController {
    private let statusLabel = NSTextField(labelWithString: "Tube")
    private let routesLabel = NSTextField(labelWithString: "No active routes")
    private let openButton = NSButton(title: "Open Tube", target: nil, action: nil)
    private let quitButton = NSButton(title: "Quit", target: nil, action: nil)

    override func loadView() {
        let stack = NSStackView()
        stack.orientation = .vertical
        stack.spacing = 8
        stack.edgeInsets = NSEdgeInsets(top: 12, left: 12, bottom: 12, right: 12)

        statusLabel.font = NSFont.boldSystemFont(ofSize: 13)
        routesLabel.font = NSFont.systemFont(ofSize: 11)
        routesLabel.textColor = .secondaryLabelColor

        openButton.bezelStyle = .rounded
        openButton.action = #selector(openApp)
        openButton.target = self

        quitButton.bezelStyle = .rounded
        quitButton.action = #selector(quitApp)
        quitButton.target = self

        stack.addArrangedSubview(statusLabel)
        stack.addArrangedSubview(routesLabel)
        stack.addArrangedSubview(openButton)
        stack.addArrangedSubview(quitButton)

        view = stack
        view.frame.size = NSSize(width: 200, height: 140)
    }

    func updateStatus(_ text: String) {
        statusLabel.stringValue = text
    }

    @objc func openApp() {
        let bundlePath = Bundle.main.bundleURL
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let appPath = bundlePath.appendingPathComponent("MacOS/Tube")

        if FileManager.default.isExecutableFile(atPath: appPath.path) {
            NSWorkspace.shared.open(appPath)
        }
        if let popover = view.window?.value(forKey: "_popover") as? NSPopover {
            popover.performClose(nil)
        }
    }

    @objc func quitApp() {
        NSApplication.shared.terminate(nil)
    }
}

// ─── Entry Point ────────────────────────────────────────────────────────────

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory) // No dock icon, just menubar
app.run()
