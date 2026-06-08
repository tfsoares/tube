# Tube — Build System
#
# Usage:    make <target>
# Or:       mise run <target>   (if mise installed)
#
# Targets:
#   engine     Build the Bun-compiled proxy engine
#   app        Build the PerryTS native UI app
#   bundle     Package into .app bundle
#   all        Build everything (engine + app + bundle)
#   run        Build + open the app
#   clean      Remove build artifacts

APP_NAME    := Tube
APP_DIR     := app
ENGINE_DIR  := engine
DIST_DIR    := dist
BUNDLE_DIR  := $(DIST_DIR)/$(APP_NAME).app

.PHONY: all engine app bundle clean run install

all: engine app bundle

# ─── Engine (Bun — single binary) ───────────────────────────────────────────

engine:
	@echo "==> Building engine (Bun)..."
	cd $(ENGINE_DIR) && bun install && bun build --compile \
		--target=bun-darwin-arm64 \
		./src/index.ts \
		--outfile=../$(DIST_DIR)/tube-engine
	ln -sf tube-engine $(DIST_DIR)/tube
	@echo "==> Engine done: $(DIST_DIR)/tube-engine"
	ls -lh $(DIST_DIR)/tube-engine

# ─── App (PerryTS — native UI) ──────────────────────────────────────────────

app:
	@echo "==> Building app (PerryTS)..."
	cd $(APP_DIR) && npx @perryts/perry compile src/main.ts
	@echo "==> App done: $(APP_DIR)/main"
	ls -lh $(APP_DIR)/main

# ─── macOS .app Bundle ───────────────────────────────────────────────────────

bundle: engine app
	@echo "==> Creating .app bundle..."
	rm -rf "$(BUNDLE_DIR)"
	mkdir -p "$(BUNDLE_DIR)/Contents/MacOS"
	mkdir -p "$(BUNDLE_DIR)/Contents/Resources"
	cp $(APP_DIR)/main "$(BUNDLE_DIR)/Contents/MacOS/$(APP_NAME)"
	cp $(DIST_DIR)/tube-engine "$(BUNDLE_DIR)/Contents/Resources/"
	sed -e "s/__APP_NAME__/$(APP_NAME)/g" \
		-e "s/__BUNDLE_ID__/dev.tube.app/g" \
		app/src/Info.plist.in > "$(BUNDLE_DIR)/Contents/Info.plist"
	@echo "==> Bundle created: $(BUNDLE_DIR)"
	@echo "    Size: $$(du -sh $(BUNDLE_DIR) | cut -f1)"

# ─── Run ─────────────────────────────────────────────────────────────────────

run: bundle
	open "$(BUNDLE_DIR)"

# ─── Clean ───────────────────────────────────────────────────────────────────

clean:
	rm -rf $(DIST_DIR)
	rm -f $(APP_DIR)/main
	rm -rf $(APP_DIR)/dist
	rm -rf $(APP_DIR)/.perry-cache
	rm -rf $(ENGINE_DIR)/dist
	rm -rf $(ENGINE_DIR)/node_modules
	rm -f $(ENGINE_DIR)/bun.lock
