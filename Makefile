# Tube — Build System
#
# Usage:    make <target>
#
# Targets:
#   wails-dev    Run in dev mode (hot reload)
#   wails-build  Build native .app bundle (Wails 2 + Go)
#   wails-release Build optimized release .app
#   engine        Build the Bun-compiled proxy engine (legacy)
#   app           Build the PerryTS native UI app (legacy)
#   bundle        Package into .app bundle (legacy)
#   all           Build everything (Wails recommended)
#   clean         Remove build artifacts

APP_NAME    := Tube
DIST_DIR    := dist
BUNDLE_DIR  := $(DIST_DIR)/$(APP_NAME).app

.PHONY: all wails-dev wails-build wails-release engine app bundle clean run install cli

# ─── Wails 2 + Go (primary) ──────────────────────────────────────────────────

all: wails-build

wails-dev:
	@echo "==> Running Tube in dev mode (Wails)…"
	wails dev

wails-build:
	@echo "==> Building Tube.app (Wails + Go)…"
	wails build -o "$(BUNDLE_DIR)/Contents/MacOS/$(APP_NAME)" -platform darwin/arm64
	@echo "==> Bundle created: $(BUNDLE_DIR)"
	@du -sh "$(BUNDLE_DIR)"

wails-release:
	@echo "==> Building Tube.app release (optimised)…"
	wails build -platform darwin/arm64 -clean -ldflags="-s -w"

# ─── CLI (Go — single binary) ────────────────────────────────────────────────

cli:
	@echo "==> Building tube CLI (Go)..."
	go build -ldflags="-s -w" -o dist/tube ./cmd/tube
	@echo "==> CLI done: dist/tube"
	ls -lh dist/tube

install: cli
	@echo "==> Installing tube CLI to ~/.local/bin..."
	mkdir -p ~/.local/bin
	cp dist/tube ~/.local/bin/tube
	chmod +x ~/.local/bin/tube
	@echo "Installed to ~/.local/bin/tube"

# ─── Engine (Bun — legacy) ───────────────────────────────────────────────────

engine:
	@echo "==> Building engine (Bun)..."
	cd engine && bun install && bun build --compile \
		--target=bun-darwin-arm64 \
		./src/index.ts \
		--outfile=../$(DIST_DIR)/tube-engine
	ln -sf tube-engine $(DIST_DIR)/tube
	@echo "==> Engine done: $(DIST_DIR)/tube-engine"
	ls -lh $(DIST_DIR)/tube-engine

# ─── App (PerryTS — legacy) ──────────────────────────────────────────────────

app:
	@echo "==> Building app (PerryTS)..."
	cd app && npx @perryts/perry compile src/main.ts
	@echo "==> App done: app/main"
	ls -lh app/main

# ─── macOS .app Bundle (legacy) ─────────────────────────────────────────────

bundle: engine app
	@echo "==> Creating .app bundle..."
	rm -rf "$(BUNDLE_DIR)"
	mkdir -p "$(BUNDLE_DIR)/Contents/MacOS"
	mkdir -p "$(BUNDLE_DIR)/Contents/Resources"
	cp app/main "$(BUNDLE_DIR)/Contents/MacOS/$(APP_NAME)"
	cp $(DIST_DIR)/tube-engine "$(BUNDLE_DIR)/Contents/Resources/"
	sed -e "s/__APP_NAME__/$(APP_NAME)/g" \
		-e "s/__BUNDLE_ID__/dev.tube.app/g" \
		app/src/Info.plist.in > "$(BUNDLE_DIR)/Contents/Info.plist"
	@echo "==> Bundle created: $(BUNDLE_DIR)"
	@du -sh "$(BUNDLE_DIR)"

# ─── Run ─────────────────────────────────────────────────────────────────────

run: wails-build
	open "$(BUNDLE_DIR)"

# ─── Clean ───────────────────────────────────────────────────────────────────

clean:
	rm -rf $(DIST_DIR)
	rm -rf build
	rm -f $(APP_NAME)
