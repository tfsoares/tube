package proxy

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// RouteInfo represents a registered backend route.
type RouteInfo struct {
	Hostname string `json:"hostname"`
	Port     int    `json:"port"`
	PID      int    `json:"pid"`
	LocalURL string `json:"localUrl"`
}

// RouteStore polls routes.json and provides lookups.
type RouteStore struct {
	mu       sync.RWMutex
	routes   []RouteInfo
	path     string
	tld      string
	stopCh   chan struct{}
	onChange func([]RouteInfo)
}

// NewRouteStore creates a store that polls the given routes file.
func NewRouteStore(routesPath, tld string) *RouteStore {
	return &RouteStore{
		path:   routesPath,
		tld:    tld,
		stopCh: make(chan struct{}),
	}
}

// SetOnChange sets a callback that fires when routes change.
func (s *RouteStore) SetOnChange(fn func([]RouteInfo)) {
	s.onChange = fn
}

// Start begins polling the routes file every 3 seconds.
func (s *RouteStore) Start() {
	s.poll()
	go func() {
		ticker := time.NewTicker(3 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				s.poll()
			case <-s.stopCh:
				return
			}
		}
	}()
}

// Stop stops polling.
func (s *RouteStore) Stop() {
	close(s.stopCh)
}

// FindRoute looks up a route by hostname with TLD enforcement.
func (s *RouteStore) FindRoute(host string) *RouteInfo {
	s.mu.RLock()
	defer s.mu.RUnlock()

	if host != s.tld && !strings.HasSuffix(host, "."+s.tld) {
		return nil
	}

	for i := range s.routes {
		if s.routes[i].Hostname == host {
			return &s.routes[i]
		}
	}
	return nil
}

// All returns all active routes.
func (s *RouteStore) All() []RouteInfo {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]RouteInfo, len(s.routes))
	copy(out, s.routes)
	for i := range out {
		out[i].LocalURL = "https://" + out[i].Hostname
		out[i].PID = 0
	}
	return out
}

// RouteFilePath returns the default routes.json path.
func RouteFilePath() string {
	home, _ := os.UserHomeDir()
	dir := os.Getenv("TUBE_STATE_DIR")
	if dir == "" {
		dir = filepath.Join(home, ".tube")
	}
	return filepath.Join(dir, "routes.json")
}

// StateDirPath returns the default state directory path.
func StateDirPath() string {
	home, _ := os.UserHomeDir()
	dir := os.Getenv("TUBE_STATE_DIR")
	if dir == "" {
		dir = filepath.Join(home, ".tube")
	}
	return dir
}

// RouteEntry is the raw on-disk route format (with PID).
type RouteEntry struct {
	Hostname string `json:"hostname"`
	Port     int    `json:"port"`
	PID      int    `json:"pid"`
}

// ReadRouteFile reads all routes from routes.json.
func ReadRouteFile(path string) ([]RouteEntry, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var routes []RouteEntry
	if err := json.Unmarshal(data, &routes); err != nil {
		return nil, err
	}
	return routes, nil
}

// WriteRouteFile writes routes to routes.json, ensuring the parent dir exists.
func WriteRouteFile(path string, routes []RouteEntry) error {
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(routes, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0644)
}

// RegisterRoute adds or updates a route entry, removing any existing entry
// with the same hostname. Returns the PID of the replaced entry if any.
func RegisterRoute(path, hostname string, port, pid int) (int, error) {
	routes, err := ReadRouteFile(path)
	if err != nil {
		return 0, err
	}

	var oldPID int
	filtered := make([]RouteEntry, 0, len(routes))
	for _, r := range routes {
		if r.Hostname == hostname {
			oldPID = r.PID
		} else {
			filtered = append(filtered, r)
		}
	}

	filtered = append(filtered, RouteEntry{
		Hostname: hostname,
		Port:     port,
		PID:      pid,
	})

	return oldPID, WriteRouteFile(path, filtered)
}

// UnregisterRoute removes a route entry by hostname.
func UnregisterRoute(path, hostname string) error {
	routes, err := ReadRouteFile(path)
	if err != nil {
		return err
	}

	filtered := make([]RouteEntry, 0, len(routes))
	for _, r := range routes {
		if r.Hostname != hostname {
			filtered = append(filtered, r)
		}
	}

	return WriteRouteFile(path, filtered)
}

func (s *RouteStore) poll() {
	data, err := os.ReadFile(s.path)
	if err != nil {
		return
	}

	var parsed []struct {
		Hostname string `json:"hostname"`
		Port     int    `json:"port"`
	}

	if err := json.Unmarshal(data, &parsed); err != nil {
		return
	}

	routes := make([]RouteInfo, 0, len(parsed))
	for _, r := range parsed {
		if r.Hostname != "" && r.Port > 0 {
			routes = append(routes, RouteInfo{
				Hostname: r.Hostname,
				Port:     r.Port,
				LocalURL: "https://" + r.Hostname,
			})
		}
	}

	s.mu.Lock()
	s.routes = routes
	s.mu.Unlock()

	if s.onChange != nil {
		s.onChange(routes)
	}
}
